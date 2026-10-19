/**
 * Host side of a player-hosted room's public listing (listings.ts): keeps the listing
 * on the game server in step with what the room wants. `want(x)` sets the target (a
 * region and the room's current info, or null = not listed) and the lister creates,
 * heartbeats, moves or removes the listing to match. Requests never overlap; an info
 * change is sent at once, but no more than one heartbeat per MIN_BEAT_MS. A failure
 * retries after RETRY_MS and shows in state() ('error'), it never throws.
 */
import type { ListingInfo } from './listings'
import { ServerError, type Online } from './online'
import type { MatchSettings, PlayerSlot } from '../sim/types'
import type { RoomProgress } from './roomProgress'

const MIN_BEAT_MS = 2000
const RETRY_MS = 15_000

export interface ListerState {
  /** off: not listed (and not wanted); pending: being listed; listed: in Browse games; error: the last try failed */
  status: 'off' | 'pending' | 'listed' | 'error'
  /** region of the listing (or of the last try) */
  region: string | null
  error: string | null
}

export interface ListerTimers {
  now(): number
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: ListerTimers = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

type Target = { region: string; info: ListingInfo }

/** Public P2P rooms remain discoverable even with every seat occupied by bots or humans. */
export function p2pListingTarget(input: {
  listed: { code: string; region: string } | null
  role: string
  status: string
  code: string | null
  public: boolean
  transport: 'server' | 'p2p' | null
  slots: readonly Pick<PlayerSlot, 'kind'>[]
  settings: MatchSettings
  screen: string
  host: string
  max: number
  joinable: number
  progress?: RoomProgress | null
}): Target | null {
  const { listed } = input
  if (!listed || !input.public || input.role !== 'host' || input.status !== 'open' || input.code !== listed.code || input.transport !== 'p2p') return null
  const humans = input.slots.filter((slot) => slot.kind === 'human').length
  return {
    region: listed.region,
    info: {
      code: listed.code, host: input.host, humans, bots: input.slots.length - humans, max: input.max, joinable: input.joinable,
      phase: input.screen === 'match' ? 'match' : input.screen === 'results' ? 'results' : 'lobby',
      progress: input.screen === 'match' || input.screen === 'results' ? input.progress ?? null : null,
      teamMode: input.settings.teamMode, gameMode: input.settings.gameMode, winScore: input.settings.winScore,
    },
  }
}

export class Lister {
  private target: Target | null = null
  private current: { region: string; id: string; token: string; sent: string; at: number; every: number } | null = null
  private st: ListerState = { status: 'off', region: null, error: null }
  private running = false
  private again = false
  private timer: unknown = null
  private readonly subs = new Set<() => void>()

  constructor(
    private readonly online: Online,
    private readonly timers: ListerTimers = realTimers,
  ) {}

  /** The listing the room wants now: listed on `region` with `info`, or null (unlisted). */
  want(next: Target | null): void {
    this.target = next
    void this.sync()
  }

  state(): ListerState {
    return { ...this.st }
  }

  subscribe(cb: () => void): () => void {
    this.subs.add(cb)
    return () => this.subs.delete(cb)
  }

  private set(next: ListerState): void {
    if (next.status === this.st.status && next.region === this.st.region && next.error === this.st.error) return
    this.st = next
    for (const cb of this.subs) cb()
  }

  private schedule(ms: number): void {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = this.timers.set(() => {
      this.timer = null
      void this.sync()
    }, ms)
  }

  private async sync(): Promise<void> {
    if (this.running) {
      this.again = true
      return
    }
    this.running = true
    try {
      do {
        this.again = false
        await this.step()
      } while (this.again)
    } finally {
      this.running = false
    }
  }

  private async step(): Promise<void> {
    const t = this.target
    const cur = this.current
    // unlist: not wanted, or wanted on another region
    if (cur && (!t || t.region !== cur.region)) {
      this.current = null
      await this.online.unlistRoom(cur.region, cur.id, cur.token)
      if (!t) {
        if (this.timer !== null) this.timers.clear(this.timer)
        this.timer = null
        this.set({ status: 'off', region: null, error: null })
        return
      }
    }
    if (!t) {
      if (this.st.status !== 'off') this.set({ status: 'off', region: null, error: null })
      return
    }
    const info = JSON.stringify(t.info)
    const now = this.timers.now()
    try {
      if (!this.current) {
        this.set({ status: 'pending', region: t.region, error: null })
        const r = await this.online.listRoom(t.region, t.info)
        if (this.target !== t && this.target?.region !== t.region) {
          // unwanted meanwhile: the next pass removes it
          this.current = { region: t.region, id: r.id, token: r.token, sent: info, at: now, every: r.heartbeatMs }
          this.again = true
          return
        }
        this.current = { region: t.region, id: r.id, token: r.token, sent: info, at: this.timers.now(), every: r.heartbeatMs }
        this.set({ status: 'listed', region: t.region, error: null })
        this.schedule(r.heartbeatMs)
        return
      }
      const c = this.current
      const due = now - c.at >= c.every - 50
      if (info === c.sent && !due) {
        this.schedule(c.every - (now - c.at))
        return
      }
      if (!due && now - c.at < MIN_BEAT_MS) {
        this.schedule(MIN_BEAT_MS - (now - c.at))
        return
      }
      const res = await this.online.beatListing(c.region, c.id, c.token, t.info)
      if (res === 'gone') {
        // expired (a server restart, a long sleep): list again
        this.current = null
        this.again = true
        return
      }
      c.sent = info
      c.at = this.timers.now()
      this.set({ status: 'listed', region: c.region, error: null })
      this.schedule(c.every)
    } catch (e) {
      // refused (not just unreachable): the listing is no good, the retry lists anew
      if (this.current && e instanceof ServerError && e.reason !== 'unavailable') this.current = null
      this.set({ status: 'error', region: t.region, error: e instanceof Error ? e.message : String(e) })
      this.schedule(RETRY_MS)
    }
  }
}
