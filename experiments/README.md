# Experiments

Each script proves one thing and cleans up after itself. Python stdlib only —
no `pip install` needed on the host. Run them from the repo root.

```bash
export RUNLOOP_API_KEY=...
export OPENROUTER_API_KEY=...   # branch_race.py only
```

---

### `fork_test.py` — does a fork inherit disk state?

Creates a devbox, writes files, snapshots, forks three ways, and checks each
fork can still read what the parent wrote.

**Result:** yes. Snapshot 3.4s, fork boot 2.6s, and three forks in parallel take
the same wall clock as one.

---

### `branch_race.py` — the whole loop, on code

A local agent loop (OpenRouter) drives a devbox as its hands. It explores a
buggy Python module, snapshots mid-run, then forks three ways with different
strategy hints and races them on `pytest`.

**Result:** 65s end to end, ~$0.15. Note the shared prefix is walked once, not
three times — that is the saving the product is built on.

Change the model with `MODEL=anthropic/claude-haiku-4.5`.

---

### `flowmap_test.py` — does a login session survive a fork?

The hard one. Serves a small wizard app inside the devbox, signs in with a real
browser, snapshots, forks three ways and checks each fork is still
authenticated before taking a different path.

**Result:** yes, but only via `storage_state`. A cookie with no expiry lives in
memory, not in the browser profile — relaunching from the profile directory
after a fork logs you out. The first version of this script failed exactly that
way. See trap 01 in the spec.

---

### `shot_test.py` — screenshots out of the box

Captures every page along a path and downloads the PNGs to the host.

**Result:** ~10KB per shot at 264px. Note `download_file` takes `path`, relative
to home — not `file_path`, not absolute.

---

### `capture_shots.py` — build the demo app and shoot it

Serves two versions of *Nimbus*, a small SaaS onboarding flow: `v1` where every
path works, and `v2` where a control is renamed, two paths error out and a new
option appears. Walks both and downloads 13 screenshots.

These are the images in `design/shots/`, and the `APP` string in this file is
the starting point for the real demo repo.

---

## Gotchas these scripts encode

1. **Session cookies** are not in the browser profile — dump and restore
   `storage_state` around the snapshot.
2. **A disk snapshot carries no processes** — restart the app in every fork.
3. **`execute_sync` is deprecated**, and backgrounding a process with `&` hangs
   the API call because the output pipe stays open. Use `execute_async`.
4. **`download_file`** wants `{"path": "relative/to/home"}`.
5. **pip needs sudo, the browser binary must not have it** — installing
   Chromium as root hides it in `/root/.cache` where the devbox user cannot
   find it.
