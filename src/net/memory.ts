/**
 * In-memory transport for tests and offline experiments: two linked endpoints
 * with optional latency, jitter and loss on the unreliable path. Timing uses
 * setTimeout, so vitest fake timers drive it deterministically.
 */
import { newRoomCode } from './code'
import { BaseTransport, type HostEndpoint, type NetFactory, type Transport } from './transport'

export interface LinkOptions {
  /** one-way latency, ms */
  latencyMs?: number
  /** extra random one-way delay on the unreliable path, 0..jitterMs */
  jitterMs?: number
  /** 0..1 drop probability per unreliable frame */
  loss?: number
  /** false simulates a raw channel that never opens (tests the reliable fallback) */
  rawWorks?: boolean
  /** seed for loss / jitter */
  seed?: number
}

/** mulberry32: small seeded PRNG so lossy tests are reproducible */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class MemoryTransport extends BaseTransport {
  peer: MemoryTransport | null = null
  /** frames sent on each path, for tests */
  sent = { reliable: 0, unreliable: 0, dropped: 0 }
  private lastReliableAt = 0
  private readonly opts: Required<Omit<LinkOptions, 'seed'>>
  private readonly rand: () => number

  constructor(opts: LinkOptions, rand: () => number) {
    super()
    this.opts = {
      latencyMs: opts.latencyMs ?? 0,
      jitterMs: opts.jitterMs ?? 0,
      loss: opts.loss ?? 0,
      rawWorks: opts.rawWorks ?? true,
    }
    this.rand = rand
  }

  /** @internal called by createMemoryPair once both ends exist */
  begin(): void {
    this.start()
  }

  protected rawReliable(data: string): void {
    const peer = this.peer
    if (!peer) return
    this.sent.reliable++
    // ordered: never deliver before the previous reliable frame
    const at = Math.max(performance.now() + this.opts.latencyMs, this.lastReliableAt)
    this.lastReliableAt = at
    setTimeout(() => peer.deliver(data, false), at - performance.now())
  }

  protected rawUnreliable(data: string): boolean {
    const peer = this.peer
    if (!peer || !this.opts.rawWorks) return false
    this.sent.unreliable++
    if (this.rand() < this.opts.loss) {
      this.sent.dropped++
      return true
    }
    const delay = this.opts.latencyMs + this.rand() * this.opts.jitterMs
    setTimeout(() => peer.deliver(data, true), delay)
    return true
  }

  protected shutdown(): void {
    const peer = this.peer
    this.peer = null
    if (peer) setTimeout(() => peer.hangup(), this.opts.latencyMs)
  }

  private deliver(data: string, viaRaw: boolean): void {
    this.receive(data, viaRaw)
  }

  private hangup(): void {
    this.remoteClosed('closed')
  }
}

export function createMemoryPair(opts: LinkOptions = {}): [MemoryTransport, MemoryTransport] {
  const rand = mulberry32(opts.seed ?? 1)
  const a = new MemoryTransport(opts, rand)
  const b = new MemoryTransport(opts, rand)
  a.peer = b
  b.peer = a
  a.begin()
  b.begin()
  return [a, b]
}

/**
 * In-memory NetFactory: host() registers a room code, join(code) links to it
 * after one latency. Every link gets the same options.
 */
export function createMemoryNet(opts: LinkOptions = {}): NetFactory {
  const hosts = new Map<string, (t: Transport) => void>()
  let seed = opts.seed ?? 1
  const codeRand = mulberry32(seed + 1000)
  return {
    async host(): Promise<HostEndpoint> {
      let id = newRoomCode((n) => Math.floor(codeRand() * n))
      while (hosts.has(id)) id = newRoomCode((n) => Math.floor(codeRand() * n))
      let listener: ((t: Transport) => void) | null = null
      const backlog: Transport[] = []
      hosts.set(id, (t) => (listener ? listener(t) : backlog.push(t)))
      return {
        id,
        onConnection(cb) {
          listener = cb
          for (const t of backlog.splice(0)) cb(t)
        },
        close() {
          hosts.delete(id)
        },
      }
    },
    join(code: string): Promise<Transport> {
      const accept = hosts.get(code)
      if (!accept) return Promise.reject(new Error('No room with that code.'))
      const [client, host] = createMemoryPair({ ...opts, seed: seed++ })
      return new Promise((resolve) => {
        setTimeout(() => {
          accept(host)
          resolve(client)
        }, opts.latencyMs ?? 0)
      })
    },
  }
}
