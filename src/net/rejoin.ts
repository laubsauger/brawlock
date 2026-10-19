import { parseRoomCode } from './code'

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
  storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void } | null
}

const STORAGE_KEY = 'brawlock.lastRoom.v1'
const ENDED = 'This game has ended or is no longer available.'

/** Stored labels and routes are data, never reconnect credentials or server URLs. */
function storedTarget(raw: string): RejoinTarget | null {
  const data = JSON.parse(raw) as { version?: unknown; target?: unknown } | null
  if (!data || data.version !== 1 || !data.target || typeof data.target !== 'object') return null
  const t = data.target as Partial<RejoinTarget>
  const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value)
  if (!id(t.profileId) || !id(t.deviceId) || typeof t.code !== 'string') return null
  const code = parseRoomCode(t.code)
  if ('problem' in code || code.code !== t.code || !t.route || typeof t.route !== 'object') return null
  if (t.route.kind === 'p2p') return { profileId: t.profileId!, deviceId: t.deviceId!, code: t.code, route: { kind: 'p2p' } }
  if (t.route.kind === 'server' && typeof t.route.region === 'string' && t.route.region.length > 0 && t.route.region.length <= 64 && t.route.region.trim() === t.route.region) {
    return { profileId: t.profileId!, deviceId: t.deviceId!, code: t.code, route: { kind: 'server', region: t.route.region } }
  }
  return null
}

export class RejoinController {
  private target: RejoinTarget | null = null
  private view: RejoinView | null = null
  private epoch = 0
  private restored = false
  private readonly subs = new Set<() => void>()

  constructor(private readonly deps: RejoinDeps) {}

  /** Once on menu entry. Rediscovery is read-only; restoration never dials. */
  restore = (): void => {
    if (this.restored) return
    this.restored = true
    try {
      const raw = this.deps.storage?.getItem(STORAGE_KEY)
      if (!raw) return
      const target = storedTarget(raw)
      if (!target || !this.sameIdentity(target)) { this.dismiss(); return }
      this.target = target
      void this.refresh()
    } catch {
      // Unreadable browser storage cannot authenticate or invent a room.
      this.dismiss()
    }
  }

  get = (): RejoinView | null => this.view
  subscribe = (cb: () => void): (() => void) => {
    this.subs.add(cb)
    return () => this.subs.delete(cb)
  }

  /** A welcome completed, including a server owner whose lobby role is "host". */
  connected(target: RejoinTarget): void {
    this.restored = true
    const old = this.target
    const same = old && old.code === target.code && old.profileId === target.profileId && old.deviceId === target.deviceId && old.route.kind === target.route.kind && (old.route.kind !== 'server' || target.route.kind === 'server' && old.route.region === target.route.region)
    if (same && this.view === null) return
    this.target = { ...target, route: { ...target.route } }
    this.persist()
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
    this.restored = true
    this.epoch++
    this.target = null
    this.persist()
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
      this.set({ code: t.code, kind: t.route.kind, status: exists ? 'available' : 'unavailable', error: exists ? null : ENDED })
    } catch (e) {
      if (this.current(t, epoch)) this.set({ code: t.code, kind: t.route.kind, status: 'unavailable', error: message(e) })
    }
  }

  join = async (): Promise<void> => {
    const t = this.target
    if (!t || this.view?.status !== 'available') return
    if (!this.sameIdentity(t)) { this.dismiss(); return }
    const epoch = ++this.epoch
    this.set({ code: t.code, kind: t.route.kind, status: 'joining', error: null })
    try {
      // A previously visible room may have gone away before the player clicks.
      if (!await this.deps.exists(t)) {
        if (this.current(t, epoch)) this.set({ code: t.code, kind: t.route.kind, status: 'unavailable', error: ENDED })
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

  private persist(): void {
    try {
      this.deps.storage?.setItem(STORAGE_KEY, this.target ? JSON.stringify({ version: 1, target: this.target }) : '')
    } catch {
      // Browser storage may be blocked; the accepted room remains in memory.
    }
  }
}

const message = (e: unknown) => e instanceof Error ? e.message : String(e)
