/**
 * Client side of the dedicated game servers (M4.1 / M4.3, docs/M4.md §11-12): one server
 * per region, each probed over HTTP(S) `/health` for round-trip time, health and version;
 * room creation and lookup, the public room browser, quick play, the leaderboard; and the
 * hybrid NetFactory that joins a code on whichever region holds that room, and
 * peer-to-peer otherwise.
 *
 * Regions come from the build (VITE_GAME_SERVERS, a JSON list, or VITE_GAME_SERVER as
 * a one-region shorthand) or `?server=` (testing): see parseRegions. Adding a region is
 * config only.
 *
 * Joining by code: every region that is up is asked `GET /rooms/:code` in parallel (no
 * region prefix in codes, so links stay short and a region can be added or removed
 * without changing codes). Two regions holding the same random code at the same time is
 * a 1 in millions event; the lower ping wins then.
 *
 * Everything is cached and time-boxed, so peer-to-peer play never waits long on a server
 * that is down, far away or on another netcode.
 */
import { PROTOCOL_VERSION } from './protocol'
import type { HostEndpoint, NetFactory, Transport } from './transport'
import type { RoomSummary } from './dedicated'
import type { Period, PublicBoardRow } from './leaderboard'
import type { BotDifficulty } from '../sim/types'

/** one request; the first probe of a region takes COLD_SAMPLES of them back to back */
const REQUEST_TIMEOUT_MS = 2500
const COLD_SAMPLES = 3
/** recent samples kept per region; rttMs is their median */
const SAMPLE_WINDOW = 5
/** probe() answers from cache when the last probe is this recent */
const PROBE_MAX_AGE_MS = 2000
/** routing (join lookup, room creation) trusts a probe this long */
const ROUTE_TTL_UP_MS = 20_000
const ROUTE_TTL_DOWN_MS = 8_000

type FetchLike = (url: string, init?: { method?: string; signal?: AbortSignal; cache?: 'no-store' }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/** A configured game server. */
export interface ServerRegion {
  /** stable id, e.g. 'us-west' (the region setting stores it) */
  id: string
  /** shown to players, e.g. 'US West' */
  label: string
  /** ws(s)://host[:port]; rooms at `${url}/ws?room=CODE`, HTTP API at the matching http(s) URL */
  url: string
}

/** up: reachable, same protocol and netcode. mismatch: reachable, another version. checking: first probe running. */
export type RegionState = 'up' | 'down' | 'mismatch' | 'checking'

export interface RegionStatus extends ServerRegion {
  state: RegionState
  /** median of `samples`, whole ms; null until a probe answered (and while down) */
  rttMs: number | null
  /** recent round-trip times of `/health`, whole ms, oldest first (at most SAMPLE_WINDOW) */
  samples: number[]
  /** the server answered `/health` with ok (null: not probed yet) */
  healthy: boolean | null
  /** same protocol and, for release builds, the same netcode id (null: unknown) */
  versionOk: boolean | null
  /** the server's load from `/health` (null: unknown) */
  players: number | null
  rooms: number | null
  /** Online clock (ms) of the last finished probe (meaningless while state is 'checking') */
  at: number
}

/** 'auto' = the lowest ping among regions that are up, else a region id. */
export type RegionChoice = 'auto' | (string & {})

export type ServerFailure = 'unavailable' | 'mismatch' | 'full' | 'limited' | 'error'

/** A room of the public browser, with the region it runs in (live ping). */
export interface PublicRoom extends RoomSummary {
  region: RegionStatus
}

/** One leaderboard page of a region's server. */
export interface LeaderboardPage {
  region: RegionStatus
  period: Period
  /** best first, at most 100 */
  entries: PublicBoardRow[]
  /** this device's line, null when it has no counted server match in the period */
  you: PublicBoardRow | null
}

/** A device's public profile on a region's server. */
export interface ServerProfile extends PublicBoardRow {
  region: RegionStatus
  firstAt: number
  /** latest counted matches, newest first */
  recent: { at: number; region: string; won: boolean; roundsPlayed: number; roundsWon: number; kills: number; deaths: number; delta: number; rating: number }[]
}

/** A failed server call, with a reason the UI can act on and a message players can read. */
export class ServerError extends Error {
  constructor(
    readonly reason: ServerFailure,
    message: string,
  ) {
    super(message)
  }
}

export interface OnlineConfig {
  regions: ServerRegion[]
  /** this client's netcode id (__NET_ID__): a release server of another netcode is unusable */
  build: string
  fetch?: FetchLike
  /** monotonic ms (performance.now in the browser) */
  now?: () => number
}

/** wss://host → https://host (and ws → http). */
export function httpBase(ws: string): string {
  return ws.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/+$/, '')
}

const REGION_ID = /^[a-z0-9][a-z0-9-]{0,23}$/
const WS_URL = /^wss?:\/\/[^\s/?#]+$/

/**
 * Regions from build config. `list`: JSON `[{"id","label","url"}, …]` (VITE_GAME_SERVERS);
 * `single`: one ws(s) URL (VITE_GAME_SERVER), used when `list` is empty. Invalid entries
 * are dropped with a console warning (a typo must not break peer-to-peer play).
 */
export function parseRegions(list: unknown, single: unknown): ServerRegion[] {
  const out: ServerRegion[] = []
  const warn = (what: string) => console.warn(`[online] ignoring game server config: ${what}`)
  if (typeof list === 'string' && list.trim()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(list)
    } catch {
      warn('VITE_GAME_SERVERS is not JSON')
      parsed = []
    }
    for (const e of Array.isArray(parsed) ? parsed : []) {
      const r = e as Partial<Record<keyof ServerRegion, unknown>>
      const url = typeof r?.url === 'string' ? r.url.replace(/\/+$/, '') : ''
      if (typeof r?.id !== 'string' || !REGION_ID.test(r.id) || !WS_URL.test(url) || out.some((o) => o.id === r.id)) {
        warn(JSON.stringify(e))
        continue
      }
      out.push({ id: r.id, label: typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 32) : r.id, url })
    }
  }
  if (out.length === 0 && typeof single === 'string' && single.trim()) {
    const url = single.trim().replace(/\/+$/, '')
    if (WS_URL.test(url)) out.push({ id: 'default', label: 'Game server', url })
    else warn(`VITE_GAME_SERVER ${single}`)
  }
  return out
}

const release = (b: unknown) => typeof b === 'string' && b.length > 0 && !b.startsWith('dev-')

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function timeout(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(ms) : undefined
}

export class Online {
  readonly regions: readonly ServerRegion[]
  private readonly st = new Map<string, RegionStatus>()
  private readonly inflight = new Map<string, Promise<RegionStatus>>()
  private readonly subs = new Set<() => void>()
  private readonly fetch: FetchLike
  private readonly now: () => number

  constructor(private readonly cfg: OnlineConfig) {
    this.regions = cfg.regions.map((r) => ({ ...r }))
    for (const r of this.regions) {
      this.st.set(r.id, { ...r, state: 'checking', rttMs: null, samples: [], healthy: null, versionOk: null, players: null, rooms: null, at: 0 })
    }
    this.fetch = cfg.fetch ?? ((url, init) => (globalThis.fetch as unknown as FetchLike)(url, init))
    this.now = cfg.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()))
  }

  /** Does this build have any game server? */
  get configured(): boolean {
    return this.regions.length > 0
  }

  /** Last known status of every region, in config order (synchronous, no request). */
  status(): RegionStatus[] {
    return this.regions.map((r) => this.copy(this.st.get(r.id)!))
  }

  /** One region's last known status. */
  region(id: string): RegionStatus | null {
    const s = this.st.get(id)
    return s ? this.copy(s) : null
  }

  /**
   * Probe every region: one `/health` request each (three on a region's first probe),
   * RTT measured and added to its samples. Concurrent calls share requests; a region
   * probed less than `maxAgeMs` ago answers from cache. Never rejects.
   */
  async probe(maxAgeMs = PROBE_MAX_AGE_MS): Promise<RegionStatus[]> {
    await Promise.all(this.regions.map((r) => this.fresh(r.id, maxAgeMs)))
    return this.status()
  }

  /** Called after any status change (UI: re-read status()). */
  subscribe(cb: () => void): () => void {
    this.subs.add(cb)
    return () => this.subs.delete(cb)
  }

  /**
   * The region to host on ('auto' or an unknown id: lowest ping among regions that are
   * up; a region id: that region, whatever its state, so the caller can report why it is
   * not usable). null when no region is configured or, for 'auto', none is up.
   */
  async choose(choice: RegionChoice = 'auto'): Promise<RegionStatus | null> {
    if (choice !== 'auto' && this.st.has(choice)) return this.fresh(choice, ROUTE_TTL_UP_MS)
    const all = await Promise.all(this.regions.map((r) => this.fresh(r.id, ROUTE_TTL_UP_MS)))
    return best(all)
  }

  /** Is any region up? Cached for routing. */
  async available(): Promise<boolean> {
    return (await this.choose('auto')) !== null
  }

  /** Create a room on a region; resolves its code. Throws ServerError. */
  async createRoom(regionId: string): Promise<string> {
    const r = await this.usable(regionId)
    let res
    try {
      res = await this.fetch(`${httpBase(r.url)}/rooms`, { method: 'POST', signal: timeout(REQUEST_TIMEOUT_MS) })
    } catch {
      this.markDown(r.id)
      throw new ServerError('unavailable', `Could not reach the ${r.label} server.`)
    }
    const body = (await res.json().catch(() => null)) as { code?: unknown; error?: unknown } | null
    if (res.ok && typeof body?.code === 'string') return body.code
    throw failure(res.status, body, `The ${r.label} server could not open a room.`)
  }

  /**
   * Public rooms of every region that is up, in parallel: open lobbies first, then rooms
   * between matches, then running matches; lower ping first within each. Never rejects
   * (a region that does not answer is left out).
   */
  async browse(): Promise<PublicRoom[]> {
    const lists = await Promise.all(
      this.regions.map(async (r) => {
        const s = await this.fresh(r.id, ROUTE_TTL_UP_MS)
        if (s.state !== 'up') return []
        try {
          const res = await this.fetch(`${httpBase(r.url)}/rooms?public=1`, { signal: timeout(REQUEST_TIMEOUT_MS), cache: 'no-store' })
          const body = res.ok ? ((await res.json()) as { rooms?: unknown }) : null
          return Array.isArray(body?.rooms) ? (body.rooms as RoomSummary[]).filter((x) => typeof x?.code === 'string').map((x) => ({ ...x, region: this.copy(this.st.get(r.id)!) })) : []
        } catch {
          return []
        }
      }),
    )
    const phase = (x: PublicRoom) => (x.phase === 'lobby' ? 0 : x.phase === 'results' ? 1 : 2)
    return lists.flat().sort((a, b) => phase(a) - phase(b) || (a.region.rttMs ?? Infinity) - (b.region.rttMs ?? Infinity) || b.humans - a.humans)
  }

  /** Quick play on a region: the code of an open quick-play room there (or a new one). Throws ServerError. */
  async quickPlay(regionId: string, bots?: BotDifficulty): Promise<{ code: string; created: boolean }> {
    const r = await this.usable(regionId)
    let res
    try {
      res = await this.fetch(`${httpBase(r.url)}/quickplay${bots ? `?bots=${encodeURIComponent(bots)}` : ''}`, { method: 'POST', signal: timeout(REQUEST_TIMEOUT_MS) })
    } catch {
      this.markDown(r.id)
      throw new ServerError('unavailable', `Could not reach the ${r.label} server.`)
    }
    const body = (await res.json().catch(() => null)) as { code?: unknown; created?: unknown; error?: unknown } | null
    if (res.ok && typeof body?.code === 'string') return { code: body.code, created: body.created === true }
    throw failure(res.status, body, `The ${r.label} server could not find a game.`)
  }

  /** A region's leaderboard; `device` (this device's id) adds its own line. Throws ServerError. */
  async leaderboard(regionId: string, period: Period, device?: string): Promise<LeaderboardPage> {
    const r = await this.usable(regionId)
    const q = new URLSearchParams({ period, region: r.id })
    if (device) q.set('device', device)
    const body = (await this.read(r, `/leaderboard?${q}`)) as { entries?: unknown; you?: unknown } | null
    if (!body) throw new ServerError('error', `The ${r.label} server keeps no leaderboard.`)
    return { region: this.copy(this.st.get(r.id)!), period, entries: Array.isArray(body.entries) ? (body.entries as PublicBoardRow[]) : [], you: (body.you as PublicBoardRow | null) ?? null }
  }

  /** This device's profile on a region's server; null before its first counted match there. Throws ServerError. */
  async profile(regionId: string, device: string): Promise<ServerProfile | null> {
    const r = await this.usable(regionId)
    const body = (await this.read(r, `/players/${encodeURIComponent(device)}`)) as (Omit<ServerProfile, 'region'> & { found?: boolean }) | null
    if (!body || body.found !== true) return null
    const { found: _, ...profile } = body
    return { ...profile, region: this.copy(this.st.get(r.id)!) }
  }

  /** A configured region that is up (probed for routing), else ServerError. */
  private async usable(regionId: string): Promise<ServerRegion> {
    const r = this.regions.find((x) => x.id === regionId)
    if (!r) throw new ServerError('unavailable', 'That game server is not configured in this build.')
    const s = await this.fresh(r.id, ROUTE_TTL_UP_MS)
    if (s.state === 'mismatch') throw new ServerError('mismatch', `The ${r.label} server runs a different version of the game. Reload the page; if that does not help, the server is being updated.`)
    if (s.state !== 'up') throw new ServerError('unavailable', `The ${r.label} server is not reachable right now.`)
    return r
  }

  /** GET a JSON body; null on 404. Throws ServerError. */
  private async read(r: ServerRegion, path: string): Promise<unknown> {
    let res
    try {
      res = await this.fetch(`${httpBase(r.url)}${path}`, { signal: timeout(REQUEST_TIMEOUT_MS), cache: 'no-store' })
    } catch {
      throw new ServerError('unavailable', `Could not reach the ${r.label} server.`)
    }
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null
    if (res.status === 404) return null
    if (!res.ok || !body) throw failure(res.status, body, `The ${r.label} server did not answer.`)
    return body
  }

  /** Which region holds this room code? Asks every region that is up, in parallel. */
  async find(code: string): Promise<ServerRegion | null> {
    const hits = await Promise.all(
      this.regions.map(async (r) => {
        const s = await this.fresh(r.id, ROUTE_TTL_UP_MS)
        if (s.state !== 'up') return null
        try {
          const res = await this.fetch(`${httpBase(r.url)}/rooms/${encodeURIComponent(code)}`, { signal: timeout(REQUEST_TIMEOUT_MS), cache: 'no-store' })
          if (!res.ok) return null
          const v = (await res.json()) as { exists?: unknown } | null
          return v?.exists === true ? s : null
        } catch {
          return null
        }
      }),
    )
    const s = best(hits.filter((h): h is RegionStatus => h !== null))
    return s ? this.regions.find((r) => r.id === s.id)! : null
  }

  /** Does any region hold this room? */
  async hasRoom(code: string): Promise<boolean> {
    return (await this.find(code)) !== null
  }

  // -------------------------------------------------------------------------

  private fresh(id: string, maxAgeMs: number): Promise<RegionStatus> {
    const s = this.st.get(id)!
    const ttl = s.state === 'up' ? maxAgeMs : Math.min(maxAgeMs, ROUTE_TTL_DOWN_MS)
    if (s.state !== 'checking' && this.now() - s.at < ttl) return Promise.resolve(this.copy(s))
    let p = this.inflight.get(id)
    if (!p) {
      p = this.run(id).finally(() => this.inflight.delete(id))
      this.inflight.set(id, p)
    }
    return p
  }

  private async run(id: string): Promise<RegionStatus> {
    const s = this.st.get(id)!
    const n = s.samples.length === 0 ? COLD_SAMPLES : 1
    let healthy = false
    let versionOk: boolean | null = s.versionOk
    let load: { players: number | null; rooms: number | null } = { players: null, rooms: null }
    const samples = [...s.samples]
    for (let i = 0; i < n; i++) {
      const t0 = this.now()
      let v: { ok?: unknown; protocol?: unknown; build?: unknown; players?: unknown; rooms?: unknown } | null
      try {
        const res = await this.fetch(`${httpBase(s.url)}/health`, { signal: timeout(REQUEST_TIMEOUT_MS), cache: 'no-store' })
        v = res.ok ? ((await res.json()) as typeof v) : null
      } catch {
        v = null
      }
      if (!v || v.ok !== true) {
        healthy = false
        break
      }
      healthy = true
      samples.push(Math.round(this.now() - t0))
      versionOk = v.protocol === PROTOCOL_VERSION && !(release(v.build) && release(this.cfg.build) && v.build !== this.cfg.build)
      load = { players: typeof v.players === 'number' ? v.players : null, rooms: typeof v.rooms === 'number' ? v.rooms : null }
    }
    const kept = healthy ? samples.slice(-SAMPLE_WINDOW) : []
    Object.assign(s, {
      state: !healthy ? 'down' : versionOk ? 'up' : 'mismatch',
      healthy,
      versionOk: healthy ? versionOk : s.versionOk,
      samples: kept,
      rttMs: kept.length ? Math.round(median(kept)!) : null,
      ...load,
      at: this.now(),
    } satisfies Partial<RegionStatus>)
    this.emit()
    return this.copy(s)
  }

  /** A request failed mid-flow: routing stops using the region until the next probe. */
  private markDown(id: string): void {
    const s = this.st.get(id)!
    Object.assign(s, { state: 'down', healthy: false, samples: [], rttMs: null, at: this.now() } satisfies Partial<RegionStatus>)
    this.emit()
  }

  private copy(s: RegionStatus): RegionStatus {
    return { ...s, samples: [...s.samples] }
  }

  private emit(): void {
    for (const cb of this.subs) cb()
  }
}

function failure(status: number, body: { error?: unknown } | null, fallback: string): ServerError {
  const message = typeof body?.error === 'string' ? body.error : fallback
  return new ServerError(status === 503 ? 'full' : status === 429 ? 'limited' : 'error', message)
}

/** Lowest ping among regions that are up. */
function best(xs: (RegionStatus | null)[]): RegionStatus | null {
  let out: RegionStatus | null = null
  for (const s of xs) if (s && s.state === 'up' && (out === null || (s.rttMs ?? Infinity) < (out.rttMs ?? Infinity))) out = s
  return out
}

/**
 * Joins a code on the region that holds that room, else over peer-to-peer. Hosting
 * through this factory is peer-to-peer (server rooms are created with
 * Online.createRoom and then joined). `onRoute` learns where each join went.
 */
export function hybridNet(p2p: NetFactory, online: Online, server: (url: string) => NetFactory, onRoute?: (region: ServerRegion | null) => void): NetFactory {
  return {
    host(): Promise<HostEndpoint> {
      onRoute?.(null)
      return p2p.host()
    },
    async join(code: string, onStatus?: (msg: string) => void): Promise<Transport> {
      const r = online.configured ? await online.find(code) : null
      onRoute?.(r)
      return r ? server(r.url).join(code, onStatus) : p2p.join(code, onStatus)
    },
  }
}
