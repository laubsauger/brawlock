/**
 * Rate limits for the dedicated server (M4.1): token buckets per key (IP, connection).
 * Pure and clock-injected so the limits are unit-tested without sockets.
 */

export class TokenBucket {
  private tokens: number
  private last: number

  /** `capacity` tokens, refilled at `perSecond`. */
  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
    now: number,
  ) {
    this.tokens = capacity
    this.last = now
  }

  /** Take `n` tokens if available. */
  take(now: number, n = 1): boolean {
    const dt = Math.max(0, now - this.last) / 1000
    this.last = now
    this.tokens = Math.min(this.capacity, this.tokens + dt * this.perSecond)
    if (this.tokens < n) return false
    this.tokens -= n
    return true
  }

  /** Full again (idle long enough to forget). */
  idle(now: number): boolean {
    return this.tokens + (Math.max(0, now - this.last) / 1000) * this.perSecond >= this.capacity
  }
}

/** One bucket per key, idle buckets dropped. */
export class KeyedLimiter {
  private buckets = new Map<string, TokenBucket>()

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
  ) {}

  take(key: string, now: number, n = 1): boolean {
    let b = this.buckets.get(key)
    if (!b) this.buckets.set(key, (b = new TokenBucket(this.capacity, this.perSecond, now)))
    return b.take(now, n)
  }

  /** Forget buckets that refilled (call now and then). */
  sweep(now: number): void {
    for (const [k, b] of this.buckets) if (b.idle(now)) this.buckets.delete(k)
  }

  get size(): number {
    return this.buckets.size
  }
}
