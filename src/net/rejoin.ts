/** A disconnected client can rediscover and explicitly rejoin its original room. */
export type RoomRoute = { kind: 'p2p' } | { kind: 'server'; region: string }
export interface RejoinIdentity { profileId: string; deviceId: string }
export interface RejoinTarget extends RejoinIdentity { code: string; route: RoomRoute }
export interface RejoinView {
  code: string
  kind: RoomRoute['kind']
  status: 'checking' | 'available' | 'unavailable' | 'joining'
  error: string | null
}

interface RejoinDeps {
  identity(): RejoinIdentity
  exists(target: RejoinTarget): Promise<boolean>
  join(target: RejoinTarget): Promise<{ ok: boolean; error?: string }>
}

export class RejoinController {
  private target: RejoinTarget | null = null
  private view: RejoinView | null = null
  private epoch = 0
  private readonly subs = new Set<() => void>()

  constructor(private readonly deps: RejoinDeps) {}

  get = (): RejoinView | null => this.view
  subscribe = (cb: () => void): (() => void) => {
    this.subs.add(cb)
    return () => this.subs.delete(cb)
  }

  /** A welcome completed, including a server owner whose lobby role is "host". */
  connected(target: RejoinTarget): void {
    this.target = { ...target, route: { ...target.route } }
    if (this.view !== null) {
      this.epoch++
      this.set(null)
    }
  }

  disconnected(): void {
    if (!this.target || !this.sameIdentity(this.target)) return
    void this.refresh()
  }

  dismiss = (): void => {
    this.epoch++
    this.target = null
    this.set(null)
  }

  refresh = async (): Promise<void> => {
    const t = this.target
    if (!t || !this.sameIdentity(t)) { this.dismiss(); return }
    const epoch = ++this.epoch
    this.set({ code: t.code, kind: t.route.kind, status: 'checking', error: null })
    try {
      const exists = await this.deps.exists(t)
      if (!this.current(t, epoch)) return
      this.set({ code: t.code, kind: t.route.kind, status: exists ? 'available' : 'unavailable', error: exists ? null : 'This game could not be found. Try refreshing.' })
    } catch (e) {
      if (this.current(t, epoch)) this.set({ code: t.code, kind: t.route.kind, status: 'unavailable', error: message(e) })
    }
  }

  join = async (): Promise<void> => {
    const t = this.target
    if (!t || this.view?.status !== 'available' || !this.sameIdentity(t)) return
    const epoch = ++this.epoch
    this.set({ code: t.code, kind: t.route.kind, status: 'joining', error: null })
    try {
      // A previously visible room may have gone away before the player clicks.
      if (!await this.deps.exists(t)) {
        if (this.current(t, epoch)) this.set({ code: t.code, kind: t.route.kind, status: 'unavailable', error: 'This game could not be found. Try refreshing.' })
        return
      }
      if (!this.current(t, epoch)) return
      const result = await this.deps.join(t)
      if (!this.current(t, epoch)) return
      if (result.ok) this.set(null)
      else this.set({ code: t.code, kind: t.route.kind, status: 'available', error: result.error ?? 'Could not reconnect to this game.' })
    } catch (e) {
      if (this.current(t, epoch)) this.set({ code: t.code, kind: t.route.kind, status: 'unavailable', error: message(e) })
    }
  }

  private sameIdentity(t: RejoinTarget): boolean {
    const identity = this.deps.identity()
    return t.profileId === identity.profileId && t.deviceId === identity.deviceId
  }

  private current(t: RejoinTarget, epoch: number): boolean {
    if (this.epoch !== epoch || this.target !== t) return false
    if (!this.sameIdentity(t)) { this.dismiss(); return false }
    return true
  }

  private set(view: RejoinView | null): void {
    this.view = view
    for (const cb of this.subs) cb()
  }
}

const message = (e: unknown) => e instanceof Error ? e.message : String(e)
