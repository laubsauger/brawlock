/**
 * Transport: one bidirectional link between host and one client.
 *
 * Two paths:
 * - reliable: ordered, retransmitted (PeerJS DataConnection). Lobby, start, end.
 * - unreliable: unordered, no retransmit (raw pre-negotiated RTCDataChannel
 *   `{ ordered: false, maxRetransmits: 0 }`). Inputs, snapshots.
 *
 * The unreliable path starts in 'pending' mode and only switches to 'raw' once a
 * probe made a round trip over the raw channel (proves both sides created it).
 * Until then, and if that never happens within RAW_TIMEOUT_MS, unreliable sends
 * ride the reliable channel ('reliable' fallback), so nothing is lost at startup.
 *
 * Transport control frames start with '#' ('#p<t>' ping, '#q<t>' pong) and never
 * reach the app; they measure RTT on the unreliable path and keep the link alive.
 * App messages are JSON objects (see protocol.ts), so they never start with '#'.
 */

export type UnreliableMode = 'pending' | 'raw' | 'reliable'

export interface Transport {
  /** Server-only metadata: undefined for P2P/dev; null is an authenticated guest channel. */
  readonly account?: import('./accounts').VerifiedAccount | null
  /** Ordered and retransmitted. */
  sendReliable(data: string): void
  /** Unordered, may be dropped. Falls back to the reliable channel unless mode is 'raw'. */
  sendUnreliable(data: string): void
  /** Subscribe to app messages (control frames are filtered). Returns unsubscribe. */
  onMessage(cb: (data: string) => void): () => void
  /** Fires once when the remote side closes or the link times out. Not fired by a local close(). */
  onClose(cb: (reason: string) => void): () => void
  /** Close locally. Queued reliable messages get a short grace period to flush. */
  close(): void
  /** Dedicated transport: preserve the destination briefly before an explicit controller transfer. */
  prepareHandoff?(): void
  /** Smoothed round trip on the unreliable path, ms. 0 until the first pong. */
  readonly rtt: number
  /** Latest RTT sample, ms. 0 until the first pong. */
  readonly rttLast: number
  /** Mean deviation of RTT samples from the smoothed RTT, ms. */
  readonly rttJitter: number
  readonly unreliableMode: UnreliableMode
  readonly open: boolean
}

/** Host side: accepts incoming links. */
export interface HostEndpoint {
  /** room code clients pass to NetFactory.join (see code.ts) */
  readonly id: string
  onConnection(cb: (t: Transport) => void): void
  close(): void
}

/** Creates hosts and joins. PeerJS in the browser, in-memory in tests. */
export interface NetFactory {
  host(): Promise<HostEndpoint>
  /**
   * Dial a room by its normalized code. Resolves with an open link; `onStatus`
   * gets friendly progress (retries). Rejects with a friendly message.
   */
  join(code: string, onStatus?: (msg: string) => void): Promise<Transport>
}

export const RAW_TIMEOUT_MS = 3000
/** probe cadence while the raw channel is unproven, then for RTT / keepalive */
const PROBE_FAST_MS = 100
const PROBE_SLOW_MS = 500
/** no frame of any kind for this long = link dead (probes flow every 500 ms) */
export const LINK_TIMEOUT_MS = 12000

export abstract class BaseTransport implements Transport {
  rtt = 0
  rttLast = 0
  rttJitter = 0
  unreliableMode: UnreliableMode = 'pending'
  open = true

  private msgCbs: ((data: string) => void)[] = []
  private closeCbs: ((reason: string) => void)[] = []
  /** messages that arrived before anyone subscribed */
  private early: string[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  /** current poll period: the probe cadence of the mode (a server socket is slow from the start) */
  private pollMs = 0
  private startedAt = 0
  private lastRecv = 0
  private lastProbe = -Infinity

  /** Send on the reliable channel. */
  protected abstract rawReliable(data: string): void
  /** Send on the raw unreliable channel. Returns false if that channel is not usable. */
  protected abstract rawUnreliable(data: string): boolean
  /** Release the underlying channels. */
  protected abstract shutdown(): void

  /** Subclasses call this once their reliable channel is open. */
  protected start(): void {
    this.startedAt = performance.now()
    this.lastRecv = this.startedAt
    this.pollAt(this.unreliableMode === 'pending' ? PROBE_FAST_MS : PROBE_SLOW_MS)
    this.poll()
  }

  sendReliable(data: string): void {
    if (this.open) this.rawReliable(data)
  }

  sendUnreliable(data: string): void {
    if (!this.open) return
    if (this.unreliableMode === 'raw') {
      if (this.rawUnreliable(data)) return
      // raw channel died under us: fall back for good
      this.unreliableMode = 'reliable'
    }
    this.rawReliable(data)
  }

  onMessage(cb: (data: string) => void): () => void {
    this.msgCbs.push(cb)
    if (this.early.length) {
      const queued = this.early.splice(0)
      for (const d of queued) cb(d)
    }
    return () => {
      this.msgCbs = this.msgCbs.filter((c) => c !== cb)
    }
  }

  onClose(cb: (reason: string) => void): () => void {
    this.closeCbs.push(cb)
    return () => {
      this.closeCbs = this.closeCbs.filter((c) => c !== cb)
    }
  }

  close(): void {
    if (!this.open) return
    this.open = false
    this.stopTimer()
    this.shutdown()
  }

  /** Subclasses feed every received frame here. */
  protected receive(data: string, viaRaw: boolean): void {
    if (!this.open) return
    const now = performance.now()
    this.lastRecv = now
    if (data.charCodeAt(0) === 35 /* '#' */) {
      const kind = data[1]
      const rest = data.slice(2)
      if (kind === 'p') {
        const pong = '#q' + rest
        if (viaRaw) this.rawUnreliable(pong)
        else this.rawReliable(pong)
      } else if (kind === 'q') {
        const sample = now - Number(rest)
        if (Number.isFinite(sample) && sample >= 0) {
          if (this.rtt !== 0) this.rttJitter = this.rttJitter * 0.8 + Math.abs(sample - this.rtt) * 0.2
          this.rtt = this.rtt === 0 ? sample : this.rtt * 0.8 + sample * 0.2
          this.rttLast = sample
        }
        if (viaRaw && this.unreliableMode !== 'raw') this.unreliableMode = 'raw'
      }
      return
    }
    if (this.msgCbs.length === 0) {
      if (this.early.length < 256) this.early.push(data)
      return
    }
    for (const cb of this.msgCbs) cb(data)
  }

  /** Subclasses call this when the remote side is gone. */
  protected remoteClosed(reason: string): void {
    if (!this.open) return
    this.open = false
    this.stopTimer()
    this.shutdown()
    for (const cb of this.closeCbs) cb(reason)
  }

  /** The raw channel closed while the link lives on: use the reliable channel. */
  protected rawLost(): void {
    if (this.unreliableMode !== 'reliable') this.unreliableMode = 'reliable'
  }

  private poll(): void {
    if (!this.open) return
    const now = performance.now()
    if (now - this.lastRecv > LINK_TIMEOUT_MS) {
      this.remoteClosed('timeout')
      return
    }
    if (this.unreliableMode === 'pending' && now - this.startedAt > RAW_TIMEOUT_MS) {
      this.unreliableMode = 'reliable'
    }
    const every = this.unreliableMode === 'pending' ? PROBE_FAST_MS : PROBE_SLOW_MS
    // poll only as often as the probes need: 10 timer callbacks a second per connection
    // were a measurable cost on a server with hundreds of them
    if (every !== this.pollMs) this.pollAt(every)
    if (now - this.lastProbe < every - 1) return
    this.lastProbe = now
    const probe = '#p' + now
    // always probe the raw channel: it may come up late, and a pong over it proves it
    const rawOk = this.rawUnreliable(probe)
    // keep RTT and keepalive flowing while raw is not (yet) proven
    if (this.unreliableMode !== 'raw' || !rawOk) this.rawReliable(probe)
  }

  private pollAt(ms: number): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.pollMs = ms
    this.timer = setInterval(() => this.poll(), ms)
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }
}
