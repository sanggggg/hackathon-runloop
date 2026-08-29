#!/usr/bin/env python3
"""
컨테이너 안 크로미움으로 스크린샷을 찍고 로컬로 가져올 수 있는지 검증.
fork 각 분기가 지나간 '모든 페이지'를 캡처한다 -> 플로우 지도의 노드 썸네일.
"""
import json, os, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

API = "https://api.runloop.ai/v1"
KEY = os.environ["RUNLOOP_API_KEY"]
W = "/home/user/flow"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots")

import importlib.util as _il
_spec = _il.spec_from_file_location("_fm", os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "flowmap_test.py"))
_fm = _il.module_from_spec(_spec); _spec.loader.exec_module(_fm)
APP, rl, sh, wait, put = _fm.APP, _fm.rl, _fm.sh, _fm.wait, _fm.put

# 경로를 따라가며 매 페이지를 캡처
DRIVE_SHOT = r'''
import sys, os, json
from playwright.sync_api import sync_playwright
clicks, tag = sys.argv[1:-1], sys.argv[-1]
STATE = "/home/user/flow/state.json"
os.makedirs("/home/user/flow/shots", exist_ok=True)

with sync_playwright() as p:
    br = p.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = br.new_context(storage_state=STATE, viewport={"width": 900, "height": 560})
    pg = ctx.new_page()
    pg.goto("http://127.0.0.1:8000/step1", wait_until="load")
    shots = []
    for n, cid in enumerate(["_enter"] + clicks):
        if cid != "_enter":
            pg.click(f"#{cid}"); pg.wait_for_load_state("load")
        f = f"/home/user/flow/shots/{tag}-{n}-{cid}.png"
        pg.screenshot(path=f)
        shots.append((f, pg.inner_text("h1")))
    print("SHOTS=" + json.dumps(shots))
    print("FINAL=" + pg.inner_text("h1"))
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
    pg.click("#go"); pg.wait_for_load_state("load")
    pg.click("#go"); pg.wait_for_load_state("load")
    print("BOOTSTRAP_TITLE=" + pg.inner_text("h1"))
    ctx.storage_state(path=STATE)
    br.close()
'''


def download(dbid, remote, local):
    # 주의: 파라미터 이름은 path 이고, 경로는 사용자 홈 기준 상대경로다.
    rel = remote.replace("/home/user/", "", 1)
    body = json.dumps({"path": rel}).encode()
    req = urllib.request.Request(f"{API}/devboxes/{dbid}/download_file", data=body,
        method="POST", headers={"Authorization": f"Bearer {KEY}",
                                "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        data = r.read()
    open(local, "wb").write(data)
    return len(data)


def serve(i):
    rl("POST", f"/devboxes/{i}/execute_async", {"command": f"python3 {W}/wizard.py"})
    for _ in range(40):
        if sh(i, "curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/login "
                 "|| echo DOWN") == "200":
            return
        time.sleep(0.5)
    raise RuntimeError("app down")


def log(m): print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


def main():
    os.makedirs(OUT, exist_ok=True)
    created = []
    try:
        log("devbox + chromium...")
        b = rl("POST", "/devboxes", {"name": "shot-base"}); bid = b["id"]
        created.append(bid); wait(bid)
        sh(bid, f"mkdir -p {W}")
        sh(bid, "sudo python3 -m pip install -q playwright 2>&1|tail -1; "
                "sudo python3 -m playwright install-deps chromium 2>&1|tail -1; "
                "python3 -m playwright install chromium 2>&1|tail -1")
        put(bid, f"{W}/wizard.py", APP)
        put(bid, f"{W}/drive.py", DRIVE_SHOT)
        put(bid, f"{W}/bootstrap.py", BOOTSTRAP)
        serve(bid)
        log("  " + sh(bid, f"cd {W} && python3 bootstrap.py 2>&1|tail -2"))

        log("스냅샷...")
        snap = rl("POST", f"/devboxes/{bid}/snapshot_disk", {"name": "shot"})
        sid = snap["id"]
        for _ in range(180):
            st = rl("GET", f"/devboxes/disk_snapshots/{sid}/status").get("status")
            if st in ("complete", "completed", "ready", None): break
            time.sleep(2)
        log(f"  {sid}")

        paths = [("team", ["team", "starter"]), ("solo", ["solo", "blank"])]

        def go(item):
            tag, clicks = item
            db = rl("POST", "/devboxes", {"name": f"shot-{tag}", "snapshot_id": sid})
            created.append(db["id"]); wait(db["id"]); serve(db["id"])
            out = sh(db["id"], f"cd {W} && python3 drive.py {' '.join(clicks)} {tag} 2>&1|tail -3")
            shots = json.loads(next(l[6:] for l in out.splitlines() if l.startswith("SHOTS=")))
            got = []
            for remote, title in shots:
                local = os.path.join(OUT, os.path.basename(remote))
                got.append((os.path.basename(remote), title, download(db["id"], remote, local)))
            return tag, got

        log("fork 2개 → 경로별 전 페이지 캡처...")
        with ThreadPoolExecutor(max_workers=2) as ex:
            res = list(ex.map(go, paths))

        print("\n" + "=" * 66)
        print(f"{'파일':<28}{'페이지 제목':<26}{'크기'}")
        print("-" * 66)
        for tag, got in res:
            for name, title, size in got:
                print(f"{name:<28}{title[:25]:<26}{size:,}B")
        print("=" * 66)
        print(f"\n✅ 로컬 저장 위치: {OUT}")

    finally:
        log(f"정리: {len(created)}개 종료")
        for d in created:
            try: rl("POST", f"/devboxes/{d}/shutdown", {})
            except Exception: pass


if __name__ == "__main__":
    main()
