#!/usr/bin/env python3
"""
디자인 목업에 박을 '진짜' 스크린샷을 만든다.

데모 대상 앱(Nimbus, 가상의 SaaS 온보딩)을 devbox 안에 띄우고
  v1 = 지난 실행 시점의 앱
  v2 = 배포 이후의 앱 (버튼 이름 바뀜 / 경로 2개 막힘 / 경로 1개 새로 생김)
두 버전을 각각 순회하며 노드별 화면을 캡처해 로컬로 가져온다.

출력: ./design/shots/*.png  (264x165, 노드 썸네일 2배 해상도)
"""
import json, os, subprocess, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

API = "https://api.runloop.ai/v1"
KEY = os.environ["RUNLOOP_API_KEY"]
W = "/home/user/nimbus"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "design", "shots")

# ── 대상 앱 ────────────────────────────────────────────────────────
APP = r'''
import sys, http.server, urllib.parse

V2 = "--v2" in sys.argv
PORT = 8002 if V2 else 8001

SHELL = """<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<style>
 *{box-sizing:border-box;margin:0}
 body{font-family:Inter,system-ui,sans-serif;background:#f6f7f9;color:#1b1d21;
      letter-spacing:-.2px;height:600px;display:flex;flex-direction:column}
 header{height:56px;background:#fff;border-bottom:1px solid #e7e9ee;display:flex;
        align-items:center;gap:10px;padding:0 28px;flex-shrink:0}
 .logo{width:22px;height:22px;border-radius:6px;background:#0f766e}
 .brand{font-weight:600;font-size:15px}
 .steps{margin-left:auto;display:flex;gap:8px;align-items:center;font-size:12px;color:#8b909a}
 .pip{width:22px;height:4px;border-radius:2px;background:#e2e5ea}
 .pip.on{background:#0f766e}
 main{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:0 28px}
 h1{font-size:30px;font-weight:600;letter-spacing:-.8px;text-align:center}
 .sub{margin-top:10px;font-size:15px;color:#6b7280;text-align:center;max-width:520px}
 .opts{margin-top:34px;display:flex;gap:14px}
 .card{width:210px;padding:20px;border-radius:12px;background:#fff;border:1px solid #e2e5ea;
       box-shadow:0 1px 2px rgba(16,24,40,.05);text-align:left}
 .card .ic{width:34px;height:34px;border-radius:9px;background:#e8f5f3;margin-bottom:14px}
 .card b{display:block;font-size:15px;font-weight:600}
 .card span{display:block;margin-top:5px;font-size:13px;color:#6b7280;line-height:1.45}
 .card.pri{border-color:#0f766e;box-shadow:0 0 0 3px rgba(15,118,110,.10)}
 .ok{width:52px;height:52px;border-radius:50%;background:#e8f5f3;display:flex;
     align-items:center;justify-content:center;margin-bottom:20px}
 .warn{width:52px;height:52px;border-radius:50%;background:#fdeceb;display:flex;
       align-items:center;justify-content:center;margin-bottom:20px}
 .cta{margin-top:30px;height:42px;padding:0 22px;border-radius:9px;background:#0f766e;
      color:#fff;font-size:14px;font-weight:500;display:inline-flex;align-items:center}
</style></head><body>
<header><div class="logo"></div><div class="brand">Nimbus</div>
<div class="steps">__STEPS__</div></header>
<main>__BODY__</main></body></html>"""

def pips(n):
    return "".join('<div class="pip%s"></div>' % (" on" if i < n else "") for i in range(3))

def card(icon_hue, title, desc, pri=False):
    return ('<div class="card%s"><div class="ic" style="background:%s"></div>'
            '<b>%s</b><span>%s</span></div>') % (" pri" if pri else "", icon_hue, title, desc)

CHECK = ('<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#0f766e" '
         'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">'
         '<path d="M5 12.5l4.5 4.5L19 7"/></svg>')
BANG = ('<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#d1453b" '
        'stroke-width="2.4" stroke-linecap="round"><path d="M12 7v6M12 16.5v.1"/></svg>')

def page(path, q):
    p = (q.get("p") or [""])[0]

    if path == "/verify":
        return 1, ('<div class="ok">%s</div><h1>Email verified</h1>'
                   '<div class="sub">You are signed in as demo@example.com. '
                   'Two quick questions and your workspace is ready.</div>'
                   '<div class="cta">Continue setup</div>') % CHECK

    if path == "/step1":
        opts = (card("#e8f5f3", "Team plan", "Invite people and share a workspace.", True)
                + card("#eef0f4", "Solo plan", "Just me for now. I can invite people later."))
        if not V2:
            opts += card("#eef0f4", "Decide later", "Skip this and set it up another time.")
        else:
            opts += card("#eef0f4", "Decide later", "Skip this and set it up another time.")
        return 1, ('<h1>How will you use Nimbus?</h1><div class="sub">This only changes '
                   'your defaults. You can switch at any time.</div>'
                   '<div class="opts">%s</div>') % opts

    if path == "/step2":
        if p == "team":
            opts = (card("#e8f5f3", "Invite teammates", "Send invitations by email now.", True)
                    + card("#eef0f4", "Skip invites", "Set the workspace up on my own first."))
            return 2, ('<h1>Bring your team in</h1><div class="sub">Members can be added or '
                       'removed later from workspace settings.</div>'
                       '<div class="opts">%s</div>') % opts
        if p == "solo":
            starter = "Use a starter" if V2 else "Starter template"
            opts = card("#e8f5f3", starter, "Begin from a prepared project layout.", True)
            opts += card("#eef0f4", "Blank workspace", "Start from nothing and build it up.")
            if V2:
                opts += card("#eef0f4", "Import from CSV", "Bring records over from a spreadsheet.")
            return 2, ('<h1>Pick a starting point</h1><div class="sub">Everything here can be '
                       'changed once the workspace exists.</div>'
                       '<div class="opts">%s</div>') % opts
        return 2, ('<h1>Set this up later</h1><div class="sub">We saved your progress. '
                   'You can finish whenever you are ready.</div>'
                   '<div class="cta">Take me to the workspace</div>')

    if path == "/dead":
        return 2, ('<div class="warn">%s</div><h1>Something went wrong</h1>'
                   '<div class="sub">This step could not be completed. '
                   'Try again or contact support.</div>') % BANG

    label = {"team,invite":"Invitations sent", "team,skip":"Workspace ready",
             "solo,starter":"Starter project created", "solo,blank":"Empty workspace ready",
             "solo,import":"Records imported"}.get(p, "Workspace ready")
    return 3, ('<div class="ok">%s</div><h1>%s</h1><div class="sub">Nimbus is set up. '
               'Everything below is editable from settings.</div>'
               '<div class="cta">Open workspace</div>') % (CHECK, label)

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        step, body = page(u.path, urllib.parse.parse_qs(u.query))
        html = SHELL.replace("__STEPS__", pips(step)).replace("__BODY__", body)
        self.send_response(200); self.send_header("Content-Type", "text/html")
        self.end_headers(); self.wfile.write(html.encode())

http.server.HTTPServer(("127.0.0.1", PORT), H).serve_forever()
'''

# ── 캡처 스크립트 ──────────────────────────────────────────────────
SHOOT = r'''
import sys, json, os
from playwright.sync_api import sync_playwright
port, targets = sys.argv[1], json.loads(sys.argv[2])
os.makedirs("/home/user/nimbus/shots", exist_ok=True)
with sync_playwright() as p:
    br = p.chromium.launch(headless=True, args=["--no-sandbox"])
    pg = br.new_context(viewport={"width":960,"height":600},
                        device_scale_factor=1).new_page()
    for name, path in targets:
        pg.goto("http://127.0.0.1:" + port + path, wait_until="networkidle")
        pg.wait_for_timeout(220)          # 웹폰트 안착
        pg.screenshot(path="/home/user/nimbus/shots/" + name + ".png")
    print("SHOT_OK")
    br.close()
'''

# 노드 -> 그 노드에서 보이는 화면
V2_TARGETS = [
    ("root",    "/verify"),
    ("team",    "/step2?p=team"),
    ("solo",    "/step2?p=solo"),
    ("later",   "/dead"),
    ("invite",  "/done?p=team,invite"),
    ("skipinv", "/done?p=team,skip"),
    ("starter", "/done?p=solo,starter"),
    ("blank",   "/dead"),
    ("import",  "/done?p=solo,import"),
    ("step2solo", "/step2?p=solo"),
]
# 지난 실행(v1) — diff 의 baseline 쪽
V1_TARGETS = [
    ("v1-step2solo", "/step2?p=solo"),
    ("v1-later",     "/step2?p=later"),
    ("v1-blank",     "/done?p=solo,blank"),
]


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


def put(i, path, content):
    sh(i, f"python3 -c \"import json,sys;open(sys.argv[1],'w').write(json.loads(sys.argv[2]))\" "
          f"{path} {json.dumps(json.dumps(content))}")


def download(dbid, remote, local):
    body = json.dumps({"path": remote.replace("/home/user/", "", 1)}).encode()
    req = urllib.request.Request(f"{API}/devboxes/{dbid}/download_file", data=body,
        method="POST", headers={"Authorization": f"Bearer {KEY}",
                                "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        data = r.read()
    open(local, "wb").write(data)
    return len(data)


def log(m): print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


def main():
    os.makedirs(OUT, exist_ok=True)
    created = []
    try:
        log("devbox 생성...")
        db = rl("POST", "/devboxes", {"name": "nimbus-shots"}); i = db["id"]
        created.append(i)
        for _ in range(150):
            if rl("GET", f"/devboxes/{i}")["status"] == "running": break
            time.sleep(2)
        log(f"  {i}")

        log("chromium 설치...")
        t0 = time.time()
        sh(i, f"mkdir -p {W}")
        sh(i, "sudo python3 -m pip install -q playwright 2>&1|tail -1; "
              "sudo python3 -m playwright install-deps chromium 2>&1|tail -1; "
              "python3 -m playwright install chromium 2>&1|tail -1")
        log(f"  {time.time()-t0:.0f}s")

        put(i, f"{W}/app.py", APP)
        put(i, f"{W}/shoot.py", SHOOT)

        log("앱 v1(8001) · v2(8002) 기동...")
        rl("POST", f"/devboxes/{i}/execute_async", {"command": f"python3 {W}/app.py"})
        rl("POST", f"/devboxes/{i}/execute_async", {"command": f"python3 {W}/app.py --v2"})
        for _ in range(40):
            ok = sh(i, "curl -sf -o /dev/null http://127.0.0.1:8001/step1 && "
                       "curl -sf -o /dev/null http://127.0.0.1:8002/step1 && echo UP || echo DOWN")
            if ok == "UP": break
            time.sleep(0.5)
        else:
            raise RuntimeError("앱이 안 뜸")
        log("  둘 다 응답")

        log("캡처...")
        for port, targets in (("8002", V2_TARGETS), ("8001", V1_TARGETS)):
            r = sh(i, f"cd {W} && python3 shoot.py {port} {json.dumps(json.dumps(targets))} 2>&1 | tail -3")
            if "SHOT_OK" not in r:
                raise RuntimeError(f"캡처 실패({port}): {r}")
        names = [n for n, _ in V2_TARGETS] + [n for n, _ in V1_TARGETS]
        log(f"  {len(names)}장")

        log("다운로드 + 리사이즈...")
        def grab(n):
            local = os.path.join(OUT, n + ".png")
            size = download(i, f"{W}/shots/{n}.png", local)
            subprocess.run(["sips", "-Z", "264", local], capture_output=True)
            return n, size, os.path.getsize(local)
        with ThreadPoolExecutor(max_workers=6) as ex:
            res = list(ex.map(grab, names))

        print("\n" + "=" * 52)
        print(f"{'파일':<20}{'원본':>12}{'리사이즈':>14}")
        print("-" * 52)
        total = 0
        for n, a, b in res:
            total += b
            print(f"{n+'.png':<20}{a:>11,}B{b:>13,}B")
        print("=" * 52)
        print(f"합계 {total:,}B ({total/1024:.0f}KB) → {OUT}")

    finally:
        log(f"정리: devbox {len(created)}개 종료")
        for d in created:
            try: rl("POST", f"/devboxes/{d}/shutdown", {})
            except Exception: pass


if __name__ == "__main__":
    main()
