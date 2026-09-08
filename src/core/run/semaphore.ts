import { checkAbort } from "../errors";

export class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Concurrency must be a positive integer");
  }
  async acquire(signal: AbortSignal): Promise<() => void> {
    checkAbort(signal);
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const ready = () => { signal.removeEventListener("abort", abort); resolve(); };
        const abort = () => {
          this.waiting = this.waiting.filter((item) => item !== ready);
          reject(signal.reason);
        };
        this.waiting.push(ready);
        signal.addEventListener("abort", abort, { once: true });
      });
    } else this.active++;
    if (signal.aborted) { this.release(); checkAbort(signal); }
    let released = false;
    return () => { if (!released) { released = true; this.release(); } };
  }
  private release(): void {
    const next = this.waiting.shift();
    if (next) next(); else this.active--;
  }
}
