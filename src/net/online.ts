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
import type { Period, PublicBoardRow, PublicProfileCoverage, PublicProfileDetail, HistoryQueue, MatchHistoryEntry } from './leaderboard'
import { validMatchHistory } from './matchHistory'
import type { ListingInfo } from './listings'
import type { BotDifficulty } from '../sim/types'
import type { RoomRoute } from './rejoin'

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
const PUBLIC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function publicPlayer(value: unknown): boolean {
  return !!value && typeof value === 'object' && 'publicId' in value
    && typeof value.publicId === 'string' && PUBLIC_ID.test(value.publicId)
}

function profileBody(value: unknown): (Omit<ServerProfile, 'region'> & { found: true }) | null {
  if (value === null || (!!value && typeof value === 'object' && 'found' in value && value.found === false)) return null
  const body = value as Partial<ServerProfile> & { found?: unknown }
  const coverage = body?.coverage
  if (!publicPlayer(body) || body.found !== true || !coverage
    || !Number.isSafeInteger(coverage.totalMatches) || coverage.totalMatches < 0
    || !Number.isSafeInteger(coverage.detailedMatches) || coverage.detailedMatches < 0 || coverage.detailedMatches > coverage.totalMatches
    || coverage.totalMatches !== body.matches
    || (coverage.detailedMatches === 0 ? body.detail !== null : body.detail?.matches !== coverage.detailedMatches)
    // Older servers omit activity; a present one is folded games, never an empty aggregate.
    || (body.activity !== undefined && body.activity !== null
      && (typeof body.activity !== 'object' || !Number.isSafeInteger(body.activity.matches) || body.activity.matches < 1))) {
    throw new ServerError('error', 'The server returned invalid player profile data.')
  }
  return body as Omit<ServerProfile, 'region'> & { found: true }
}

type FetchLike = (
  url: string,
  init?: { method?: string; signal?: AbortSignal; cache?: 'no-store'; body?: string; keepalive?: boolean },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

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
  /** Reachable regions may drain existing games while refusing new ones. */
  maintenance?: { draining: boolean; message: string | null } | null
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
  /** 'server': runs on the game server; 'p2p': hosted from a player's PC, listed on the server (ping to it unknown before joining) */
  kind: 'server' | 'p2p'
  /** the region it runs in ('server') or is listed on ('p2p': the host's own pick, a rough hint of where it is) */
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
  coverage: PublicProfileCoverage
  detail: PublicProfileDetail | null
  /** Unfinished and partly played ranked games, human-controlled part only (absent: older server). */
  activity?: PublicProfileDetail | null
  /** latest counted matches, newest first */
  recent: { at: number; region: string; won: boolean; roundsPlayed: number; roundsWon: number; kills: number; deaths: number; delta: number; rating: number }[]
}

/** A failed server call, with a reason the UI can act on and a message players can read. */
export class ServerError extends Error {
  constructor(
    readonly reason: ServerFailure,
    message: string,
    readonly rankedConflict?: unknown,
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
  private ice: { config: RTCConfiguration; expiresAt: number } | null = null
  private iceRequest: Promise<RTCConfiguration> | null = null

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

  /** Relay credentials are independent of game versions; either region can issue them. */
  iceConfiguration(): Promise<RTCConfiguration> {
    if (this.ice && this.ice.expiresAt > Date.now() + 60_000) return Promise.resolve(structuredClone(this.ice.config))
    if (this.iceRequest) return this.iceRequest.then((config) => structuredClone(config))
    if (!this.configured) return Promise.reject(new Error('No relay credential service is configured.'))
    this.iceRequest = Promise.any(this.regions.map(async (region) => {
      const response = await this.fetch(`${httpBase(region.url)}/ice`, { cache: 'no-store', signal: timeout(REQUEST_TIMEOUT_MS) })
      if (!response.ok) throw new Error('Relay credential service unavailable.')
      const data = await response.json() as { iceServers?: unknown; expiresAt?: unknown }
      if (!data || !Array.isArray(data.iceServers) || data.iceServers.length < 1 || data.iceServers.length > 4
        || typeof data.expiresAt !== 'number' || data.expiresAt <= Date.now() + 5000 || data.expiresAt > Date.now() + 86_400_000 + 5000) throw new Error('Invalid relay credentials.')
      let relay = false
      const iceServers: RTCIceServer[] = data.iceServers.map((entry: unknown) => {
        const server = entry as RTCIceServer
        const urls = typeof server?.urls === 'string' ? [server.urls] : server?.urls
        if (!Array.isArray(urls) || urls.length < 1 || urls.length > 12 || urls.some((url) => typeof url !== 'string' || url.length > 256 || !/^(stun|stuns|turn|turns):[a-z0-9.\-\[\]:]+(?:\?transport=(?:udp|tcp))?$/i.test(url))) throw new Error('Invalid relay URLs.')
        if (urls.some((url) => /^turns?:/.test(url))) {
          if (typeof server.username !== 'string' || server.username.length > 128 || !server.username || typeof server.credential !== 'string' || server.credential.length > 256 || !server.credential) throw new Error('Invalid relay authentication.')
          relay = true
          return { urls, username: server.username, credential: server.credential }
        }
        return { urls }
      })
      if (!relay) throw new Error('Relay credentials are missing.')
      const config: RTCConfiguration = { iceServers }
      this.ice = { config, expiresAt: data.expiresAt }
      return config
    })).catch(() => { throw new Error('Could not load the connection relay. Please try hosting or joining again.') }).finally(() => { this.iceRequest = null })
    return this.iceRequest.then((config) => structuredClone(config))
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
        try {
          return await this.browseRegion(r.id)
        } catch {
          return []
        }
      }),
    )
    const phase = (x: PublicRoom) => (x.phase === 'lobby' ? 0 : x.phase === 'results' ? 1 : 2)
    return lists.flat().sort((a, b) => phase(a) - phase(b) || (a.region.rttMs ?? Infinity) - (b.region.rttMs ?? Infinity) || b.humans - a.humans)
  }

  /** One region's public list. Throws on failure so a count cannot mistake an outage for zero games. */
  async browseRegion(regionId: string): Promise<PublicRoom[]> {
    await this.usable(regionId)
    const region = this.copy(this.st.get(regionId)!)
    let res
    try {
      res = await this.fetch(`${httpBase(region.url)}/rooms?public=1`, { signal: timeout(REQUEST_TIMEOUT_MS), cache: 'no-store' })
    } catch {
      throw new ServerError('unavailable', `Could not list games in ${region.label}.`)
    }
    const body = await res.json() as { rooms?: unknown; listings?: unknown; error?: string } | null
    if (!res.ok) throw failure(res.status, body, `Could not list games in ${region.label}.`)
    if (!body || !Array.isArray(body.rooms)) throw new ServerError('error', `The ${region.label} server sent an invalid game list.`)
    const rows = (v: unknown) => (Array.isArray(v) ? (v as RoomSummary[]).filter((x) => typeof x?.code === 'string') : [])
    return [
      ...rows(body.rooms).map((x): PublicRoom => ({ ...x, kind: 'server', region })),
      ...rows(body.listings).map((x): PublicRoom => ({ ...x, quick: false, kind: 'p2p', region })),
    ]
  }

  /** List a player-hosted room on a region (Browse games). Throws ServerError. */
  async listRoom(regionId: string, info: ListingInfo): Promise<{ id: string; token: string; heartbeatMs: number }> {
    const r = await this.usable(regionId)
    const res = await this.send(r, '/listings', 'POST', info)
    const body = (await res.json().catch(() => null)) as { id?: unknown; token?: unknown; heartbeatS?: unknown; error?: unknown } | null
    if (res.ok && typeof body?.id === 'string' && typeof body.token === 'string') {
      return { id: body.id, token: body.token, heartbeatMs: typeof body.heartbeatS === 'number' ? body.heartbeatS * 1000 : 10_000 }
    }
    throw failure(res.status, body, `The ${r.label} server could not list the game.`)
  }

  /** Heartbeat of a listing, with its current info. 'gone': it expired, list it again. Throws ServerError. */
  async beatListing(regionId: string, id: string, token: string, info: Partial<ListingInfo>): Promise<'ok' | 'gone'> {
    const r = this.regions.find((x) => x.id === regionId)
    if (!r) throw new ServerError('unavailable', 'That game server is not configured in this build.')
    const res = await this.send(r, `/listings/${encodeURIComponent(id)}`, 'PUT', { ...info, token })
    const body = (await res.json().catch(() => null)) as { ok?: unknown; gone?: unknown; error?: unknown } | null
    if (res.ok) return body?.gone === true ? 'gone' : 'ok'
    throw failure(res.status, body, `The ${r.label} server did not take the update.`)
  }

  /** Remove a listing at once (the room is private again). Never throws: the listing expires anyway. */
  async unlistRoom(regionId: string, id: string, token: string): Promise<void> {
    const r = this.regions.find((x) => x.id === regionId)
    if (!r) return
    try {
      await this.send(r, `/listings/${encodeURIComponent(id)}`, 'DELETE', { token }, true)
    } catch {
      // unreachable: the server drops it after its TTL
    }
  }

  /** A JSON body as text/plain (a simple request: POST needs no CORS preflight). */
  private async send(r: ServerRegion, path: string, method: string, body: unknown, keepalive = false) {
    try {
      return await this.fetch(`${httpBase(r.url)}${path}`, { method, body: JSON.stringify(body), signal: timeout(REQUEST_TIMEOUT_MS), ...(keepalive ? { keepalive } : {}) })
    } catch {
      throw new ServerError('unavailable', `Could not reach the ${r.label} server.`)
    }
  }

  /** Quick play on a region: the code of an open quick-play room there (or a new one). Throws ServerError. */
  /** `exclude`: a room code never to return (New game from that room's results). */
  async quickPlay(regionId: string, bots?: BotDifficulty, exclude?: string): Promise<{ code: string; created: boolean }> {
    return this.queue(regionId, 'quickplay', bots, undefined, exclude)
  }

  async rankedPlay(regionId: string, accountToken?: string): Promise<{ code: string; created: boolean }> {
    return this.queue(regionId, 'ranked', undefined, accountToken)
  }

  private async queue(regionId: string, kind: 'quickplay' | 'ranked', bots?: BotDifficulty, accountToken?: string, exclude?: string): Promise<{ code: string; created: boolean }> {
    const r = await this.usable(regionId)
    const params = new URLSearchParams()
    if (bots) params.set('bots', bots)
    if (exclude) params.set('exclude', exclude)
    const query = params.size ? `?${params}` : ''
    let res
    try {
      res = await this.fetch(`${httpBase(r.url)}/${kind}${query}`, { method: 'POST', ...(accountToken ? { body: JSON.stringify({ accountToken }) } : {}), signal: timeout(REQUEST_TIMEOUT_MS) })
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
    const q = new URLSearchParams({ period })
    if (device) q.set('device', device)
    const body = (await this.read(r, `/leaderboard?${q}`)) as { entries?: unknown; you?: unknown } | null
    if (!body) throw new ServerError('error', `The ${r.label} server keeps no leaderboard.`)
    if (!Array.isArray(body.entries) || body.entries.some((row) => !publicPlayer(row)) || (body.you !== null && !publicPlayer(body.you))) {
      throw new ServerError('error', 'The server returned invalid leaderboard player data.')
    }
    return { region: this.copy(this.st.get(r.id)!), period, entries: body.entries as PublicBoardRow[], you: body.you as PublicBoardRow | null }
  }

  /** This device's profile on a region's server; null before its first counted match there. Throws ServerError. */
  async profile(regionId: string, device: string): Promise<ServerProfile | null> {
    const r = await this.usable(regionId)
    const body = profileBody(await this.read(r, `/players/${encodeURIComponent(device)}`))
    if (!body) return null
    const { found: _, ...profile } = body
    return { ...profile, region: this.copy(this.st.get(r.id)!) }
  }

  /** A leaderboard player's profile, addressed only by its opaque public ID. */
  async publicProfile(regionId: string, publicId: string): Promise<ServerProfile | null> {
    if (!PUBLIC_ID.test(publicId)) {
      throw new ServerError('error', 'That public player ID is invalid.')
    }
    const r = await this.usable(regionId)
    const body = profileBody(await this.read(r, `/profiles/${publicId}`))
    if (!body) return null
    const { found: _, ...profile } = body
    if (profile.publicId !== publicId) throw new ServerError('error', 'The server returned a different player profile.')
    return { ...profile, region: this.copy(this.st.get(r.id)!) }
  }

  /** Completed authoritative matches, including eligible departures and casual games. */
  async matchHistory(regionId: string, identity: string, queue?: HistoryQueue, publicId = false): Promise<MatchHistoryEntry[]> {
    if (publicId && !PUBLIC_ID.test(identity)) throw new ServerError('error', 'That public player ID is invalid.')
    const r = await this.usable(regionId)
    const params = new URLSearchParams({ limit: '10' })
    if (queue) params.set('queue', queue)
    const body = await this.read(r, `/${publicId ? 'profiles' : 'players'}/${encodeURIComponent(identity)}/history?${params}`)
    if (!body || typeof body !== 'object' || !('matches' in body) || !validMatchHistory(body.matches)) {
      throw new ServerError('error', 'The server returned invalid match history data.')
    }
    return body.matches
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

  /** Exact original server for reconnects: never routes to a different region or P2P. */
  async roomExists(regionId: string, code: string): Promise<boolean> {
    const region = await this.usable(regionId)
    let res
    try {
      res = await this.fetch(`${httpBase(region.url)}/rooms/${encodeURIComponent(code)}`, { signal: timeout(REQUEST_TIMEOUT_MS), cache: 'no-store' })
    } catch {
      this.markDown(region.id)
      throw new ServerError('unavailable', `Could not reach the ${region.label} server.`)
    }
    if (res.status === 404) return false
    const body = await res.json() as { exists?: boolean; error?: string }
    if (!res.ok) throw failure(res.status, body, `Could not look up this game on ${region.label}.`)
    return body.exists === true
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
      let v: { ok?: unknown; protocol?: unknown; build?: unknown; players?: unknown; rooms?: unknown; maintenance?: { draining?: unknown; message?: unknown } } | null
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
      s.maintenance = v.maintenance?.draining === true ? { draining: true, message: typeof v.maintenance.message === 'string' ? v.maintenance.message : null } : null
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

function failure(status: number, body: { error?: unknown; rankedConflict?: unknown } | null, fallback: string): ServerError {
  const message = typeof body?.error === 'string' ? body.error : fallback
  return new ServerError(status === 503 ? 'full' : status === 429 ? 'limited' : 'error', message, body?.rankedConflict)
}

/** Lowest ping among regions that are up. */
function best(xs: (RegionStatus | null)[]): RegionStatus | null {
  let out: RegionStatus | null = null
  for (const s of xs) if (s && s.state === 'up' && !s.maintenance?.draining && (out === null || (s.rttMs ?? Infinity) < (out.rttMs ?? Infinity))) out = s
  return out
}

/**
 * Joins a code on the region that holds that room, else over peer-to-peer. Hosting
 * through this factory is peer-to-peer (server rooms are created with
 * Online.createRoom and then joined). `onRoute` learns where each join went.
 */
export interface HybridNetFactory extends NetFactory {
  /** A known browser/rejoin destination; never looks up or substitutes another backend. */
  joinAt(code: string, route: RoomRoute, onStatus?: (msg: string) => void): Promise<Transport>
}

export function hybridNet(p2p: NetFactory, online: Online, server: (url: string) => NetFactory, onRoute?: (region: ServerRegion | null) => void): HybridNetFactory {
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
    joinAt(code, route, onStatus) {
      if (route.kind === 'p2p') {
        onRoute?.(null)
        return p2p.join(code, onStatus)
      }
      const region = online.regions.find((r) => r.id === route.region)
      if (!region) return Promise.reject(new ServerError('unavailable', 'The original game server is not configured in this build.'))
      onRoute?.(region)
      return server(region.url).join(code, onStatus)
    },
  }
}
