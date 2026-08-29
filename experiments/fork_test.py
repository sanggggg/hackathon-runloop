#!/usr/bin/env python3
"""
Runloop fork 최소 검증.
  devbox 생성 -> 상태 만들기 -> 스냅샷 -> 3개로 fork -> 각자 다른 명령 -> 결과 비교
LLM 키 불필요. 순수 Runloop primitive만 씀.
"""
import json, os, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

API = "https://api.runloop.ai/v1"
KEY = os.environ["RUNLOOP_API_KEY"]


def call(method, path, body=None, timeout=120):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{API}{path}", data=data, method=method,
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or "{}")
    except urllib.error.HTTPError as e:
        print(f"  !! {method} {path} -> {e.code}: {e.read().decode()[:300]}")
        raise


def t(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def wait_devbox(dbid, label=""):
    for _ in range(120):
        st = call("GET", f"/devboxes/{dbid}")["status"]
        if st == "running":
            return
        if st in ("failure", "shutdown"):
            raise RuntimeError(f"devbox {dbid} {label} -> {st}")
        time.sleep(2)
    raise TimeoutError(f"devbox {dbid} 부팅 타임아웃")


def sh(dbid, cmd):
    r = call("POST", f"/devboxes/{dbid}/execute_sync", {"command": cmd})
    return (r.get("stdout") or "").strip() or (r.get("stderr") or "").strip()


def main():
    created = []
    try:
        # ---------- 1. 원본 devbox ----------
        t("원본 devbox 생성...")
        base = call("POST", "/devboxes", {"name": "fork-test-base"})
        created.append(base["id"])
        wait_devbox(base["id"], "base")
        t(f"  running: {base['id']}")

        # ---------- 2. 재현하기 싫은 '비싼' 상태 만들기 ----------
        t("상태 만드는 중 (비싼 prefix 흉내)...")
        sh(base["id"], "mkdir -p /home/user/work && "
                       "echo 'ORIGIN-STATE-1234' > /home/user/work/base.txt && "
                       "seq 1 5000 > /home/user/work/data.txt")
        proof = sh(base["id"], "cat /home/user/work/base.txt; wc -l < /home/user/work/data.txt")
        t(f"  원본 상태: {proof!r}")

        # ---------- 3. 스냅샷 ----------
        t("스냅샷 찍는 중...")
        t0 = time.time()
        snap = call("POST", f"/devboxes/{base['id']}/snapshot_disk", {"name": "fork-test-snap"})
        sid = snap["id"]
        for _ in range(120):
            st = call("GET", f"/devboxes/disk_snapshots/{sid}/status").get("status")
            if st in ("complete", "completed", "ready", None):
                break
            if st in ("error", "failure"):
                raise RuntimeError(f"snapshot {st}")
            time.sleep(2)
        t(f"  스냅샷 완료: {sid}  ({time.time()-t0:.1f}s)")

        # ---------- 4. 3개로 fork (병렬) ----------
        branches = [
            ("A-최소",   "echo 'branch A' >> /home/user/work/base.txt; wc -l < /home/user/work/data.txt"),
            ("B-중간",   "seq 5001 7000 >> /home/user/work/data.txt; wc -l < /home/user/work/data.txt"),
            ("C-공격적", "seq 5001 9999 >> /home/user/work/data.txt; wc -l < /home/user/work/data.txt"),
        ]

        def run_branch(item):
            label, cmd = item
            tb = time.time()
            db = call("POST", "/devboxes", {"name": f"fork-{label}", "snapshot_id": sid})
            created.append(db["id"])
            wait_devbox(db["id"], label)
            boot = time.time() - tb
            inherited = sh(db["id"], "cat /home/user/work/base.txt")
            result = sh(db["id"], cmd)
            return label, db["id"], boot, inherited, result

        t(f"3개로 fork -> 병렬 실행...")
        t0 = time.time()
        with ThreadPoolExecutor(max_workers=3) as ex:
            results = list(ex.map(run_branch, branches))
        t(f"  3개 전부 완료 ({time.time()-t0:.1f}s)")

        # ---------- 5. 결과 ----------
        print("\n" + "=" * 62)
        print(f"{'분기':<10}{'부팅':>7}  {'상속된 상태':<20}{'결과(data.txt 줄수)'}")
        print("-" * 62)
        for label, dbid, boot, inherited, result in results:
            ok = "✅" if "ORIGIN-STATE-1234" in inherited else "❌"
            print(f"{label:<10}{boot:>6.1f}s  {ok} {inherited.splitlines()[0]:<18}{result}")
        print("=" * 62)
        print("\n✅ = 스냅샷 시점 상태를 그대로 물려받음 (fork 성공)")
        print("   각 분기가 같은 5000줄에서 출발해 서로 다른 결과에 도달함")

    finally:
        t(f"정리: devbox {len(created)}개 종료")
        for dbid in created:
            try:
                call("POST", f"/devboxes/{dbid}/shutdown", {})
            except Exception as e:
                print(f"  종료 실패 {dbid}: {e}")


if __name__ == "__main__":
    main()
