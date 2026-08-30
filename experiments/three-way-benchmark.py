#!/usr/bin/env python3
"""Controlled three-way benchmark for Branchpoint.

Compares the same three strategy tests under:

1. branchpoint: explore once, snapshot, then continue N branches.
2. sequential: one sandbox, run all N complete agent trajectories in sequence.
3. fanout: N sandboxes, run N complete agent trajectories in parallel.

Each condition receives a fresh random cache nonce. This invalidates provider
prompt cache entries from every previous condition/trial while still allowing
cache reuse that naturally occurs *inside* that condition. The OpenRouter
request enables Anthropic ephemeral prompt caching and records the normalized
cache-read/cache-write fields plus the provider's actual upstream cost.

The task-ready fixture snapshot is created once and excluded from condition
metrics. Per-condition wall time includes devbox provisioning, agent execution,
snapshots/resets required by the method, verification, and shutdown. Aggregate
sandbox time is the sum of each condition devbox's create-to-shutdown duration.
"""

from __future__ import annotations

import copy
import json
import os
import statistics
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "experiments"))

import branch_race as br  # noqa: E402


TRIALS = int(os.environ.get("TRIALS", "2"))
START_TRIAL = int(os.environ.get("START_TRIAL", "1"))
RESULT = ROOT / "experiments" / "three-way-benchmark-result.json"
RAW_RESULT = ROOT / ".tmp" / "branchpoint-pitch-deck" / "three-way-benchmark-raw.json"


def zero_usage():
    return {
        "requests": 0,
        "byok_requests": 0,
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "cached_tokens": 0,
        "cache_write_tokens": 0,
        "openrouter_billed_cost_usd": 0.0,
        "upstream_cost_usd": 0.0,
        "upstream_prompt_cost_usd": 0.0,
        "upstream_completion_cost_usd": 0.0,
        "effective_llm_cost_usd": 0.0,
        "no_cache_equivalent_usd": 0.0,
    }


def add_usage(*items):
    out = zero_usage()
    for item in items:
        for key in out:
            out[key] += item.get(key, 0)
    return out


def usage_from_response(resp):
    raw = resp.get("usage") or {}
    prompt_details = raw.get("prompt_tokens_details") or {}
    cost_details = raw.get("cost_details") or {}
    prompt = int(raw.get("prompt_tokens", 0) or 0)
    completion = int(raw.get("completion_tokens", 0) or 0)
    cached = int(prompt_details.get("cached_tokens", 0) or 0)
    cache_write = int(prompt_details.get("cache_write_tokens", 0) or 0)
    billed = float(raw.get("cost", 0) or 0)
    upstream = float(cost_details.get("upstream_inference_cost", 0) or 0)
    # This account is BYOK: OpenRouter bills $0 while reporting the Anthropic
    # upstream inference cost. Prefer the billed value for non-BYOK requests.
    effective = upstream if raw.get("is_byok") else billed
    if not effective:
        regular = max(0, prompt - cached - cache_write)
        effective = (
            regular * 2.0e-6
            + cached * 0.2e-6
            + cache_write * 2.5e-6
            + completion * 10.0e-6
        )
    return {
        "requests": 1,
        "byok_requests": 1 if raw.get("is_byok") else 0,
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": int(raw.get("total_tokens", prompt + completion) or prompt + completion),
        "cached_tokens": cached,
        "cache_write_tokens": cache_write,
        "openrouter_billed_cost_usd": billed,
        "upstream_cost_usd": upstream,
        "upstream_prompt_cost_usd": float(cost_details.get("upstream_inference_prompt_cost", 0) or 0),
        "upstream_completion_cost_usd": float(cost_details.get("upstream_inference_completions_cost", 0) or 0),
        "effective_llm_cost_usd": effective,
        "no_cache_equivalent_usd": prompt * 2.0e-6 + completion * 10.0e-6,
    }


def llm_cached(messages, session_id):
    """Same model/tools/temperature as branch_race, with cache explicitly on."""
    body = {
        "model": br.MODEL,
        "messages": messages,
        "tools": br.TOOLS,
        "temperature": 0.7,
        "cache_control": {"type": "ephemeral"},
        "session_id": session_id,
    }
    req = br.urllib.request.Request(
        br.OR_API,
        data=json.dumps(body).encode(),
        method="POST",
        headers={
            "Authorization": f"Bearer {br.OR_KEY}",
            "Content-Type": "application/json",
            "X-OpenRouter-Cache": "false",
        },
    )
    for attempt in range(3):
        try:
            with br.urllib.request.urlopen(req, timeout=180) as response:
                return json.loads(response.read())
        except br.urllib.error.HTTPError as exc:
            if attempt == 2:
                raise RuntimeError(
                    f"OpenRouter {exc.code}: {exc.read().decode()[:300]}"
                ) from None
            time.sleep(3)


def run_agent_metered(dbid, messages, max_turns, tag, session_id):
    total = zero_usage()
    calls = []
    for _ in range(max_turns):
        started = time.time()
        response = llm_cached(messages, session_id)
        measured = usage_from_response(response)
        total = add_usage(total, measured)
        calls.append({
            "generation_id": response.get("id"),
            "seconds": round(time.time() - started, 3),
            "provider": response.get("provider"),
            "model": response.get("model"),
            "usage": measured,
        })

        message = response["choices"][0]["message"]
        messages.append(message)
        tool_calls = message.get("tool_calls") or []
        if not tool_calls:
            break
        for call in tool_calls:
            args = json.loads(call["function"]["arguments"] or "{}")
            result = br.exec_tool(dbid, call["function"]["name"], args)
            print(f"    {tag} · {call['function']['name']}", flush=True)
            messages.append({
                "role": "tool",
                "tool_call_id": call["id"],
                "content": result,
            })
    return messages, total, calls


def wait_snapshot(snapshot_id):
    for _ in range(180):
        status = br.rl("GET", f"/devboxes/disk_snapshots/{snapshot_id}/status").get("status")
        if status in ("complete", "completed", "ready", None):
            return
        if status in ("error", "failure"):
            raise RuntimeError(f"snapshot {snapshot_id}: {status}")
        time.sleep(2)
    raise TimeoutError(snapshot_id)


class SandboxMeter:
    def __init__(self):
        self.lock = threading.Lock()
        self.leases = {}
        self.peak = 0
        self.active = 0

    def create(self, snapshot_id, name):
        started = time.time()
        db = br.rl("POST", "/devboxes", {"name": name, "snapshot_id": snapshot_id})
        dbid = db["id"]
        with self.lock:
            self.leases[dbid] = {
                "name": name,
                "started_at_epoch": started,
                "boot_seconds": None,
                "ended_at_epoch": None,
                "sandbox_seconds": None,
                "runloop_usage": None,
            }
            self.active += 1
            self.peak = max(self.peak, self.active)
        br.wait_running(dbid)
        with self.lock:
            self.leases[dbid]["boot_seconds"] = round(time.time() - started, 3)
        return dbid

    def shutdown(self, dbid):
        try:
            br.rl("POST", f"/devboxes/{dbid}/shutdown", {})
        finally:
            ended = time.time()
            with self.lock:
                lease = self.leases[dbid]
                lease["ended_at_epoch"] = ended
                lease["sandbox_seconds"] = round(ended - lease["started_at_epoch"], 3)
                self.active -= 1
        for _ in range(60):
            try:
                if br.rl("GET", f"/devboxes/{dbid}").get("status") in (
                    "shutdown", "failure", "failed"
                ):
                    break
            except Exception:
                pass
            time.sleep(1)
        # Runloop's resource-usage endpoint is the source of truth for active
        # sandbox time. It can lag shutdown briefly.
        usage = None
        for _ in range(30):
            try:
                usage = br.rl("GET", f"/devboxes/{dbid}/usage")
                if usage:
                    break
            except Exception:
                pass
            time.sleep(1)
        with self.lock:
            self.leases[dbid]["runloop_usage"] = usage

    def cleanup(self):
        with self.lock:
            open_ids = [dbid for dbid, lease in self.leases.items() if lease["ended_at_epoch"] is None]
        for dbid in open_ids:
            try:
                self.shutdown(dbid)
            except Exception as exc:
                print(f"cleanup failed for {dbid}: {exc}", flush=True)

    def summary(self):
        leases = list(self.leases.values())
        resource = [lease.get("runloop_usage") or {} for lease in leases]
        def resource_sum(key):
            return round(sum(float(item.get(key, 0) or 0) for item in resource), 3)
        active = resource_sum("total_active_seconds")
        elapsed = resource_sum("total_elapsed_seconds")
        vcpu = resource_sum("vcpu_seconds")
        memory = resource_sum("memory_gb_seconds")
        disk = resource_sum("disk_gb_seconds")
        return {
            "devboxes_created": len(leases),
            "peak_concurrent_devboxes": self.peak,
            "aggregate_active_sandbox_seconds": active,
            "aggregate_elapsed_sandbox_seconds": elapsed,
            "aggregate_vcpu_seconds": vcpu,
            "aggregate_memory_gb_seconds": memory,
            "aggregate_disk_gb_seconds": disk,
            "estimated_runloop_usage_cost_usd": round(
                vcpu * 0.00003 + memory * 0.000007 + disk * 0.0000000951, 6
            ),
            "client_observed_aggregate_sandbox_seconds": round(
                sum(x["sandbox_seconds"] or 0 for x in leases), 3
            ),
            "leases": leases,
        }


def initial_messages(cache_nonce):
    return [
        {
            "role": "system",
            "content": (
                "너는 시니어 파이썬 엔지니어다. /home/user/work 에서 작업한다. "
                "도구로 파일을 읽고 쓰고 명령을 실행할 수 있다. 간결하게 행동해라. "
                f"BENCHMARK_CACHE_NONCE={cache_nonce}"
            ),
        },
        {
            "role": "user",
            "content": (
                "duration.py 와 test_duration.py 를 읽고 pytest 를 한 번 실행해서 "
                "무엇이 왜 실패하는지 파악해라. **아직 코드를 고치지는 마라.** "
                "파악이 끝나면 실패 원인을 짧게 요약해라."
            ),
        },
    ]


def strategy_prompt(hint):
    return {
        "role": "user",
        "content": f"{hint}\n\n이제 duration.py 를 고치고 pytest 로 검증해라. 전부 통과할 때까지 반복해라.",
    }


def reset_task(dbid):
    for path, content in (
        (f"{br.WORK}/duration.py", br.BUGGY),
        (f"{br.WORK}/test_duration.py", br.TESTS),
    ):
        br.exec_tool(dbid, "write_file", {"path": path, "content": content})


def verify(dbid):
    passed, total, result = br.pytest_score(dbid)
    return {"passed": passed, "total": total, "result": result}


def run_complete_trajectory(dbid, cache_nonce, item, tag):
    label, hint = item
    started = time.time()
    messages, prefix_usage, prefix_calls = run_agent_metered(
        dbid, initial_messages(cache_nonce), 6, f"{tag}-prefix", cache_nonce
    )
    messages.append(strategy_prompt(hint))
    messages, suffix_usage, suffix_calls = run_agent_metered(
        dbid, messages, 12, f"{tag}-suffix", cache_nonce
    )
    verification = verify(dbid)
    return {
        "label": label,
        "seconds": round(time.time() - started, 3),
        "usage": add_usage(prefix_usage, suffix_usage),
        "prefix_usage": prefix_usage,
        "suffix_usage": suffix_usage,
        "calls": prefix_calls + suffix_calls,
        "verification": verification,
        "verdict_at_perf": time.perf_counter(),
    }


def finalize_condition(method, nonce, started, meter, branches, extra=None):
    usage = add_usage(*(b["usage"] for b in branches))
    sandbox = meter.summary()
    verdict_times = [b.get("verdict_at_perf") for b in branches if b.get("verdict_at_perf")]
    wall_to_verdict = max(verdict_times) - started if verdict_times else time.perf_counter() - started
    out = {
        "method": method,
        "cache_nonce": nonce,
        "wall_seconds": round(wall_to_verdict, 3),
        "wall_to_verdict_seconds": round(wall_to_verdict, 3),
        "wall_to_terminal_seconds": round(time.perf_counter() - started, 3),
        **sandbox,
        "usage": usage,
        "cache_read_ratio_pct": round(100 * usage["cached_tokens"] / usage["prompt_tokens"], 2)
        if usage["prompt_tokens"] else 0,
        "all_tests_passed": all(
            b["verification"]["passed"] == b["verification"]["total"] == 8
            for b in branches
        ),
        "branches": branches,
    }
    if extra:
        out.update(extra)
    return out


def condition_branchpoint(fixture_snapshot, trial):
    method = "branchpoint_shared_prefix"
    nonce = f"{method}-{trial}-{uuid.uuid4().hex}"
    meter = SandboxMeter()
    started = time.perf_counter()
    prefix_db = None
    try:
        prefix_db = meter.create(fixture_snapshot, f"3way-{trial}-branchpoint-prefix")
        prefix_started = time.time()
        shared_messages, prefix_usage, prefix_calls = run_agent_metered(
            prefix_db, initial_messages(nonce), 6, f"t{trial}-branchpoint-prefix", nonce
        )
        prefix_seconds = time.time() - prefix_started
        snap_started = time.time()
        snapshot = br.rl(
            "POST",
            f"/devboxes/{prefix_db}/snapshot_disk",
            {"name": f"3way-{trial}-branchpoint-prefix"},
        )["id"]
        wait_snapshot(snapshot)
        snapshot_seconds = time.time() - snap_started
        # Keep the prefix devbox as the first branch and create only N-1 forks.
        # This is the resource-efficient implementation of the method: N test
        # paths use N devboxes, not N+1.
        def branch(index_and_item):
            index, item = index_and_item
            label, hint = item
            dbid = prefix_db if index == 0 else meter.create(
                snapshot, f"3way-{trial}-branchpoint-{label[0]}"
            )
            try:
                branch_started = time.time()
                messages = copy.deepcopy(shared_messages)
                messages.append(strategy_prompt(hint))
                _, usage, calls = run_agent_metered(
                    dbid, messages, 12, f"t{trial}-branchpoint-{label[0]}", nonce
                )
                verification = verify(dbid)
                return {
                    "label": label,
                    "seconds": round(time.time() - branch_started, 3),
                    "usage": usage,
                    "calls": calls,
                    "verification": verification,
                    "verdict_at_perf": time.perf_counter(),
                }
            finally:
                meter.shutdown(dbid)

        with ThreadPoolExecutor(max_workers=len(br.BRANCHES)) as pool:
            branches = list(pool.map(branch, enumerate(br.BRANCHES)))
        prefix_db = None
        combined = [{
            "label": "shared prefix",
            "seconds": round(prefix_seconds, 3),
            "usage": prefix_usage,
            "calls": prefix_calls,
            "verification": {"passed": 8, "total": 8, "result": "shared exploration"},
        }] + branches
        result = finalize_condition(
            method,
            nonce,
            started,
            meter,
            combined,
            {
                "prefix_seconds": round(prefix_seconds, 3),
                "snapshot_seconds": round(snapshot_seconds, 3),
                "test_branch_count": len(branches),
            },
        )
        result["all_tests_passed"] = all(
            b["verification"]["passed"] == b["verification"]["total"] == 8
            for b in branches
        )
        return result
    finally:
        if prefix_db is not None:
            try:
                meter.shutdown(prefix_db)
            except Exception:
                pass
        meter.cleanup()


def condition_sequential(fixture_snapshot, trial):
    method = "one_sandbox_sequential"
    nonce = f"{method}-{trial}-{uuid.uuid4().hex}"
    meter = SandboxMeter()
    started = time.perf_counter()
    dbid = None
    try:
        dbid = meter.create(fixture_snapshot, f"3way-{trial}-sequential")
        branches = []
        for item in br.BRANCHES:
            reset_started = time.time()
            reset_task(dbid)
            reset_seconds = time.time() - reset_started
            branch = run_complete_trajectory(dbid, nonce, item, f"t{trial}-sequential-{item[0][0]}")
            branch["reset_seconds"] = round(reset_seconds, 3)
            branches.append(branch)
        meter.shutdown(dbid)
        dbid = None
        return finalize_condition(method, nonce, started, meter, branches)
    finally:
        if dbid is not None:
            try:
                meter.shutdown(dbid)
            except Exception:
                pass
        meter.cleanup()


def condition_fanout(fixture_snapshot, trial):
    method = "n_sandboxes_fanout"
    nonce = f"{method}-{trial}-{uuid.uuid4().hex}"
    meter = SandboxMeter()
    started = time.perf_counter()
    try:
        def branch(item):
            label, _ = item
            dbid = meter.create(fixture_snapshot, f"3way-{trial}-fanout-{label[0]}")
            try:
                return run_complete_trajectory(dbid, nonce, item, f"t{trial}-fanout-{label[0]}")
            finally:
                meter.shutdown(dbid)

        with ThreadPoolExecutor(max_workers=len(br.BRANCHES)) as pool:
            branches = list(pool.map(branch, br.BRANCHES))
        return finalize_condition(method, nonce, started, meter, branches)
    finally:
        meter.cleanup()


def create_fixture():
    """Create one common task-ready snapshot; metrics intentionally excluded."""
    br.log("fixture: create task-ready devbox")
    base = br.rl("POST", "/devboxes", {"name": "3way-benchmark-fixture"})
    dbid = base["id"]
    try:
        br.wait_running(dbid)
        br.sh(dbid, f"mkdir -p {br.WORK}")
        reset_task(dbid)
        br.sh(
            dbid,
            "python3 -m pip install -q pytest 2>&1 | tail -1 || "
            "python3 -m pip install -q --break-system-packages pytest",
        )
        snapshot = br.rl(
            "POST", f"/devboxes/{dbid}/snapshot_disk", {"name": "3way-task-ready-fixture"}
        )["id"]
        wait_snapshot(snapshot)
        return snapshot
    finally:
        try:
            br.rl("POST", f"/devboxes/{dbid}/shutdown", {})
        except Exception:
            pass


def aggregate(trials):
    methods = sorted({condition["method"] for trial in trials for condition in trial["conditions"]})
    out = {}
    for method in methods:
        rows = [
            condition
            for trial in trials
            for condition in trial["conditions"]
            if condition["method"] == method
        ]
        def stats(key):
            values = [float(row[key]) for row in rows]
            return {
                "mean": round(statistics.mean(values), 3),
                "min": round(min(values), 3),
                "max": round(max(values), 3),
            }

        total_usage = add_usage(*(row["usage"] for row in rows))
        mean_usage = {key: round(value / len(rows), 3) for key, value in total_usage.items()}
        out[method] = {
            "trials": len(rows),
            "all_tests_passed": all(row["all_tests_passed"] for row in rows),
            "wall_seconds": stats("wall_seconds"),
            "aggregate_active_sandbox_seconds": stats("aggregate_active_sandbox_seconds"),
            "aggregate_elapsed_sandbox_seconds": stats("aggregate_elapsed_sandbox_seconds"),
            "aggregate_vcpu_seconds": stats("aggregate_vcpu_seconds"),
            "aggregate_memory_gb_seconds": stats("aggregate_memory_gb_seconds"),
            "estimated_runloop_usage_cost_usd": stats("estimated_runloop_usage_cost_usd"),
            "devboxes_created": stats("devboxes_created"),
            "peak_concurrent_devboxes": stats("peak_concurrent_devboxes"),
            "mean_usage": mean_usage,
            "cache_read_ratio_pct": round(
                100 * total_usage["cached_tokens"] / total_usage["prompt_tokens"], 2
            ) if total_usage["prompt_tokens"] else 0,
        }
    return out


def main():
    started = time.time()
    fixture = create_fixture()
    trials = []
    # Reverse the second trial to reduce simple run-order bias.
    orders = [
        [condition_branchpoint, condition_sequential, condition_fanout],
        [condition_fanout, condition_sequential, condition_branchpoint],
    ]
    try:
        for trial_number in range(START_TRIAL, START_TRIAL + TRIALS):
            br.log(f"trial {trial_number} ({trial_number - START_TRIAL + 1}/{TRIALS} in this run)")
            conditions = []
            order = orders[(trial_number - 1) % len(orders)]
            for runner in order:
                br.log(f"condition: {runner.__name__} (fresh cache nonce)")
                condition = runner(fixture, trial_number)
                conditions.append(condition)
                print(
                    json.dumps({
                        "method": condition["method"],
                        "wall_seconds": condition["wall_seconds"],
                        "aggregate_active_sandbox_seconds": condition["aggregate_active_sandbox_seconds"],
                        "usage": condition["usage"],
                        "all_tests_passed": condition["all_tests_passed"],
                    }, ensure_ascii=False, indent=2),
                    flush=True,
                )
            trials.append({"trial": trial_number, "conditions": conditions})
            RAW_RESULT.parent.mkdir(parents=True, exist_ok=True)
            RAW_RESULT.write_text(json.dumps({"trials": trials}, ensure_ascii=False, indent=2))
    finally:
        # Individual conditions shut down their own devboxes.
        pass

    result = {
        "measured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "model": br.MODEL,
        "task": "Three strategy variants for the same 8-test Python agent task",
        "methodology": {
            "branchpoint_shared_prefix": "One exploration trajectory, disk snapshot, reuse the prefix devbox for one continuation, and create N-1 forks; all continuations reuse the exact LLM transcript prefix.",
            "one_sandbox_sequential": "One devbox runs three complete trajectories sequentially, resetting the task files before each trajectory.",
            "n_sandboxes_fanout": "Three devboxes run three complete trajectories concurrently from the same task-ready disk snapshot.",
            "cache_isolation": "A fresh random nonce is embedded in the cacheable system prefix immediately before every condition. Cache reuse is therefore possible only within that condition.",
            "cache_policy": "Anthropic explicit ephemeral prompt cache (5-minute TTL), sticky OpenRouter session per condition, whole-response cache disabled.",
            "sandbox_time": "Sum of Runloop /devboxes/{id}/usage total_active_seconds after every condition devbox is shut down.",
            "llm_cost": "OpenRouter usage.cost when directly billed; provider upstream_inference_cost for this BYOK run. Prompt-cache read/write pricing is reflected.",
            "wall_time": "Primary wall time is condition start to the final test verdict; terminal wall through final shutdown is also stored.",
            "fixture_exclusion": "The common task-ready fixture snapshot is prepared once and excluded from all three conditions.",
        },
        "trials": trials,
        "aggregate": aggregate(trials),
        "pricing": {
            "runloop_vcpu_usd_per_second": 0.00003,
            "runloop_memory_gb_usd_per_second": 0.000007,
            "runloop_disk_gb_usd_per_second": 0.0000000951,
            "claude_sonnet_5_prompt_usd_per_million": 2.0,
            "claude_sonnet_5_completion_usd_per_million": 10.0,
            "claude_sonnet_5_cache_read_usd_per_million": 0.2,
            "claude_sonnet_5_cache_write_5m_usd_per_million": 2.5
        },
        "sources": [
            "https://docs.runloop.ai/api-reference/devbox/get-resource-usage-for-a-devbox",
            "https://runloop.ai/pricing",
            "https://openrouter.ai/docs/guides/best-practices/prompt-caching",
            "https://openrouter.ai/docs/cookbook/administration/usage-accounting",
            "https://platform.claude.com/docs/en/build-with-claude/prompt-caching"
        ],
        "benchmark_wall_seconds": round(time.time() - started, 3),
    }
    RESULT.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    RAW_RESULT.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print("\nAGGREGATE\n" + json.dumps(result["aggregate"], ensure_ascii=False, indent=2), flush=True)
    print(f"result: {RESULT}", flush=True)
    print(f"raw: {RAW_RESULT}", flush=True)


if __name__ == "__main__":
    main()
