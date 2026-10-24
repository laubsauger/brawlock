import { summarizeLinks } from './monitoring'
import { secondsOf } from '../sim/config'
/**
 * Dedicated server core (M4.1, docs/M4.md §11): room registry, HTTP API, WebSocket
 * admission, rate limits and structured logs. Transport-agnostic and typed:
 * server/listen.mjs binds it to Node's http server and upgraded sockets.
 *
 * HTTP (JSON, CORS):
 *   GET  /health        {ok, build, protocol, region, rooms, maxRooms, players, connections, uptimeS}
 *                       (clients time it for the region ping, so it stays cheap)
 *   POST /rooms         create a room → 201 {code, build, protocol}; 429 rate limited, 503 full
 *   GET  /rooms/:code   {code, exists: true, state, humans, peers, matchTick} or {exists: false}
 *                       (200 either way: every P2P join asks, a 404 would log a console error)
 *   GET  /rooms?public=1  {region, rooms: RoomSummary[], listings: ListingView[]}: the public
 *                       room browser, server rooms and listed player-hosted rooms (cached ~1 s)
 *   POST   /listings      list a player-hosted (P2P) room → 201 {id, token, ttlS, heartbeatS}
 *   PUT    /listings/:id  heartbeat {token, ...changes} → {ok} or {ok, gone} (list again)
 *   DELETE /listings/:id  {token} → unlisted at once (listings.ts; the server never connects to it)
 *   POST /quickplay?bots=brutal → {code, created, region}: an open quick-play room, or a new one
 *   GET  /leaderboard?period=all|week&region=&device=  {period, region, entries, you}
 *   GET  /players/:device  {found: true, ...} a device's public profile (rating, rank, totals,
 *                       recent matches), or {found: false} before its first counted match
 *   GET  /profiles/:publicId same public profile, using a stored opaque ID from the board
 * WebSocket: /ws?room=CODE joins that room (session protocol, ws.ts). The first connected
 * human owns the room (lobby controls via `ctl`). A room nobody is connected to closes
 * after emptyRoomMs. IPs are only logged as salted hashes.
 */
import { hashString } from '../sim/snapshot'
import { newRoomCode, parseRoomCode } from './code'
import { createRoom, type QuickPlayPolicy, type Room, type RoomDeps, type RoomSummary } from './dedicated'
import { LISTING_HEARTBEAT_MS, LISTING_TTL_MS, ListingDirectory } from './listings'
import { LB_MIN_SECONDS, type FinishedMatch } from './leaderboard'
import { localRatingAuthority, PUBLIC_PLAYER_ID, type RatingAuthority, type RatingReceiptStore } from './ratingAuthority'
import { MAX_PLAYERS } from './session'
import { PROTOCOL_VERSION, encode } from './protocol'
import { KeyedLimiter, TokenBucket } from './ratelimit'
import { SocketTransport, type TextSocket } from './ws'
import type { BotDifficulty, MatchSettings } from '../sim/types'
import type { MatchRating } from './rating'
import type { RankedAccountAuthority, VerifiedAccount } from './accounts'
import { RankedConflictError } from './accounts'
import { MAINTENANCE_NOTICE, validMaintenance, type MaintenanceState, type MaintenanceStatus, type MaintenanceStore } from './maintenance'

export interface ServerConfig {
  build: string
  /** region id this server answers for (VITE_GAME_SERVERS id), reported by /health; '' = unset */
  region: string
  /** rooms per process */
  maxRooms: number
  /** a room with no connected link closes after this long */
  emptyRoomMs: number
  maxConnsPerIp: number
  roomCreatesPerMin: number
  /** GET /rooms/:code per IP: a join asks once, so this only stops code guessing */
  lookupsPerMin: number
  connectsPerMin: number
  /** per connection, sustained (bursts up to 2×) */
  msgsPerSec: number
  bytesPerSec: number
  /** CORS / WebSocket Origin allowlist; null = any origin */
  allowedOrigins: string[] | null
  /** per IP: GET /rooms?public=1, POST /quickplay, leaderboard and profile reads */
  listsPerMin: number
  quickplaysPerMin: number
  boardReadsPerMin: number
  /** quick-play rooms: timers, table size, default bots, and match settings over the defaults */
  quickplay: QuickPlayPolicy & { settings?: Partial<MatchSettings> }
  /** Fixed-rule ranked queue; waits for humans rather than starting solo. */
  ranked: QuickPlayPolicy & { settings?: Partial<MatchSettings> }
  /** a server match shorter than this does not count for the leaderboard */
  leaderboardMinSeconds: number
  /** player-hosted room listings: per IP creations / heartbeats per minute, live listings per IP, per server */
  listingCreatesPerMin: number
  listingBeatsPerMin: number
  listingsPerIp: number
  maxListings: number
}

export const DEFAULT_SERVER_CONFIG: Omit<ServerConfig, 'build'> = {
  region: '',
  maxRooms: 200,
  emptyRoomMs: 60_000,
  maxConnsPerIp: 16,
  roomCreatesPerMin: 6,
  lookupsPerMin: 60,
  connectsPerMin: 60,
  msgsPerSec: 240,
  bytesPerSec: 128 * 1024,
  allowedOrigins: null,
  listsPerMin: 60,
  quickplaysPerMin: 20,
  boardReadsPerMin: 60,
  // Queue economy: a broader opening kit, then enough shared income for a purchase each round.
  // Casual games are short: first to 3 round wins (ranked plays its fixed rounds). The table
  // is Hard bots with one Brutal and one Medium for variety (ranked keeps all Brutal).
  quickplay: {
    fillMs: 30_000, startMs: 30_000, nextMs: 10_000, seats: 10, fill: 10, bots: 'hard', mix: ['brutal', 'medium'],
    settings: { winScore: 3, startGold: 50, roundGold: 15, killGold: 2, winGold: 3 },
  },
  ranked: {
    fillMs: 0, startMs: 60_000, nextMs: 15_000, seats: 8, fill: 8, bots: 'brutal', minHumans: 2,
    settings: { rankedRounds: 5, startGold: 50, roundGold: 15, killGold: 2, winGold: 3 },
  },
  leaderboardMinSeconds: LB_MIN_SECONDS,
  listingCreatesPerMin: 6,
  listingBeatsPerMin: 30,
  listingsPerIp: 3,
  maxListings: 500,
}

/** how long the public room list and a leaderboard page are served from cache (server clock) */
const LIST_CACHE_MS = 1000
/** a quick-play seat handed out is held this long for its player to connect */
const RESERVE_MS = 15_000
const BOT_DIFFICULTIES: readonly BotDifficulty[] = ['dummy', 'easy', 'medium', 'hard', 'brutal', 'uber']

export type LogLevel = 'info' | 'warn' | 'error'
export type LogFn = (level: LogLevel, event: string, fields?: Record<string, unknown>) => void

export interface HttpRequest {
  method: string
  /** path with query, e.g. '/rooms/ABCDE' */
  path: string
  ip: string
  origin: string | null
  /** request body (POST / PUT / DELETE); null: over the size limit */
  body?: string | null
  /** Set by the Node boundary after a single-use proof is verified, never parsed from JSON. */
  account?: VerifiedAccount
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/** WebSocket upgrade decision: accept into a room, accept to tell the client why not, or refuse. */
export type Admission = { kind: 'room'; code: string } | { kind: 'message'; message: string } | { kind: 'refuse'; status: number; reason: string }

/** Options of a room created directly (demo / test rooms); POST /rooms makes plain owner rooms. */
export interface RoomSetup {
  ranked?: boolean
  code?: string
  auto?: boolean
  bots?: BotDifficulty[]
  settings?: Partial<MatchSettings>
  autoStartMs?: number
  rematchMs?: number
  /** a quick-play room with this bot difficulty (public, no owner) */
  quick?: BotDifficulty
  public?: boolean
}

interface Entry {
  room: Room
  created: number
  emptySince: number
  /** quick-play seats handed out, by expiry (server clock) */
  reserved: number[]
  /** Never close a freshly reserved queue room before its first accepted human arrives. */
  hadHuman: boolean
  /** Accepted sockets include a pending hello, so a newcomer in flight is not evicted. */
  connections: number
  settling?: Promise<void>
  accounts: Map<string, number>
  accountReservations: Map<string, number>
}

export interface ServerCore {
  http(req: HttpRequest): Promise<HttpResponse>
  admit(path: string, ip: string, origin: string | null): Admission
  /** an accepted socket: into its room (code from admit) or told why not (message) */
  attach(admission: Admission, socket: TextSocket, ip: string, account?: VerifiedAccount | null): void
  authorize(code: string, account: VerifiedAccount | null): Promise<void>
  /** create a room directly (CLI demo rooms, tests) */
  createRoom(opts?: RoomSetup): Promise<Room>
  room(code: string): Room | null
  /** sweep empty rooms and idle limiter state; call every few seconds */
  sweep(): void
  close(): void
  stats(): { rooms: number; players: number; connections: number }
  monitoring(): { rooms: { mode: string; phase: string; round: number | null; humans: number; bots: number }[]; links: ReturnType<typeof summarizeLinks> }
  maintenance(): MaintenanceStatus
  setMaintenance(state: MaintenanceState): MaintenanceStatus
}

export function createServerCore(
  cfg: ServerConfig,
  deps: RoomDeps & {
    log: LogFn
    now: () => number
    /** finished server matches are rated and stored here (none: no leaderboard) */
    leaderboard?: RatingReceiptStore
    /** The one global authority; remote regions never keep independent rating tables. */
    ratingAuthority?: RatingAuthority
    /** ms since epoch, for stored results (default Date.now) */
    clock?: () => number
    accounts?: RankedAccountAuthority
    analytics?: import('../../server/analytics.mjs').AnalyticsStore
    maintenance?: MaintenanceStore
    pendingAuthority?(): number
  },
): ServerCore {
  const rooms = new Map<string, Entry>()
  const creating = new Set<string>()
  const started = deps.now()
  const salt = Math.floor(Math.random() * 0x7fffffff).toString(36)
  const tag = (ip: string) => hashString(salt + ip).toString(36)
  const createLimit = new KeyedLimiter(cfg.roomCreatesPerMin, cfg.roomCreatesPerMin / 60)
  const connectLimit = new KeyedLimiter(cfg.connectsPerMin, cfg.connectsPerMin / 60)
  const lookupLimit = new KeyedLimiter(cfg.lookupsPerMin, cfg.lookupsPerMin / 60)
  const listLimit = new KeyedLimiter(cfg.listsPerMin, cfg.listsPerMin / 60)
  const quickLimit = new KeyedLimiter(cfg.quickplaysPerMin, cfg.quickplaysPerMin / 60)
  const boardLimit = new KeyedLimiter(cfg.boardReadsPerMin, cfg.boardReadsPerMin / 60)
  const clock = deps.clock ?? (() => Date.now())
  const authority = deps.ratingAuthority ?? (deps.leaderboard ? localRatingAuthority(deps.leaderboard, { minSeconds: cfg.leaderboardMinSeconds, clock }) : null)
  let listCache: { at: number; body: unknown } | null = null
  const listings = new ListingDirectory({ ttlMs: LISTING_TTL_MS, maxTotal: cfg.maxListings, perIp: cfg.listingsPerIp, maxSeats: MAX_PLAYERS }, deps.now)
  const listingCreateLimit = new KeyedLimiter(cfg.listingCreatesPerMin, cfg.listingCreatesPerMin / 60)
  const listingBeatLimit = new KeyedLimiter(cfg.listingBeatsPerMin, cfg.listingBeatsPerMin / 60)
  const conns = new Map<string, number>()
  let connections = 0
  let maintenance = deps.maintenance?.get() ?? { draining: false, message: null }
  let pendingResults = 0
  const log = deps.log

  const originOk = (origin: string | null) => cfg.allowedOrigins === null || (origin !== null && cfg.allowedOrigins.includes(origin))

  function cors(origin: string | null): Record<string, string> {
    const allow = cfg.allowedOrigins === null ? '*' : origin && cfg.allowedOrigins.includes(origin) ? origin : 'null'
    return {
      'access-control-allow-origin': allow,
      'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type',
      // heartbeats are PUTs (preflighted): one preflight per 10 minutes, not per heartbeat
      'access-control-max-age': '600',
      vary: 'Origin',
      'cache-control': 'no-store',
      'content-type': 'application/json',
    }
  }

  const json = (status: number, body: unknown, origin: string | null): HttpResponse => ({ status, headers: cors(origin), body: JSON.stringify(body) })

  function players(): number {
    let n = 0
    for (const e of rooms.values()) n += e.room.debug().connectedHumans
    return n
  }

  async function newRoom(code: string, setup: RoomSetup = {}): Promise<Room> {
    if (maintenance.draining) throw new Error(MAINTENANCE_NOTICE)
    const policy = setup.ranked ? cfg.ranked : cfg.quickplay
    const defaults = setup.ranked ? DEFAULT_SERVER_CONFIG.ranked : DEFAULT_SERVER_CONFIG.quickplay
    const officialRewards = !!setup.quick && setup.quick === policy.bots && setup.settings === undefined
    let analyticsMatch: string | null = null
    let matchPublic = false
    const writeAnalytics = (write: () => void) => {
      try { write() } catch { log('error', 'analytics.write.failed', { room: code }) }
    }
    const room = await createRoom(
      {
        code,
        bots: setup.bots ?? [],
        auto: setup.auto ?? false,
        settings: setup.quick ? { botsReplaceLeavers: true, ...defaults.settings, ...policy.settings, ...setup.settings } : setup.settings,
        autoStartMs: setup.autoStartMs,
        rematchMs: setup.rematchMs,
        // the mix belongs to the default table; a player's explicit level fills the table alone
        ...(setup.quick ? { quick: { ...policy, bots: setup.quick, mix: setup.quick === policy.bots ? policy.mix : undefined } } : {}),
        ranked: setup.ranked === true,
        requireRankedAccount: !!deps.accounts,
        public: setup.public,
        hasPendingConnections: () => { const entry = rooms.get(code); return !!entry && reservedNow(entry) > 0 },
        elo: { enabled: !!authority && setup.ranked === true, minSeconds: cfg.leaderboardMinSeconds },
        onMatchStart: (info) => {
          matchPublic = room.isPublic()
          if (setup.ranked && deps.accounts) deps.accounts.started(code, info.slots.filter((slot) => slot.kind === 'human').map((slot) => {
            const identity = slot.profileId
            if (!identity || !/^a_[A-Za-z0-9_-]{8,60}$/.test(identity)) throw new Error('Ranked participant has no verified account identity')
            return identity.slice(2)
          }))
          if (deps.analytics) {
            analyticsMatch = crypto.randomUUID()
            writeAnalytics(() => deps.analytics!.start({ id: analyticsMatch!, region: cfg.region, build: cfg.build, room: code,
              queue: setup.ranked ? 'ranked' : setup.quick ? 'casual' : 'custom', settings: info.settings,
              devices: info.slots.filter((slot) => slot.kind === 'human').flatMap((slot) => info.devices?.[slot.id] ? [info.devices[slot.id]] : []),
              bots: info.slots.filter((slot) => slot.kind === 'bot').length }))
          }
        },
        ...(deps.analytics ? {
          onMatchJoin: (device) => { if (analyticsMatch) writeAnalytics(() => deps.analytics!.join(analyticsMatch!, device)) },
          onMatchAbort: () => {
            if (analyticsMatch) writeAnalytics(() => deps.analytics!.abandon(analyticsMatch!))
            analyticsMatch = null
          },
        } satisfies Pick<import('./dedicated').RoomOptions, 'onMatchJoin' | 'onMatchAbort'> : {}),
        onMatch: async (m, result) => {
          // a match everyone walked out of is settled through results but still counts as abandoned
          if (analyticsMatch) writeAnalytics(() => m.abandoned ? deps.analytics!.abandon(analyticsMatch!) : deps.analytics!.finish(analyticsMatch!, m))
          analyticsMatch = null
          pendingResults++
          try {
            // Snapshot participation before any authority await: a player leaving
            // the result screen cannot retroactively lose their completion reward.
            const e = rooms.get(code)
            const matchId = crypto.randomUUID()
            const receipt = officialRewards && deps.accounts ? {
              matchId, queue: setup.ranked ? 'ranked' as const : 'quick' as const, rulesVersion: 1 as const,
              completedAt: clock(), durationSeconds: Math.floor(secondsOf(m.ticks)),
              players: m.seats.filter((s) => /^a_[A-Za-z0-9_-]{8,60}$/.test(s.device)).map((s) => ({
                accountId: s.device.slice(2), completed: !m.abandoned && !s.forfeited && !!s.stats && (e?.accounts.get(s.device.slice(2)) ?? 0) > 0,
                aliveSeconds: s.stats?.aliveSec ?? 0,
                casts: Object.values(s.stats?.spells ?? {}).reduce((n, [casts]) => n + casts, 0),
                damageDealt: s.stats?.damageDealt ?? 0, walked: s.stats?.walked ?? 0,
                roundsPlayed: s.roundsPlayed, roundsWon: s.roundsWon, won: s.won,
              })),
            } : null
            // reward() persists its outbox receipt before awaiting network delivery.
            // Its delivery and Elo proceed independently and cannot suppress one another.
            const progression = receipt ? deps.accounts!.reward(receipt).then((status) => {
              result.progression = { matchId, status }
            }).catch(() => {
              log('error', 'progression.storage.error', { room: code })
              result.progression = { matchId, status: 'unavailable' }
            }) : Promise.resolve()
            const rating = record(code, m, setup.ranked ? 'ranked' : setup.quick ? 'casual' : 'custom', matchPublic && room.isPublic())
            ;[result.rating] = await Promise.all([rating, progression])
            if (e && deps.accounts) for (const [id, connected] of e.accounts) if (connected === 0) { deps.accounts.release(code, id); e.accounts.delete(id) }
          } finally { pendingResults-- }
        },
        ...(setup.ranked || setup.quick ? { onMatchActivity: (m: FinishedMatch) => {
          pendingResults++
          return record(code, m, setup.ranked ? 'ranked' : 'casual').finally(() => { pendingResults-- })
        } } : {}),
        onName: (device, name) => {
          if (!authority || (deps.accounts && !/^a_[A-Za-z0-9_-]{8,60}$/.test(device))) return
          void authority.rename(device, name).catch((error) => {
            log('error', 'leaderboard.error', { room: code, error: String(error) })
          })
        },
        log: (msg) => log('info', 'room.policy', { room: code, msg }),
      },
      deps,
    )
    // Draining can begin while the host endpoint is being created.
    if (maintenance.draining) { room.close(); throw new Error(MAINTENANCE_NOTICE) }
    rooms.set(code, { room, created: deps.now(), emptySince: deps.now(), reserved: [], hadHuman: false, connections: 0, accounts: new Map(), accountReservations: new Map() })
    log('info', 'room.created', { room: code, rooms: rooms.size, ...(setup.quick ? { quick: true } : {}) })
    return room
  }

  /** A finished server match: rated and stored when it counts (leaderboard.ts). */
  async function record(room: string, m: FinishedMatch, queue: 'ranked' | 'casual' | 'custom', listed = false): Promise<MatchRating> {
    if (!authority) return { status: 'unrated', reason: 'This server does not record global Elo.' }
    try {
      const rating = await authority.record({ key: crypto.randomUUID(), region: cfg.region, room, at: clock(), minSeconds: cfg.leaderboardMinSeconds, match: m, queue, public: listed })
      log(rating.status === 'unavailable' ? 'error' : 'info', rating.status === 'rated' ? 'leaderboard.match' : 'leaderboard.skip', { room, reason: rating.reason, humans: m.seats.length, ticks: m.ticks })
      return rating
    } catch (e) {
      log('error', 'leaderboard.error', { room, error: String(e) })
      return { status: 'unavailable', reason: 'The server could not save Elo for this match.' }
    }
  }

  function reservedNow(e: Entry): number {
    const now = deps.now()
    e.reserved = e.reserved.filter((t) => t > now)
    return e.reserved.length
  }

  function closeRoom(code: string, e: Entry): void {
    if (rooms.get(code) !== e) return
    // Remove the entry first: closing transports can synchronously run their release callbacks.
    rooms.delete(code)
    e.reserved = []
    listCache = null
    e.room.close()
    deps.accounts?.release(code)
    log('info', 'room.closed', { room: code, reason: 'empty', rooms: rooms.size })
  }

  function settleAndClose(code: string, e: Entry): void {
    if (e.settling) return
    // A lobby peek has no match to settle and still closes synchronously.
    if (e.room.screen() !== 'match') { closeRoom(code, e); return }
    listCache = null
    e.settling = e.room.settleDeparted().then(() => {
      if (rooms.get(code) === e && e.connections === 0 && e.room.peers() === 0 && reservedNow(e) === 0) closeRoom(code, e)
    }).catch((error) => { log('error', 'room.settlement.error', { room: code, error: String(error) }) })
      .finally(() => { e.settling = undefined })
  }
  function closeEmptyQueue(code: string, e: Entry): void {
    if (e.hadHuman && e.room.isQuick() && e.connections === 0 && e.room.peers() === 0 && reservedNow(e) === 0) settleAndClose(code, e)
  }

  /** Public games with an available human seat or bot reservation. Fullest first, then oldest. */
  function openQuickRoom(ranked = false, exclude: string | null = null): Entry | null {
    let best: Entry | null = null
    let bestN = -1
    for (const e of rooms.values()) {
      const r = e.room
      if (e.settling) continue
      if (!r.isPublic() || r.code === exclude) continue
      if (r.isRanked() !== ranked) continue
      const phase = r.screen()
      if (ranked && phase !== 'lobby') continue
      if (phase !== 'lobby' && phase !== 'results' && phase !== 'match') continue
      // Owner rooms need someone to press Start; quick players can join them once
      // playing, but must not be stranded in a manual lobby or rematch screen.
      if (!r.isQuick() && phase !== 'match') continue
      const held = reservedNow(e)
      if (r.joinableSeats() <= held) continue
      const n = r.humans() + held
      if (n > bestN || (n === bestN && best && e.created < best.created)) {
        best = e
        bestN = n
      }
    }
    return best
  }

  function publicList(): unknown {
    const now = deps.now()
    if (listCache && now - listCache.at < LIST_CACHE_MS) return listCache.body
    const order = (r: RoomSummary) => (r.phase === 'lobby' ? 0 : r.phase === 'results' ? 1 : 2)
    const list = [...rooms.values()]
      .filter((e) => !e.settling && e.room.isPublic() && e.room.screen() !== 'menu')
      .map((e) => e.room.summary())
      .sort((a, b) => order(a) - order(b) || b.humans - a.humans || a.code.localeCompare(b.code))
    listCache = { at: now, body: { region: cfg.region, rooms: list, listings: listings.list() } }
    return listCache.body
  }

  function freeCode(): string {
    for (let i = 0; i < 50; i++) {
      const c = newRoomCode()
      if (!rooms.has(c) && !creating.has(c)) return c
    }
    throw new Error('no free room code')
  }

  const core: ServerCore = {
    async http(req) {
      const url = new URL(req.path, 'http://x')
      const parts = url.pathname.split('/').filter(Boolean)
      if (req.method === 'OPTIONS') return { status: 204, headers: cors(req.origin), body: '' }
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(200, { ok: true, build: cfg.build, protocol: PROTOCOL_VERSION, region: cfg.region, maintenance: { ...maintenance }, listings: listings.size, rooms: rooms.size, maxRooms: cfg.maxRooms, players: players(), connections, uptimeS: Math.round((deps.now() - started) / 1000) }, req.origin)
      }
      if (parts[0] === 'rooms' && parts.length === 1 && req.method === 'POST') {
        if (!originOk(req.origin)) return json(403, { error: 'origin not allowed' }, req.origin)
        if (maintenance.draining) return json(503, { error: maintenance.message ?? MAINTENANCE_NOTICE, maintenance: true }, req.origin)
        if (!createLimit.take(req.ip, deps.now())) {
          log('warn', 'room.create.limited', { ip: tag(req.ip) })
          return json(429, { error: 'Too many rooms created, try again in a minute.' }, req.origin)
        }
        if (rooms.size + creating.size >= cfg.maxRooms) {
          log('warn', 'room.create.full', { rooms: rooms.size })
          return json(503, { error: 'The server is full right now.' }, req.origin)
        }
        const code = freeCode()
        creating.add(code)
        try {
          await newRoom(code)
        } catch (error) {
          if (maintenance.draining) return json(503, { error: maintenance.message ?? MAINTENANCE_NOTICE, maintenance: true }, req.origin)
          throw error
        } finally {
          creating.delete(code)
        }
        if (maintenance.draining) {
          const entry = rooms.get(code)
          if (entry) closeRoom(code, entry)
          return json(503, { error: maintenance.message ?? MAINTENANCE_NOTICE, maintenance: true }, req.origin)
        }
        log('info', 'room.create', { room: code, ip: tag(req.ip) })
        return json(201, { code, build: cfg.build, protocol: PROTOCOL_VERSION }, req.origin)
      }
      if (parts[0] === 'rooms' && parts.length === 1 && req.method === 'GET') {
        if (url.searchParams.get('public') !== '1') return json(400, { error: 'only the public room list is available: /rooms?public=1' }, req.origin)
        if (!listLimit.take(req.ip, deps.now())) {
          log('warn', 'room.list.limited', { ip: tag(req.ip) })
          return json(429, { error: 'Too many requests, try again in a minute.' }, req.origin)
        }
        return json(200, publicList(), req.origin)
      }
      if (parts[0] === 'listings' && (parts.length === 1 || parts.length === 2)) {
        const create = parts.length === 1 && req.method === 'POST'
        const update = parts.length === 2 && (req.method === 'PUT' || req.method === 'DELETE')
        if (!create && !update) return json(405, { error: 'method not allowed' }, req.origin)
        if (!originOk(req.origin)) return json(403, { error: 'origin not allowed' }, req.origin)
        if (create && maintenance.draining) return json(503, { error: maintenance.message ?? MAINTENANCE_NOTICE, maintenance: true }, req.origin)
        if (req.body === null) return json(413, { error: 'too large' }, req.origin)
        const limit = create ? listingCreateLimit : listingBeatLimit
        if (!limit.take(req.ip, deps.now())) {
          log('warn', create ? 'listing.create.limited' : 'listing.beat.limited', { ip: tag(req.ip) })
          return json(429, { error: 'Too many requests, try again in a minute.' }, req.origin)
        }
        let body: unknown = null
        try {
          body = req.body ? JSON.parse(req.body) : null
        } catch {
          return json(400, { error: 'expected JSON' }, req.origin)
        }
        if (create) {
          const r = listings.create(req.ip, body)
          if (!r.ok) {
            log('warn', 'listing.refused', { ip: tag(req.ip), status: r.status, error: r.error })
            return json(r.status, { error: r.error }, req.origin)
          }
          listCache = null
          log('info', 'listing.create', { ip: tag(req.ip), listings: listings.size })
          return json(201, { id: r.id, token: r.token, ttlS: LISTING_TTL_MS / 1000, heartbeatS: LISTING_HEARTBEAT_MS / 1000 }, req.origin)
        }
        const id = decodeURIComponent(parts[1])
        const r = req.method === 'PUT' ? listings.beat(id, body) : listings.remove(id, body)
        if (!r.ok) return json(r.status, { error: r.error }, req.origin)
        if (req.method === 'DELETE' && !r.gone) {
          listCache = null
          log('info', 'listing.remove', { ip: tag(req.ip), listings: listings.size })
        }
        return json(200, { ok: true, ...(r.gone ? { gone: true } : {}) }, req.origin)
      }
      if ((parts[0] === 'quickplay' || parts[0] === 'ranked') && parts.length === 1 && req.method === 'POST') {
        const ranked = parts[0] === 'ranked'
        if (maintenance.draining) return json(503, { error: maintenance.message ?? MAINTENANCE_NOTICE, maintenance: true }, req.origin)
        if (!originOk(req.origin)) return json(403, { error: 'origin not allowed' }, req.origin)
        if (ranked && !authority) return json(503, { error: 'Ranked matchmaking is unavailable: this server has no Elo storage.' }, req.origin)
        if (ranked && deps.accounts && !req.account) return json(401, { error: 'Sign in and choose your player name before joining ranked.' }, req.origin)
        if (!quickLimit.take(req.ip, deps.now())) {
          log('warn', 'quickplay.limited', { ip: tag(req.ip) })
          return json(429, { error: 'Too many quick-play requests, try again in a minute.' }, req.origin)
        }
        if (ranked && deps.accounts && req.account) {
          const game = await deps.accounts.game(req.account.id)
          if (game) {
            const e = game.region === cfg.region ? rooms.get(game.room) : undefined
            if (e) return json(200, { code: game.room, created: false, region: cfg.region }, req.origin)
            return json(409, { error: `You already have a ranked game in ${game.region}. Rejoin it from the main menu.`, game }, req.origin)
          }
        }
        if (maintenance.draining) return json(503, { error: maintenance.message ?? MAINTENANCE_NOTICE, maintenance: true }, req.origin)
        // New game from a results screen: never back into the room the player just left
        const open = openQuickRoom(ranked, url.searchParams.get('exclude'))
        if (open) {
          if (ranked && deps.accounts && req.account) {
            const claimed = await deps.accounts.claim(req.account.id, open.room.code, req.account.connection)
            if (!claimed.ok) return json(409, { error: 'You already have an active ranked game.', game: claimed.game, ...(claimed.conflict ? { rankedConflict: { kind: claimed.conflict, game: claimed.game } } : {}) }, req.origin)
            if (maintenance.draining) {
              deps.accounts.release(open.room.code, req.account.id)
              return json(503, { error: maintenance.message ?? MAINTENANCE_NOTICE, maintenance: true }, req.origin)
            }
            if (rooms.get(open.room.code) !== open) {
              deps.accounts.release(open.room.code, req.account.id)
              return json(409, { error: 'This room closed. Try Ranked again.' }, req.origin)
            }
            open.accounts.set(req.account.id, open.accounts.get(req.account.id) ?? 0)
            open.accountReservations.set(req.account.id, deps.now() + RESERVE_MS)
          }
          open.reserved.push(deps.now() + RESERVE_MS)
          log('info', 'quickplay.join', { room: open.room.code, ip: tag(req.ip) })
          return json(200, { code: open.room.code, created: false, region: cfg.region }, req.origin)
        }
        if (rooms.size + creating.size >= cfg.maxRooms) {
          log('warn', 'room.create.full', { rooms: rooms.size })
          return json(503, { error: 'The server is full right now.' }, req.origin)
        }
        const want = url.searchParams.get('bots') as BotDifficulty | null
        const bots = ranked ? cfg.ranked.bots : want && BOT_DIFFICULTIES.includes(want) ? want : BOT_DIFFICULTIES.includes(cfg.quickplay.bots) ? cfg.quickplay.bots : DEFAULT_SERVER_CONFIG.quickplay.bots
        const code = freeCode()
        creating.add(code)
        try {
          await newRoom(code, { quick: bots, ranked })
        } catch (error) {
          if (maintenance.draining) return json(503, { error: maintenance.message ?? MAINTENANCE_NOTICE, maintenance: true }, req.origin)
          throw error
        } finally {
          creating.delete(code)
        }
        if (maintenance.draining) {
          const entry = rooms.get(code)
          if (entry) closeRoom(code, entry)
          return json(503, { error: maintenance.message ?? MAINTENANCE_NOTICE, maintenance: true }, req.origin)
        }
        rooms.get(code)!.reserved.push(deps.now() + RESERVE_MS)
        if (ranked && deps.accounts && req.account) {
          const entry = rooms.get(code)!
          const claimed = await deps.accounts.claim(req.account.id, code, req.account.connection)
          if (!claimed.ok) {
            if (rooms.get(code) === entry) closeRoom(code, entry)
            return json(409, { error: 'You already have an active ranked game.', game: claimed.game, ...(claimed.conflict ? { rankedConflict: { kind: claimed.conflict, game: claimed.game } } : {}) }, req.origin)
          }
          if (maintenance.draining) {
            deps.accounts.release(code, req.account.id)
            if (rooms.get(code) === entry) closeRoom(code, entry)
            return json(503, { error: maintenance.message ?? MAINTENANCE_NOTICE, maintenance: true }, req.origin)
          }
          if (rooms.get(code) !== entry) {
            deps.accounts.release(code, req.account.id)
            return json(409, { error: 'This room closed. Try Ranked again.' }, req.origin)
          }
          entry.accounts.set(req.account.id, 0)
          entry.accountReservations.set(req.account.id, deps.now() + RESERVE_MS)
        }
        log('info', 'quickplay.create', { room: code, bots, ip: tag(req.ip) })
        return json(201, { code, created: true, region: cfg.region }, req.origin)
      }
      if (((parts[0] === 'leaderboard' || parts[0] === 'matches') && parts.length === 1) || ((parts[0] === 'players' || parts[0] === 'profiles') && (parts.length === 2 || (parts.length === 3 && parts[2] === 'history')))) {
        if (req.method !== 'GET') return json(405, { error: 'method not allowed' }, req.origin)
        if (!authority) return json(404, { error: 'This server keeps no leaderboard.' }, req.origin)
        if (!boardLimit.take(req.ip, deps.now())) {
          log('warn', 'leaderboard.limited', { ip: tag(req.ip) })
          return json(429, { error: 'Too many requests, try again in a minute.' }, req.origin)
        }
        // Reject invalid IDs locally too: the regional authority RPC deliberately
        // whitelists canonical public paths, so bad input must not become a 503.
        if (parts[0] === 'profiles' && !PUBLIC_PLAYER_ID.test(parts[1])) return json(400, { error: 'bad public player id' }, req.origin)
        try {
          const r = await authority.read(req.path)
          return json(r.status, r.body, req.origin)
        } catch (error) {
          log('error', 'leaderboard.read.error', { error: String(error) })
          return json(503, { error: 'Global ratings are temporarily unavailable.' }, req.origin)
        }
      }
      if (parts[0] === 'rooms' && parts.length === 2 && req.method === 'GET') {
        if (!lookupLimit.take(req.ip, deps.now())) {
          log('warn', 'room.lookup.limited', { ip: tag(req.ip) })
          return json(429, { error: 'Too many lookups, try again in a minute.' }, req.origin)
        }
        const parsed = parseRoomCode(parts[1])
        const e = 'code' in parsed ? rooms.get(parsed.code) : undefined
        if (!e) return json(200, { exists: false }, req.origin)
        const lobby = e.room.debug()
        return json(200, { code: e.room.code, exists: true, state: e.room.screen(), humans: e.room.humans(), peers: e.room.peers(), matchTick: lobby.tick }, req.origin)
      }
      return json(404, { error: 'not found' }, req.origin)
    },

    admit(path, ip, origin) {
      const url = new URL(path, 'http://x')
      if (url.pathname !== '/ws') return { kind: 'refuse', status: 404, reason: 'not found' }
      if (!originOk(origin)) {
        log('warn', 'ws.origin', { ip: tag(ip), origin })
        return { kind: 'refuse', status: 403, reason: 'origin not allowed' }
      }
      if (!connectLimit.take(ip, deps.now())) {
        log('warn', 'ws.connect.limited', { ip: tag(ip) })
        return { kind: 'refuse', status: 429, reason: 'too many connections' }
      }
      if ((conns.get(ip) ?? 0) >= cfg.maxConnsPerIp) {
        log('warn', 'ws.conns.limited', { ip: tag(ip) })
        return { kind: 'refuse', status: 429, reason: 'too many connections' }
      }
      const parsed = parseRoomCode(url.searchParams.get('room') ?? '')
      if ('problem' in parsed) return { kind: 'message', message: parsed.problem }
      if (!rooms.has(parsed.code)) return { kind: 'message', message: 'No room with that code. Ask for a fresh link.' }
      if (rooms.get(parsed.code)!.settling) return { kind: 'message', message: 'This match has finished and its room is closing. Join a new game.' }
      return { kind: 'room', code: parsed.code }
    },

    async authorize(code, account) {
      const e = rooms.get(code)
      if (!e) throw new Error('This room has closed.')
      if (e.settling) throw new Error('This match has finished and its room is closing. Join a new game.')
      if (maintenance.draining && account && !e.room.hasProfile(account.ratingKey)) throw new Error(maintenance.message ?? MAINTENANCE_NOTICE)
      if (!e.room.isRanked() || !deps.accounts) return
      if (!account) throw new Error('Sign in and choose your player name before joining ranked.')
      if (e.room.screen() === 'match' && !e.room.hasProfile(account.ratingKey)) {
        if ((e.accounts.get(account.id) ?? 0) === 0) { deps.accounts.release(code, account.id); e.accounts.delete(account.id); e.accountReservations.delete(account.id) }
        throw new Error('This ranked game has already started. Join the queue for another game.')
      }
      const claimed = await deps.accounts.claim(account.id, code, account.connection)
      if (!claimed.ok) {
        if (claimed.conflict) throw new RankedConflictError(claimed.conflict, claimed.game)
        throw new Error(`You already have a ranked game in ${claimed.game.region}. Rejoin it from the main menu.`)
      }
      if (maintenance.draining && !e.room.hasProfile(account.ratingKey)) {
        deps.accounts.release(code, account.id)
        throw new Error(maintenance.message ?? MAINTENANCE_NOTICE)
      }
      if (rooms.get(code) !== e || e.settling) { deps.accounts.release(code, account.id); throw new Error('This room has closed.') }
      e.accounts.set(account.id, e.accounts.get(account.id) ?? 0)
      e.accountReservations.set(account.id, deps.now() + RESERVE_MS)
    },

    attach(admission, socket, ip, account) {
      if (admission.kind === 'refuse') {
        socket.close()
        return
      }
      if (admission.kind === 'message') {
        socket.send(encode({ t: 'error', message: admission.message }))
        setTimeout(() => socket.close(), 200)
        return
      }
      const e = rooms.get(admission.code)
      if (!e || e.settling) {
        socket.send(encode({ t: 'error', message: 'This room just closed.' }))
        setTimeout(() => socket.close(), 200)
        return
      }
      connections++
      if (e.room.isRanked() && deps.accounts && !account) {
        connections--
        socket.send(encode({ t: 'error', message: 'Sign in before joining ranked.' })); socket.close(); return
      }
      if (account) e.accounts.set(account.id, (e.accounts.get(account.id) ?? 0) + 1)
      e.connections++
      conns.set(ip, (conns.get(ip) ?? 0) + 1)
      // Five seconds of burst: the server counts messages when it gets to them, and after a stall
      // of its own it reads seconds of a healthy client's queued input at once. A 2 s burst cut
      // such clients off in an overload (capacity run eu-1792879276534) and so deepened it.
      const msgs = new TokenBucket(cfg.msgsPerSec * 5, cfg.msgsPerSec, deps.now())
      const bytes = new TokenBucket(cfg.bytesPerSec * 5, cfg.bytesPerSec, deps.now())
      let done = false
      let transport: SocketTransport | null = null
      let handoffHeld = false
      const holdForHandoff = () => {
        if (done || handoffHeld) return
        handoffHeld = true
        e.reserved.push(deps.now() + RESERVE_MS)
      }
      const release = () => {
        if (done) return
        done = true
        connections--
        e.connections--
        if (account) {
          const remaining = Math.max(0, (e.accounts.get(account.id) ?? 1) - 1)
          e.accounts.set(account.id, remaining)
          if (remaining === 0 && e.room.screen() === 'match' && e.room.hasProfile(account.ratingKey)) deps.accounts?.disconnected(admission.code, account.id, account.connection.controller)
          if (remaining === 0 && (e.room.screen() !== 'match' || !e.room.hasProfile(account.ratingKey))) { deps.accounts?.release(admission.code, account.id); e.accounts.delete(account.id); e.accountReservations.delete(account.id) }
        }
        const n = (conns.get(ip) ?? 1) - 1
        if (n > 0) conns.set(ip, n)
        else conns.delete(ip)
      }
      // per-connection limits: a flooding client is cut off, its seat falls to the room's leave rules
      const limited: TextSocket = {
        holdForHandoff,
        send: (t) => socket.send(t),
        close: () => socket.close(),
        bufferedAmount: socket.bufferedAmount ? () => socket.bufferedAmount!() : undefined,
        onText(cb) {
          socket.onText((t) => {
            const now = deps.now()
            if (!msgs.take(now) || !bytes.take(now, t.length)) {
              log('warn', 'conn.rate.limited', { room: admission.code, ip: tag(ip) })
              socket.close()
              return
            }
            cb(t)
            if (account && e.room.hasProfile(account.ratingKey)) e.accountReservations.delete(account.id)
            if (e.room.humans() > 0) e.hadHuman = true
            closeEmptyQueue(admission.code, e)
          })
        },
        onClose(cb) {
          socket.onClose(() => {
            // Reuse the existing bounded connection reservation, only for an explicit handoff.
            if (transport?.transferring || socket.transferring?.()) holdForHandoff()
            release()
            cb()
            closeEmptyQueue(admission.code, e)
          })
        },
      }
      if (reservedNow(e) > 0) e.reserved.shift()
      log('info', 'ws.join', { room: admission.code, ip: tag(ip) })
      transport = new SocketTransport(limited, account)
      e.room.accept(transport)
      if (e.room.humans() > 0) e.hadHuman = true
    },

    async createRoom(opts = {}) {
      const code = opts.code ?? freeCode()
      const existing = rooms.get(code)
      if (existing) return existing.room
      if (maintenance.draining) throw new Error(maintenance.message ?? MAINTENANCE_NOTICE)
      return newRoom(code, opts)
    },

    room(code) {
      return rooms.get(code)?.room ?? null
    },

    sweep() {
      const now = deps.now()
      for (const [code, e] of rooms) {
        for (const [id, until] of e.accountReservations) if (until <= now && (e.accounts.get(id) ?? 0) === 0) {
          deps.accounts?.release(code, id); e.accounts.delete(id); e.accountReservations.delete(id)
        }
        closeEmptyQueue(code, e)
        if (rooms.get(code) !== e) continue
        if (e.room.peers() > 0) {
          e.emptySince = -1
          continue
        }
        if (reservedNow(e) > 0) continue
        if (e.emptySince < 0) e.emptySince = now
        else if (now - e.emptySince >= cfg.emptyRoomMs) {
          settleAndClose(code, e)
        }
      }
      createLimit.sweep(now)
      connectLimit.sweep(now)
      lookupLimit.sweep(now)
      listLimit.sweep(now)
      quickLimit.sweep(now)
      boardLimit.sweep(now)
      listingCreateLimit.sweep(now)
      listingBeatLimit.sweep(now)
      if (listings.sweep() > 0) listCache = null
    },

    close() {
      for (const e of rooms.values()) e.room.close()
      rooms.clear()
      deps.accounts?.close()
      authority?.close?.()
      deps.maintenance?.close()
    },

    stats() {
      return { rooms: rooms.size, players: players(), connections }
    },
    monitoring() {
      const all = [...rooms.values()].map((entry) => entry.room)
      return { rooms: all.map((room) => {
        const summary = room.summary()
        return { mode: summary.ranked ? 'ranked' : summary.quick ? 'casual' : 'custom', phase: summary.phase,
          round: summary.progress?.round ?? null, humans: summary.humans, bots: summary.bots }
      }), links: summarizeLinks(all.map((room) => room.netStats())) }
    },
    maintenance() {
      const activeMatches = [...rooms.values()].filter((entry) => entry.room.screen() === 'match').length
      const accountPending = deps.accounts?.pending?.() ?? { rewards: 0, releases: 0 }
      const pendingRatings = authority?.pending?.() ?? 0
      const settling = pendingResults + (deps.pendingAuthority?.() ?? 0)
      return { ...maintenance, rooms: rooms.size, players: players(), connections, activeMatches,
        waitingRooms: rooms.size - activeMatches, creatingRooms: creating.size, pendingResults: settling, pendingRatings,
        pendingRewards: accountPending.rewards, pendingReleases: accountPending.releases,
        ready: maintenance.draining && activeMatches === 0 && creating.size === 0 && settling === 0 && pendingRatings === 0 && accountPending.rewards === 0 && accountPending.releases === 0 }
    },
    setMaintenance(state) {
      if (!validMaintenance(state)) throw new Error('Invalid regional maintenance state')
      deps.maintenance?.set(state)
      maintenance = { ...state }
      listCache = null
      for (const entry of rooms.values()) entry.room.setMaintenance(state.draining ? state.message ?? MAINTENANCE_NOTICE : null)
      return core.maintenance()
    },
  }
  return core
}
