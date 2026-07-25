/**
 * A minimal FIFO counting semaphore. Bounds how many async operations run at
 * once (e.g. concurrent Oracle SOAP / REST calls), no matter how many callers
 * fan out — so we get parallel throughput without overwhelming a downstream
 * service. Fair: waiters are released in arrival order.
 */
export class Semaphore {
  private inFlight = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly permits: number) {}

  get limit(): number {
    return this.permits;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.inFlight < this.permits) {
      this.inFlight += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      // Hand the permit straight to the next waiter (inFlight stays the same).
      next();
    } else {
      this.inFlight -= 1;
    }
  }
}
