export type PlayMode = 'local' | 'practice' | 'host' | 'p2p' | 'join' | 'server' | 'casual' | 'ranked'
export interface PlayTarget { mode: PlayMode; region: string | null; code: string | null }
export interface PlayConflict { id: string; target: PlayTarget; kind: 'device' | 'account'; sameAccount: boolean }
interface Lease { token: string; deadline: number }
interface Intent { target: PlayTarget; retry: () => Promise<unknown>; conflict: PlayConflict }
export interface PlayControlDeps {
  enabled: boolean
  now(): number
  request(body: object, keepalive?: boolean): Promise<{ ok: boolean; token?: string; expiresAt?: number; serverTime?: number; conflict?: PlayConflict }>
  lock(wait: boolean): Promise<(() => void) | null>
  localTarget(): PlayTarget
  publish(target: PlayTarget | null): void
  listen(yieldGame: () => void): () => void
  yieldOthers(): void
  every(fn: () => void, ms: number): unknown
  cancel(timer: unknown): void
  delay(ms: number): Promise<void>
  lost(message: string): void
  conflict(value: PlayConflict | null): void
  resume(target: PlayTarget): Promise<unknown>
}

/** Browser lock plus shared authority permission. A successor waits until the owner stops. */
export class PlayControl {
  private releaseLock: (() => void) | null = null
  private lease: Lease | null = null
  private target: PlayTarget | null = null
  private timer: unknown = null
  private unlisten: (() => void) | null = null
  private pending: Intent | null = null
  private renewal: Promise<void> | null = null
  private epoch = 0
  private losing = false
  private releasing: Promise<void> | null = null
  constructor(private readonly deps: PlayControlDeps) {}

  token(): string {
    if (!this.valid() || !this.lease) throw new Error('Open one game before connecting to a server.')
    return this.lease.token
  }

  valid(): boolean {
    if (!this.releaseLock || this.losing) return false
    if (this.deps.enabled && (!this.lease || this.deps.now() >= this.lease.deadline)) {
      this.lose('Your game permission expired. Reconnect from the menu to continue.')
      return false
    }
    return true
  }

  private accept(reply: Awaited<ReturnType<PlayControlDeps['request']>>, started: number) {
    if (!Number.isFinite(reply.expiresAt) || !Number.isFinite(reply.serverTime) || reply.expiresAt! <= reply.serverTime!) throw new Error('Invalid game permission from the account service.')
    if (reply.token !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(reply.token)) throw new Error('Invalid game permission token.')
    const token = reply.token ?? this.lease?.token
    if (!token) throw new Error('Missing game permission token.')
    this.lease = { token, deadline: started + reply.expiresAt! - reply.serverTime! - 1000 }
  }

  async acquire(target: PlayTarget, retry: () => Promise<unknown>): Promise<boolean> {
    if (this.releasing) await this.releasing
    const epoch = this.epoch
    if (this.releaseLock && this.valid()) { await this.update(target); return epoch === this.epoch && this.valid() }
    const unlock = await this.deps.lock(false)
    if (epoch !== this.epoch) { unlock?.(); return false }
    if (!unlock) {
      const conflict: PlayConflict = { id: 'local', target: this.deps.localTarget(), kind: 'device', sameAccount: false }
      this.pending = { target, retry, conflict }; this.deps.conflict(conflict)
      return false
    }
    this.releaseLock = unlock; this.target = target; this.deps.publish(target)
    try {
      if (this.deps.enabled) {
        const started = this.deps.now(), reply = await this.deps.request({ action: 'acquire', target })
        if (epoch !== this.epoch) { if (reply.token) await this.deps.request({ action: 'release', token: reply.token }); return false }
        if (!reply.ok) {
          if (!reply.conflict) throw new Error('Could not check your existing game.')
          await this.release()
          this.pending = { target, retry, conflict: reply.conflict }; this.deps.conflict(reply.conflict)
          return false
        }
        this.accept(reply, started)
      }
      this.watch()
      return true
    } catch (error) { if (epoch === this.epoch) await this.release(); throw error }
  }

  private watch() {
    const epoch = this.epoch
    this.unlisten = this.deps.listen(() => this.lose('Your game was moved to another tab or device.'))
    if (this.deps.enabled) this.timer = this.deps.every(() => { void this.renew().catch(() => { if (epoch === this.epoch) this.lose('The game service is unreachable. Reconnect from the menu.') }) }, 10000)
  }

  private async renew(): Promise<void> {
    while (this.renewal) await this.renewal
    const lease = this.lease, target = this.target, epoch = this.epoch
    if (!lease || !target) return
    const started = this.deps.now()
    this.renewal = (async () => {
      const reply = await this.deps.request({ action: 'heartbeat', token: lease.token, target })
      if (epoch !== this.epoch) return
      if (!reply.ok) { this.lose('Your game was moved to another tab or device.'); return }
      this.accept(reply, started)
    })()
    try { await this.renewal } finally { this.renewal = null }
  }

  async update(target: PlayTarget): Promise<void> {
    const epoch = this.epoch
    const changed = JSON.stringify(target) !== JSON.stringify(this.target)
    this.target = target
    if (!this.releaseLock || !changed) return
    this.deps.publish(target)
    if (changed && this.deps.enabled) {
      try { await this.renew() } catch (error) { if (epoch === this.epoch) throw error }
    }
  }

  async release(): Promise<void> {
    this.epoch++
    const lease = this.lease
    this.lease = null; this.target = null
    if (this.timer !== null) this.deps.cancel(this.timer)
    this.timer = null; this.unlisten?.(); this.unlisten = null
    this.deps.publish(null)
    this.releaseLock?.(); this.releaseLock = null
    if (lease) {
      const work = this.deps.request({ action: 'release', token: lease.token }, true).then(() => {})
      this.releasing = work
      try { await work } finally { if (this.releasing === work) this.releasing = null }
    }
  }

  private lose(message: string) {
    if (!this.releaseLock || this.losing) return
    this.losing = true
    try { this.deps.lost(message) } // Stop clocks and connections synchronously, before releasing permission.
    finally { void this.release().catch(() => {}); this.losing = false } // Failed acknowledgement stays reserved until expiry.
  }

  dismiss() { this.pending = null; this.deps.conflict(null) }

  async takeover(): Promise<void> {
    const intent = this.pending
    if (!intent) throw new Error('No game transfer is pending.')
    const existing = intent.conflict.target
    const resume = existing.region && existing.code && ['server', 'casual', 'ranked', 'join'].includes(existing.mode)
    const target = resume ? existing : intent.target
    this.deps.yieldOthers()
    if (this.deps.enabled && intent.conflict.id !== 'local') await this.deps.request({ action: 'takeover', id: intent.conflict.id })
    const epoch = this.epoch, unlock = await this.deps.lock(true)
    if (!unlock) throw new Error('Close the other game tab, then try Use here again.')
    if (epoch !== this.epoch) { unlock(); return }
    this.releaseLock = unlock; this.target = target; this.deps.publish(target)
    try {
      if (this.deps.enabled) {
        const until = this.deps.now() + 35000
        for (;;) {
          const started = this.deps.now(), reply = await this.deps.request({ action: 'acquire', target })
          if (epoch !== this.epoch) { if (reply.token) await this.deps.request({ action: 'release', token: reply.token }); return }
          if (reply.ok) { this.accept(reply, started); break }
          if (!reply.conflict) throw new Error('Could not move your game.')
          await this.deps.request({ action: 'takeover', id: reply.conflict.id })
          if (this.deps.now() >= until) throw new Error('The other game has not stopped yet. Close it and try again.')
          await this.deps.delay(300)
        }
      }
      this.watch(); this.pending = null; this.deps.conflict(null)
      await (resume ? this.deps.resume(existing) : intent.retry())
    } catch (error) { if (epoch === this.epoch) await this.release(); throw error }
  }
}
