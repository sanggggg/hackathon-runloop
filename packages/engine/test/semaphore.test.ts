import assert from "node:assert/strict";
import test from "node:test";
import { Semaphore } from "../src/semaphore.js";

test("a cancelled queued acquire is removed without consuming the next permit", async () => {
  const semaphore = new Semaphore(1);
  const releaseFirst = await semaphore.acquire();
  const controller = new AbortController();
  const reason = new Error("cancel branch");
  const cancelled = semaphore.acquire(controller.signal);

  controller.abort(reason);
  await assert.rejects(cancelled, (error: unknown) => error === reason);
  releaseFirst();

  const releaseNext = await semaphore.acquire();
  releaseNext();
  releaseNext();
});

test("an already-aborted acquire rejects immediately", async () => {
  const semaphore = new Semaphore(1);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(semaphore.acquire(controller.signal), /abort/i);
});
