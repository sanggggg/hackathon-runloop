export class Semaphore {
  readonly limit: number;
  #available: number;
  #queue: Array<(release: () => void) => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("maxConcurrency must be a positive integer");
    this.limit = limit;
    this.#available = limit;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));

    return new Promise<() => void>((resolve, reject) => {
      let queued = false;
      const grant = (release: () => void): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve(release);
      };
      const onAbort = (): void => {
        if (queued) this.#queue = this.#queue.filter((entry) => entry !== grant);
        reject(signal?.reason ?? new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      // AbortSignal does not replay an already-fired event to a newly-added
      // listener. Recheck after registration so a queued acquire cannot hang
      // if cancellation lands at the check/listen boundary.
      if (signal?.aborted) {
        onAbort();
        return;
      }

      if (this.#available > 0) {
        this.#available -= 1;
        grant(this.#makeRelease());
      } else {
        queued = true;
        this.#queue.push(grant);
      }
    });
  }

  #makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#queue.shift();
      if (next) next(this.#makeRelease());
      else this.#available += 1;
    };
  }
}
