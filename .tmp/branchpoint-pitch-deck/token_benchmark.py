#!/usr/bin/env python3
"""Measure end-to-end LLM token use with and without a shared agent prefix.

The benchmark uses the same task, tools, prompts, and model as branch_race.py.
Runloop equalizes the starting disk state for both conditions:

  shared:      explore once -> snapshot -> three strategy continuations
  independent: three forks -> each explores -> each strategy continuation
"""

import copy
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path("/Users/sangmin/Desktop/hackathon-runloop")
sys.path.insert(0, str(ROOT / "experiments"))
import branch_race as br  # noqa: E402

RESULT = ROOT / ".tmp/branchpoint-pitch-deck/token-benchmark-result.json"


def zero():
    return {"requests": 0, "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "estimated_cost_usd": 0.0}


def plus(*items):
    out = zero()
    for item in items:
        for key in out:
            out[key] += item.get(key, 0)
    return out


def run_agent_metered(dbid, messages, max_turns, tag=""):
    usage = zero()
    for _ in range(max_turns):
        resp = br.llm(messages)
        u = resp.get("usage") or {}
        prompt = int(u.get("prompt_tokens", 0) or 0)
        completion = int(u.get("completion_tokens", 0) or 0)
        usage["requests"] += 1
        usage["prompt_tokens"] += prompt
        usage["completion_tokens"] += completion
        usage["total_tokens"] += int(u.get("total_tokens", prompt + completion) or prompt + completion)
        usage["estimated_cost_usd"] += prompt / 1e6 * 2.0 + completion / 1e6 * 10.0

        msg = resp["choices"][0]["message"]
        messages.append(msg)
        calls = msg.get("tool_calls") or []
        if not calls:
            break
        for call in calls:
            args = json.loads(call["function"]["arguments"] or "{}")
            result = br.exec_tool(dbid, call["function"]["name"], args)
            print(f"    {tag} · {call['function']['name']}", flush=True)
            messages.append({"role": "tool", "tool_call_id": call["id"], "content": result})
    return messages, usage


def wait_snapshot(sid):
    for _ in range(180):
        status = br.rl("GET", f"/devboxes/disk_snapshots/{sid}/status").get("status")
        if status in ("complete", "completed", "ready", None):
            return
        if status in ("error", "failure"):
            raise RuntimeError(f"snapshot {sid}: {status}")
        time.sleep(2)
    raise TimeoutError(sid)


def create_from_snapshot(created, sid, name):
    db = br.rl("POST", "/devboxes", {"name": name, "snapshot_id": sid})
    created.append(db["id"])
    br.wait_running(db["id"])
    return db["id"]


def initial_messages():
    return [
        {"role": "system", "content": "너는 시니어 파이썬 엔지니어다. /home/user/work 에서 작업한다. 도구로 파일을 읽고 쓰고 명령을 실행할 수 있다. 간결하게 행동해라."},
        {"role": "user", "content": "duration.py 와 test_duration.py 를 읽고 pytest 를 한 번 실행해서 무엇이 왜 실패하는지 파악해라. **아직 코드를 고치지는 마라.** 파악이 끝나면 실패 원인을 짧게 요약해라."},
    ]


def strategy_prompt(hint):
    return {"role": "user", "content": f"{hint}\n\n이제 duration.py 를 고치고 pytest 로 검증해라. 전부 통과할 때까지 반복해라."}


def main():
    created = []
    result = {"model": br.MODEL, "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    try:
        br.log("token benchmark: base devbox")
        base = br.rl("POST", "/devboxes", {"name": "token-benchmark-base"})
        created.append(base["id"])
        br.wait_running(base["id"])
        br.sh(base["id"], f"mkdir -p {br.WORK}")
        for path, content in ((f"{br.WORK}/duration.py", br.BUGGY), (f"{br.WORK}/test_duration.py", br.TESTS)):
            br.exec_tool(base["id"], "write_file", {"path": path, "content": content})
        br.sh(base["id"], "python3 -m pip install -q pytest 2>&1 | tail -1 || python3 -m pip install -q --break-system-packages pytest")

        start_snap = br.rl("POST", f"/devboxes/{base['id']}/snapshot_disk", {"name": "token-benchmark-start"})["id"]
        wait_snapshot(start_snap)

        br.log("condition A: shared prefix once")
        shared_start = time.time()
        shared_messages, shared_prefix_usage = run_agent_metered(base["id"], initial_messages(), 6, "shared-prefix")
        shared_snap = br.rl("POST", f"/devboxes/{base['id']}/snapshot_disk", {"name": "token-benchmark-shared-prefix"})["id"]
        wait_snapshot(shared_snap)

        def shared_branch(item):
            label, hint = item
            dbid = create_from_snapshot(created, shared_snap, f"token-shared-{label[0]}")
            messages = copy.deepcopy(shared_messages)
            messages.append(strategy_prompt(hint))
            started = time.time()
            _, usage = run_agent_metered(dbid, messages, 12, f"shared-{label[0]}")
            passed, total, line = br.pytest_score(dbid)
            return {"label": label, "usage": usage, "passed": passed, "total": total, "result": line, "seconds": time.time() - started}

        with ThreadPoolExecutor(max_workers=3) as pool:
            shared_branches = list(pool.map(shared_branch, br.BRANCHES))
        shared_usage = plus(shared_prefix_usage, *(b["usage"] for b in shared_branches))
        result["shared"] = {
            "prefix_usage": shared_prefix_usage,
            "branches": shared_branches,
            "total_usage": shared_usage,
            "wall_seconds": time.time() - shared_start,
        }

        br.log("condition B: independent prefix per strategy")
        independent_start = time.time()

        def independent_branch(item):
            label, hint = item
            dbid = create_from_snapshot(created, start_snap, f"token-independent-{label[0]}")
            started = time.time()
            messages, prefix_usage = run_agent_metered(dbid, initial_messages(), 6, f"independent-{label[0]}-prefix")
            messages.append(strategy_prompt(hint))
            _, continuation_usage = run_agent_metered(dbid, messages, 12, f"independent-{label[0]}-fix")
            passed, total, line = br.pytest_score(dbid)
            return {
                "label": label,
                "prefix_usage": prefix_usage,
                "continuation_usage": continuation_usage,
                "usage": plus(prefix_usage, continuation_usage),
                "passed": passed,
                "total": total,
                "result": line,
                "seconds": time.time() - started,
            }

        with ThreadPoolExecutor(max_workers=3) as pool:
            independent_branches = list(pool.map(independent_branch, br.BRANCHES))
        independent_usage = plus(*(b["usage"] for b in independent_branches))
        result["independent"] = {
            "branches": independent_branches,
            "total_usage": independent_usage,
            "wall_seconds": time.time() - independent_start,
        }

        shared_tokens = shared_usage["total_tokens"]
        independent_tokens = independent_usage["total_tokens"]
        result["comparison"] = {
            "tokens_saved": independent_tokens - shared_tokens,
            "token_reduction_pct": round((independent_tokens - shared_tokens) / independent_tokens * 100, 2) if independent_tokens else 0,
            "estimated_cost_saved_usd": round(independent_usage["estimated_cost_usd"] - shared_usage["estimated_cost_usd"], 6),
            "estimated_cost_reduction_pct": round((independent_usage["estimated_cost_usd"] - shared_usage["estimated_cost_usd"]) / independent_usage["estimated_cost_usd"] * 100, 2) if independent_usage["estimated_cost_usd"] else 0,
        }
        RESULT.write_text(json.dumps(result, ensure_ascii=False, indent=2))
        print("\n" + json.dumps(result["comparison"], ensure_ascii=False, indent=2), flush=True)
        print(f"result: {RESULT}", flush=True)
    finally:
        br.log(f"cleanup: {len(created)} devboxes")
        for dbid in created:
            try:
                br.rl("POST", f"/devboxes/{dbid}/shutdown", {})
            except Exception as exc:
                print(f"cleanup failed for {dbid}: {exc}", flush=True)


if __name__ == "__main__":
    main()
