#!/usr/bin/env python3
"""
플로우 지도 기술 검증.

핵심 질문: 브라우저 로그인 세션이 fork를 넘어 살아남는가?

  devbox -> playwright+chromium 설치 -> 마법사 앱 띄움
  -> 로그인해서 step1까지 진행 (비싼 prefix)
  -> 📸 snapshot
  -> 3개 fork, 각자 다른 분기 선택
  -> 각 fork가 여전히 로그인 상태인지 + 다른 종착지에 도달했는지 확인
"""
import json, os, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

API = "https://api.runloop.ai/v1"
KEY = os.environ["RUNLOOP_API_KEY"]
W = "/home/user/flow"

# ── 대상: devbox 안에서 도는 3단계 마법사 (세션을 디스크에 저장) ──
APP = r'''
import json, os, http.server, urllib.parse
SESS = "/home/user/flow/sessions.json"

def load():  return json.load(open(SESS)) if os.path.exists(SESS) else {}
def save(d): json.dump(d, open(SESS, "w"))

PAGE = """<html><body><h1>{title}</h1><p>path so far: {path}</p>{body}</body></html>"""

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def sid(self):
        c = self.headers.get("Cookie", "")
        for kv in c.split(";"):
            if kv.strip().startswith("sid="): return kv.strip()[4:]
        return None

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        sessions, sid = load(), self.sid()
        route = u.path

        if route == "/login":
            return self.send_page("Login", '<a href="/do-login" id="go">Sign in</a>')

        if route == "/do-login":
            sid = "sess-abc123"
            sessions[sid] = {"user": "demo@example.com", "path": []}
            save(sessions)
            return self.send_page("Welcome", '<a href="/step1" id="go">Start setup</a>',
                                  cookie=f"sid={sid}; Path=/")

        # 로그인 필요 구간
        if sid not in sessions:
            return self.send_page("REDIRECTED-TO-LOGIN", "not authenticated")

        s = sessions[sid]
        if route.startswith("/choose/"):
            s["path"].append(route.split("/")[-1]); save(sessions)
            route = "/step2" if len(s["path"]) == 1 else "/done"

        if route == "/step1":
            return self.send_page("Step 1: How will you use it?",
                '<a href="/choose/team" id="team">Team</a> | '
                '<a href="/choose/solo" id="solo">Solo</a>', s)
        if route == "/step2":
            return self.send_page("Step 2: Pick a template",
                '<a href="/choose/blank" id="blank">Blank</a> | '
                '<a href="/choose/starter" id="starter">Starter</a> | '
                '<a href="/choose/skip" id="skip">Skip</a>', s)
        return self.send_page("DONE", f"finished as {s['user']}", s)

    def send_page(self, title, body, s=None, cookie=None):
        html = PAGE.format(title=title, path="/".join((s or {}).get("path", [])), body=body)
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        if cookie: self.send_header("Set-Cookie", cookie)
        self.end_headers(); self.wfile.write(html.encode())

http.server.HTTPServer(("127.0.0.1", 8000), H).serve_forever()
'''

# ── 브라우저 상태는 storage_state 로 명시적으로 덤프/복원한다.
#    이유: 만료시간 없는 '세션 쿠키'는 크로미움이 디스크 프로필에 쓰지 않는다.
#    프로필 디렉터리만 믿으면 fork 후 재기동 시 로그인이 풀린다. ──
STATE = "/home/user/flow/state.json"

DRIVE = r'''
import sys, os, json
from playwright.sync_api import sync_playwright

clicks = sys.argv[1:]
STATE = "/home/user/flow/state.json"

print("HAS_STATE=" + str(os.path.exists(STATE)))
print("HAS_SESSIONS=" + str(os.path.exists("/home/user/flow/sessions.json")))
if os.path.exists(STATE):
    print("COOKIES=" + str(len(json.load(open(STATE)).get("cookies", []))))

with sync_playwright() as p:
    br = p.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = br.new_context(storage_state=STATE if os.path.exists(STATE) else None)
    pg = ctx.new_page()
    pg.goto("http://127.0.0.1:8000/step1", wait_until="load")
    for cid in clicks:
        if pg.query_selector(f"#{cid}"):
            pg.click(f"#{cid}"); pg.wait_for_load_state("load")
    print("TITLE=" + pg.inner_text("h1"))
    print("PATH=" + pg.inner_text("p"))
    br.close()
'''

BOOTSTRAP = r'''
import json
from playwright.sync_api import sync_playwright
STATE = "/home/user/flow/state.json"
with sync_playwright() as p:
    br = p.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = br.new_context()
    pg = ctx.new_page()
    pg.goto("http://127.0.0.1:8000/login", wait_until="load")
    pg.click("#go"); pg.wait_for_load_state("load")   # do-login -> 쿠키 발급
    pg.click("#go"); pg.wait_for_load_state("load")   # step1 도달
    print("BOOTSTRAP_TITLE=" + pg.inner_text("h1"))
    ctx.storage_state(path=STATE)                     # ← 세션 쿠키까지 디스크로
    print("SAVED_COOKIES=" + str(len(json.load(open(STATE)).get("cookies", []))))
    br.close()
'''


def rl(m, p, b=None, t=600):
    d = json.dumps(b).encode() if b is not None else None
    r = urllib.request.Request(f"{API}{p}", data=d, method=m,
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=t) as x:
            return json.loads(x.read() or "{}")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{m} {p} -> {e.code}: {e.read().decode()[:300]}") from None


def sh(i, c, t=600):
    r = rl("POST", f"/devboxes/{i}/execute_sync", {"command": c}, t=t)
    return ((r.get("stdout") or "") + (r.get("stderr") or "")).strip()


def wait(i):
    for _ in range(150):
        st = rl("GET", f"/devboxes/{i}")["status"]
        if st == "running": return
        if st in ("failure", "shutdown"): raise RuntimeError(st)
        time.sleep(2)
    raise TimeoutError(i)


def put(i, path, content):
    sh(i, f"python3 -c \"import json,sys;open(sys.argv[1],'w').write(json.loads(sys.argv[2]))\" "
          f"{path} {json.dumps(json.dumps(content))}")


def serve(i):
    """앱을 백그라운드로 띄우고 준비될 때까지 대기.

    주의: execute_sync 로 '& 백그라운드'를 띄우면 파이프가 안 닫혀서 API 호출이 멈춘다.
    장기 실행 프로세스는 execute_async 로 띄워야 한다 (execute_sync 는 deprecated).
    """
    rl("POST", f"/devboxes/{i}/execute_async", {"command": f"python3 {W}/wizard.py"})
    for _ in range(40):
        if sh(i, "curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/login "
                 "|| echo DOWN") == "200":
            return
        time.sleep(0.5)
    raise RuntimeError("wizard 앱이 안 뜸")


def log(m): print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


def main():
    created = []
    try:
        log("devbox 생성...")
        base = rl("POST", "/devboxes", {"name": "flowmap-base"}); bid = base["id"]
        created.append(bid); wait(bid); log(f"  {bid}")

        log("chromium + playwright 설치 (비싼 prefix)...")
        t0 = time.time()
        sh(bid, f"mkdir -p {W}")
        # pip 패키지는 시스템 경로라 sudo, 브라우저 바이너리는 user 캐시(~/.cache)로 받아야 함
        out = sh(bid, "sudo python3 -m pip install -q playwright 2>&1 | tail -2; "
                      "sudo python3 -m playwright install-deps chromium 2>&1 | tail -1; "
                      "python3 -m playwright install chromium 2>&1 | tail -1; "
                      "ls ~/.cache/ms-playwright/")
        setup_secs = time.time() - t0
        log(f"  설치 완료 ({setup_secs:.0f}s)  {out[-120:] if out else ''}")

        put(bid, f"{W}/wizard.py", APP)
        put(bid, f"{W}/drive.py", DRIVE)
        put(bid, f"{W}/bootstrap.py", BOOTSTRAP)
        serve(bid)

        log("브라우저로 로그인 → step1 까지 진행...")
        r = sh(bid, f"cd {W} && python3 bootstrap.py 2>&1 | tail -4")
        log(f"  {r}")
        if "Step 1" not in r:
            raise RuntimeError(f"부트스트랩 실패: {r}")

        log("📸 스냅샷 (브라우저 프로필 + 서버 세션 포함)...")
        t0 = time.time()
        snap = rl("POST", f"/devboxes/{bid}/snapshot_disk", {"name": "flowmap"})
        sid = snap["id"]
        for _ in range(180):
            st = rl("GET", f"/devboxes/disk_snapshots/{sid}/status").get("status")
            if st in ("complete", "completed", "ready", None): break
            if st in ("error", "failure"): raise RuntimeError(st)
            time.sleep(2)
        snap_secs = time.time() - t0
        log(f"  {sid} ({snap_secs:.1f}s)")

        paths = [("team → starter", ["team", "starter"]),
                 ("solo → blank",   ["solo", "blank"]),
                 ("solo → skip",    ["solo", "skip"])]

        def explore(item):
            label, clicks = item
            t = time.time()
            db = rl("POST", "/devboxes", {"name": "flowmap-fork", "snapshot_id": sid})
            created.append(db["id"]); wait(db["id"])
            boot = time.time() - t
            serve(db["id"])                       # 프로세스는 안 넘어오므로 재기동
            out = sh(db["id"], f"cd {W} && python3 drive.py {' '.join(clicks)} 2>&1 | tail -4")
            title = next((l[6:] for l in out.splitlines() if l.startswith("TITLE=")), "?")
            pth = next((l[5:] for l in out.splitlines() if l.startswith("PATH=")), "?")
            return label, boot, title, pth, out

        log("3개로 fork → 각자 다른 경로 탐색...")
        t0 = time.time()
        with ThreadPoolExecutor(max_workers=3) as ex:
            res = list(ex.map(explore, paths))
        log(f"  완료 ({time.time()-t0:.0f}s)")

        print("\n" + "=" * 70)
        print(f"공유 prefix: 설치 {setup_secs:.0f}s + 로그인 · 스냅샷 {snap_secs:.1f}s")
        print("=" * 70)
        print(f"{'선택 경로':<18}{'부팅':>7}  {'세션':<8}{'도달 지점':<12}{'서버가 기록한 경로'}")
        print("-" * 70)
        for label, boot, title, pth, _ in res:
            alive = "❌ 끊김" if "REDIRECT" in title else "✅ 유지"
            print(f"{label:<18}{boot:>6.1f}s  {alive:<8}{title[:11]:<12}{pth}")
        print("=" * 70)
        ok = all("REDIRECT" not in r[2] for r in res)
        print(f"\n{'✅ 검증 성공' if ok else '❌ 검증 실패'}: "
              f"로그인 세션이 fork를 넘어 {'살아남음' if ok else '유실됨'}")
        if ok:
            print("   → 같은 로그인 상태에서 갈라져 서로 다른 종착지 도달. 플로우 지도 성립.")
        for label, _, _, _, out in res:
            if "REDIRECT" in out or "Error" in out or "error" in out:
                print(f"\n[{label}] raw:\n{out[:500]}")

    finally:
        log(f"정리: devbox {len(created)}개 종료")
        for d in created:
            try: rl("POST", f"/devboxes/{d}/shutdown", {})
            except Exception: pass


if __name__ == "__main__":
    main()
