#!/usr/bin/env python3
"""
Branch & Race — 에이전트를 중간에서 fork해서 세 전략을 경주시킨다.

  [공유 prefix]  devbox 생성 -> 과제 심기 -> 에이전트가 탐색만 (아직 안 고침)
        📸 snapshot
  [분기]         3개 fork, 각자 다른 전략 힌트로 계속
  [판정]         pytest 통과 수 + 비용 비교

에이전트 루프는 로컬(OpenRouter), devbox는 '손' 역할만 한다.
필요 env: RUNLOOP_API_KEY, OPENROUTER_API_KEY
"""
import json, os, re, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

RL_API = "https://api.runloop.ai/v1"
OR_API = "https://openrouter.ai/api/v1/chat/completions"
RL_KEY = os.environ["RUNLOOP_API_KEY"]
OR_KEY = os.environ["OPENROUTER_API_KEY"]
MODEL = os.environ.get("MODEL", "anthropic/claude-sonnet-5")

WORK = "/home/user/work"

# ─────────────────────────── 과제 ───────────────────────────
BUGGY = '''\
UNITS = {"h": 3600, "m": 60, "s": 1}


def parse_duration(s):
    """'1h30m' 같은 문자열을 초로 변환한다."""
    total = 0
    num = ""
    for ch in s:
        if ch.isdigit():
            num += ch
        else:
            total += int(num) * UNITS[ch]
            num = ""
    return total
'''

TESTS = '''\
import pytest
from duration import parse_duration


def test_basic():
    assert parse_duration("1h30m") == 5400


def test_single_unit():
    assert parse_duration("90m") == 5400


def test_empty():
    assert parse_duration("") == 0


def test_whitespace():
    assert parse_duration("1h 30m") == 5400


def test_decimal():
    assert parse_duration("1.5h") == 5400


def test_days():
    assert parse_duration("2d") == 172800


def test_negative():
    assert parse_duration("-30m") == -1800


def test_invalid_raises():
    with pytest.raises(ValueError):
        parse_duration("abc")
'''

BRANCHES = [
    ("A · 최소수정", "실패하는 테스트만 최소한으로 고쳐라. 기존 구조를 최대한 유지하고, "
                     "불필요한 리팩터링은 하지 마라."),
    ("B · 엣지케이스", "고치기 전에 테스트 파일을 전부 읽고 엣지케이스를 하나하나 짚어라. "
                       "그 다음 모든 케이스를 처리하도록 고쳐라."),
    ("C · 전면재작성", "함수를 처음부터 다시 설계해도 좋다. 정규식이든 파서든 원하는 방식으로, "
                       "가장 견고한 구현을 만들어라."),
]


# ─────────────────────── Runloop 얇은 클라이언트 ───────────────────────
def rl(method, path, body=None, timeout=180):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{RL_API}{path}", data=data, method=method,
        headers={"Authorization": f"Bearer {RL_KEY}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or "{}")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {path} -> {e.code}: {e.read().decode()[:400]}") from None


def wait_running(dbid):
    for _ in range(150):
        st = rl("GET", f"/devboxes/{dbid}")["status"]
        if st == "running":
            return
        if st in ("failure", "shutdown"):
            raise RuntimeError(f"devbox {dbid} -> {st}")
        time.sleep(2)
    raise TimeoutError(dbid)


def sh(dbid, cmd):
    r = rl("POST", f"/devboxes/{dbid}/execute_sync", {"command": cmd})
    out = (r.get("stdout") or "") + (r.get("stderr") or "")
    return out.strip()


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ─────────────────────────── 도구 ───────────────────────────
TOOLS = [
    {"type": "function", "function": {
        "name": "read_file", "description": "파일을 읽는다",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string"}}, "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "write_file", "description": "파일 전체를 덮어쓴다",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"]}}},
    {"type": "function", "function": {
        "name": "run", "description": f"{WORK} 에서 셸 명령을 실행한다",
        "parameters": {"type": "object", "properties": {
            "command": {"type": "string"}}, "required": ["command"]}}},
]


def exec_tool(dbid, name, args):
    if name == "read_file":
        return sh(dbid, f"cat {args['path']}")[:4000]
    if name == "write_file":
        payload = json.dumps(args["content"])
        script = (f"python3 -c \"import json,sys;"
                  f"open(sys.argv[1],'w').write(json.loads(sys.argv[2]))\" "
                  f"{args['path']} {json.dumps(payload)}")
        sh(dbid, script)
        return f"wrote {args['path']}"
    if name == "run":
        return sh(dbid, f"cd {WORK} && {args['command']}")[:4000]
    return f"unknown tool: {name}"


# ─────────────────────────── 에이전트 ───────────────────────────
def llm(messages):
    body = {"model": MODEL, "messages": messages, "tools": TOOLS, "temperature": 0.7}
    req = urllib.request.Request(
        OR_API, data=json.dumps(body).encode(), method="POST",
        headers={"Authorization": f"Bearer {OR_KEY}", "Content-Type": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if attempt == 2:
                raise RuntimeError(f"OpenRouter {e.code}: {e.read().decode()[:300]}") from None
            time.sleep(3)


def run_agent(dbid, messages, max_turns, tag=""):
    """에이전트를 max_turns 만큼 돌리고 (messages, 누적비용) 반환"""
    cost = 0.0
    for turn in range(max_turns):
        resp = llm(messages)
        u = resp.get("usage") or {}
        cost += u.get("prompt_tokens", 0) / 1e6 * 2.0 + u.get("completion_tokens", 0) / 1e6 * 10.0

        msg = resp["choices"][0]["message"]
        messages.append(msg)
        calls = msg.get("tool_calls") or []
        if not calls:
            break
        for c in calls:
            args = json.loads(c["function"]["arguments"] or "{}")
            result = exec_tool(dbid, c["function"]["name"], args)
            print(f"    {tag} · {c['function']['name']}({str(args)[:60]}...)", flush=True)
            messages.append({"role": "tool", "tool_call_id": c["id"], "content": result})
    return messages, cost


def pytest_score(dbid):
    out = sh(dbid, f"cd {WORK} && python3 -m pytest -q --tb=no 2>&1 | tail -3")
    passed = int((re.search(r"(\d+) passed", out) or [0, 0])[1])
    failed = int((re.search(r"(\d+) failed", out) or [0, 0])[1])
    return passed, passed + failed, out.splitlines()[-1] if out else ""


# ─────────────────────────── 본체 ───────────────────────────
def main():
    created = []
    try:
        # ── 1. 공유 prefix: 환경 준비 ──────────────────────────
        log("devbox 생성...")
        base = rl("POST", "/devboxes", {"name": "branch-race-base"})
        created.append(base["id"])
        wait_running(base["id"])
        log(f"  {base['id']}")

        log("과제 심고 pytest 설치...")
        sh(base["id"], f"mkdir -p {WORK}")
        for path, content in ((f"{WORK}/duration.py", BUGGY), (f"{WORK}/test_duration.py", TESTS)):
            exec_tool(base["id"], "write_file", {"path": path, "content": content})
        sh(base["id"], "python3 -m pip install -q pytest 2>&1 | tail -1 || "
                       "python3 -m pip install -q --break-system-packages pytest")
        p, tot, line = pytest_score(base["id"])
        log(f"  시작 상태: {p}/{tot} 통과   ({line})")

        # ── 2. 공유 prefix: 에이전트가 탐색만 ──────────────────
        log("에이전트 탐색 중 (아직 고치지 않음)...")
        system = ("너는 시니어 파이썬 엔지니어다. /home/user/work 에서 작업한다. "
                  "도구로 파일을 읽고 쓰고 명령을 실행할 수 있다. 간결하게 행동해라.")
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content":
                "duration.py 와 test_duration.py 를 읽고 pytest 를 한 번 실행해서 "
                "무엇이 왜 실패하는지 파악해라. **아직 코드를 고치지는 마라.** "
                "파악이 끝나면 실패 원인을 짧게 요약해라."},
        ]
        t0 = time.time()
        messages, prefix_cost = run_agent(base["id"], messages, max_turns=6, tag="prefix")
        prefix_time = time.time() - t0
        log(f"  탐색 완료 ({prefix_time:.0f}s, ${prefix_cost:.4f})")

        # ── 3. 스냅샷 ─────────────────────────────────────────
        log("📸 스냅샷...")
        t0 = time.time()
        snap = rl("POST", f"/devboxes/{base['id']}/snapshot_disk", {"name": "branch-race"})
        sid = snap["id"]
        for _ in range(120):
            st = rl("GET", f"/devboxes/disk_snapshots/{sid}/status").get("status")
            if st in ("complete", "completed", "ready", None):
                break
            if st in ("error", "failure"):
                raise RuntimeError(f"snapshot {st}")
            time.sleep(2)
        log(f"  {sid}  ({time.time()-t0:.1f}s)")

        # ── 4. 3개로 fork, 각자 다른 전략 ──────────────────────
        def race(item):
            label, hint = item
            db = rl("POST", "/devboxes", {"name": f"race-{label[0]}", "snapshot_id": sid})
            created.append(db["id"])
            wait_running(db["id"])
            branch_msgs = list(messages) + [{"role": "user", "content":
                f"{hint}\n\n이제 duration.py 를 고치고 pytest 로 검증해라. "
                f"전부 통과할 때까지 반복해라."}]
            t = time.time()
            _, cost = run_agent(db["id"], branch_msgs, max_turns=12, tag=label[0])
            passed, total, _ = pytest_score(db["id"])
            diff = sh(db["id"], f"cd {WORK} && wc -l < duration.py")
            return dict(label=label, passed=passed, total=total, cost=cost,
                        secs=time.time() - t, lines=diff)

        log("3개로 fork → 병렬 경주 시작...")
        t0 = time.time()
        with ThreadPoolExecutor(max_workers=3) as ex:
            results = list(ex.map(race, BRANCHES))
        log(f"  경주 완료 ({time.time()-t0:.0f}s)")

        # ── 5. 판정 ───────────────────────────────────────────
        print("\n" + "=" * 68)
        print(f"공유 prefix: {prefix_time:.0f}s / ${prefix_cost:.4f}  ← fork 안 했으면 3번 반복해야 함")
        print("=" * 68)
        print(f"{'분기':<16}{'통과':>8}{'시간':>8}{'비용':>10}{'코드길이':>10}")
        print("-" * 68)
        best = max(results, key=lambda r: (r["passed"], -r["cost"]))
        for r in results:
            mark = " ★" if r is best else "  "
            print(f"{r['label']:<16}{r['passed']:>4}/{r['total']:<3}{r['secs']:>7.0f}s"
                  f"{'$'+format(r['cost'],'.4f'):>10}{r['lines']+'줄':>10}{mark}")
        print("=" * 68)
        print(f"\n승자: {best['label']}  ({best['passed']}/{best['total']} 통과, ${best['cost']:.4f})")
        saved = prefix_cost * (len(BRANCHES) - 1)
        print(f"fork로 아낀 prefix 비용: ${saved:.4f} · 시간 {prefix_time*(len(BRANCHES)-1):.0f}s")

    finally:
        log(f"정리: devbox {len(created)}개 종료")
        for dbid in created:
            try:
                rl("POST", f"/devboxes/{dbid}/shutdown", {})
            except Exception:
                pass


if __name__ == "__main__":
    main()
