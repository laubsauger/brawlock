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
 * WebSocket: /ws?room=CODE joins that room (session protocol, ws.ts). The first connected
 * human owns the room (lobby controls via `ctl`). A room nobody is connected to closes
 * after emptyRoomMs. IPs are only logged as salted hashes.
 */
import { hashString } from '../sim/snapshot'
import { newRoomCode, parseRoomCode } from './code'
import { createRoom, type QuickPlayPolicy, type Room, type RoomDeps, type RoomSummary } from './dedicated'
import { LISTING_HEARTBEAT_MS, LISTING_TTL_MS, ListingDirectory } from './listings'
import { LB_MIN_SECONDS, LB_TOP, publicRow, settleMatch, type BoardQuery, type FinishedMatch, type LeaderboardStore, type Period } from './leaderboard'
import { MAX_PLAYERS } from './session'
import { PROTOCOL_VERSION, encode } from './protocol'
import { KeyedLimiter, TokenBucket } from './ratelimit'
import { SocketTransport, type TextSocket } from './ws'
import type { BotDifficulty, MatchSettings } from '../sim/types'
import type { MatchRating } from './rating'

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
  quickplay: {
    fillMs: 10_000, startMs: 5_000, nextMs: 10_000, seats: 10, fill: 10, bots: 'brutal',
    settings: { startGold: 40, roundGold: 12, killGold: 2, winGold: 3 },
  },
  leaderboardMinSeconds: LB_MIN_SECONDS,
  listingCreatesPerMin: 6,
  listingBeatsPerMin: 30,
  listingsPerIp: 3,
  maxListings: 500,
}

/** how long the public room list and a leaderboard page are served from cache (server clock) */
const LIST_CACHE_MS = 1000
const BOARD_CACHE_MS = 5000
/** a quick-play seat handed out is held this long for its player to connect */
const RESERVE_MS = 15_000
const WEEK_MS = 7 * 24 * 3600 * 1000
const BOT_DIFFICULTIES: readonly BotDifficulty[] = ['dummy', 'easy', 'medium', 'hard', 'brutal', 'uber']
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/

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
}

export interface ServerCore {
  http(req: HttpRequest): Promise<HttpResponse>
  admit(path: string, ip: string, origin: string | null): Admission
  /** an accepted socket: into its room (code from admit) or told why not (message) */
  attach(admission: Admission, socket: TextSocket, ip: string): void
  /** create a room directly (CLI demo rooms, tests) */
  createRoom(opts?: RoomSetup): Promise<Room>
  room(code: string): Room | null
  /** sweep empty rooms and idle limiter state; call every few seconds */
  sweep(): void
  close(): void
  stats(): { rooms: number; players: number; connections: number }
}

export function createServerCore(
  cfg: ServerConfig,
  deps: RoomDeps & {
    log: LogFn
    now: () => number
    /** finished server matches are rated and stored here (none: no leaderboard) */
    leaderboard?: LeaderboardStore
    /** ms since epoch, for stored results (default Date.now) */
    clock?: () => number
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
  const store = deps.leaderboard ?? null
  let listCache: { at: number; body: unknown } | null = null
  const listings = new ListingDirectory({ ttlMs: LISTING_TTL_MS, maxTotal: cfg.maxListings, perIp: cfg.listingsPerIp, maxSeats: MAX_PLAYERS }, deps.now)
  const listingCreateLimit = new KeyedLimiter(cfg.listingCreatesPerMin, cfg.listingCreatesPerMin / 60)
  const listingBeatLimit = new KeyedLimiter(cfg.listingBeatsPerMin, cfg.listingBeatsPerMin / 60)
  const boardCache = new Map<string, { at: number; entries: unknown }>()
  const conns = new Map<string, number>()
  let connections = 0
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
    for (const e of rooms.values()) n += e.room.humans()
    return n
  }

  async function newRoom(code: string, setup: RoomSetup = {}): Promise<Room> {
    const room = await createRoom(
      {
        code,
        bots: setup.bots ?? [],
        auto: setup.auto ?? false,
        settings: setup.quick ? { botsReplaceLeavers: true, ...DEFAULT_SERVER_CONFIG.quickplay.settings, ...cfg.quickplay.settings, ...setup.settings } : setup.settings,
        autoStartMs: setup.autoStartMs,
        rematchMs: setup.rematchMs,
        ...(setup.quick ? { quick: { fillMs: cfg.quickplay.fillMs, startMs: cfg.quickplay.startMs, nextMs: cfg.quickplay.nextMs, seats: cfg.quickplay.seats, fill: cfg.quickplay.fill, bots: setup.quick } } : {}),
        public: setup.public,
        elo: { enabled: !!store, minSeconds: cfg.leaderboardMinSeconds },
        onMatch: (m, result) => { result.rating = record(code, m) },
        onName: (device, name) => {
          if (!store) return
          try {
            if (store.rename(device, name)) boardCache.clear()
          } catch (error) {
            log('error', 'leaderboard.error', { room: code, error: String(error) })
          }
        },
        log: (msg) => log('info', 'room.policy', { room: code, msg }),
      },
      deps,
    )
    rooms.set(code, { room, created: deps.now(), emptySince: deps.now(), reserved: [] })
    log('info', 'room.created', { room: code, rooms: rooms.size, ...(setup.quick ? { quick: true } : {}) })
    return room
  }

  /** A finished server match: rated and stored when it counts (leaderboard.ts). */
  function record(room: string, m: FinishedMatch): MatchRating {
    if (!store) return { status: 'unrated', reason: 'This server does not record global Elo.' }
    try {
      const devices = m.seats.map((x) => x.device)
      const settled = settleMatch(m, store.players(devices), clock(), cfg.region, cfg.leaderboardMinSeconds)
      if ('skipped' in settled) {
        log('info', 'leaderboard.skip', { room, reason: settled.skipped, humans: m.seats.length, ticks: m.ticks })
        return { status: 'unrated', reason: settled.skipped }
      }
      store.commit({ at: clock(), region: cfg.region, room, ticks: m.ticks, rounds: m.rounds, humans: m.seats.length, bots: m.bots }, settled.results, settled.players)
      boardCache.clear()
      log('info', 'leaderboard.match', { room, players: settled.players.length, rounds: m.rounds })
      return { status: 'rated' }
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

  /** Public games with an available human seat or bot reservation. Fullest first, then oldest. */
  function openQuickRoom(): Entry | null {
    let best: Entry | null = null
    let bestN = -1
    for (const e of rooms.values()) {
      const r = e.room
      if (!r.isPublic()) continue
      const phase = r.screen()
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
      .filter((e) => e.room.isPublic() && e.room.screen() !== 'menu')
      .map((e) => e.room.summary())
      .sort((a, b) => order(a) - order(b) || b.humans - a.humans || a.code.localeCompare(b.code))
    listCache = { at: now, body: { region: cfg.region, rooms: list, listings: listings.list() } }
    return listCache.body
  }

  function boardQuery(url: URL): BoardQuery | null {
    const period = (url.searchParams.get('period') ?? 'all') as Period
    if (period !== 'all' && period !== 'week') return null
    const region = url.searchParams.get('region') || null
    return { period, region, since: clock() - WEEK_MS }
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
        return json(200, { ok: true, build: cfg.build, protocol: PROTOCOL_VERSION, region: cfg.region, listings: listings.size, rooms: rooms.size, maxRooms: cfg.maxRooms, players: players(), connections, uptimeS: Math.round((deps.now() - started) / 1000) }, req.origin)
      }
      if (parts[0] === 'rooms' && parts.length === 1 && req.method === 'POST') {
        if (!originOk(req.origin)) return json(403, { error: 'origin not allowed' }, req.origin)
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
        } finally {
          creating.delete(code)
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
      if (parts[0] === 'quickplay' && parts.length === 1 && req.method === 'POST') {
        if (!originOk(req.origin)) return json(403, { error: 'origin not allowed' }, req.origin)
        if (!quickLimit.take(req.ip, deps.now())) {
          log('warn', 'quickplay.limited', { ip: tag(req.ip) })
          return json(429, { error: 'Too many quick-play requests, try again in a minute.' }, req.origin)
        }
        const open = openQuickRoom()
        if (open) {
          open.reserved.push(deps.now() + RESERVE_MS)
          log('info', 'quickplay.join', { room: open.room.code, ip: tag(req.ip) })
          return json(200, { code: open.room.code, created: false, region: cfg.region }, req.origin)
        }
        if (rooms.size + creating.size >= cfg.maxRooms) {
          log('warn', 'room.create.full', { rooms: rooms.size })
          return json(503, { error: 'The server is full right now.' }, req.origin)
        }
        const want = url.searchParams.get('bots') as BotDifficulty | null
        const bots = want && BOT_DIFFICULTIES.includes(want) ? want : BOT_DIFFICULTIES.includes(cfg.quickplay.bots) ? cfg.quickplay.bots : DEFAULT_SERVER_CONFIG.quickplay.bots
        const code = freeCode()
        creating.add(code)
        try {
          await newRoom(code, { quick: bots })
        } finally {
          creating.delete(code)
        }
        rooms.get(code)!.reserved.push(deps.now() + RESERVE_MS)
        log('info', 'quickplay.create', { room: code, bots, ip: tag(req.ip) })
        return json(201, { code, created: true, region: cfg.region }, req.origin)
      }
      if ((parts[0] === 'leaderboard' && parts.length === 1) || (parts[0] === 'players' && parts.length === 2)) {
        if (req.method !== 'GET') return json(405, { error: 'method not allowed' }, req.origin)
        if (!store) return json(404, { error: 'This server keeps no leaderboard.' }, req.origin)
        if (!boardLimit.take(req.ip, deps.now())) {
          log('warn', 'leaderboard.limited', { ip: tag(req.ip) })
          return json(429, { error: 'Too many requests, try again in a minute.' }, req.origin)
        }
        if (parts[0] === 'players') {
          const device = decodeURIComponent(parts[1])
          if (!DEVICE_ID.test(device)) return json(400, { error: 'bad device id' }, req.origin)
          const all: BoardQuery = { period: 'all', region: null, since: 0 }
          const r = store.rank(all, device)
          if (!r) return json(200, { found: false }, req.origin)
          const p = store.players([device]).get(device)!
          return json(
            200,
            {
              found: true,
              ...publicRow(r.rank, r.row),
              firstAt: p.firstAt,
              recent: store.recent(device, 10).map((x) => ({ at: x.at, region: x.region, won: x.won, roundsPlayed: x.roundsPlayed, roundsWon: x.roundsWon, kills: x.kills, deaths: x.deaths, delta: Math.round(x.delta), rating: Math.round(x.rating) })),
            },
            req.origin,
          )
        }
        const q = boardQuery(url)
        if (!q) return json(400, { error: 'period must be all or week' }, req.origin)
        const key = `${q.period}|${q.region ?? ''}`
        let cached = boardCache.get(key)
        if (!cached || deps.now() - cached.at >= BOARD_CACHE_MS) {
          cached = { at: deps.now(), entries: store.top(q, LB_TOP).map((row, i) => publicRow(i + 1, row)) }
          boardCache.set(key, cached)
        }
        const device = url.searchParams.get('device')
        const mine = device && DEVICE_ID.test(device) ? store.rank(q, device) : null
        return json(200, { period: q.period, region: q.region ?? cfg.region, entries: cached.entries, you: mine ? publicRow(mine.rank, mine.row) : null }, req.origin)
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
      return { kind: 'room', code: parsed.code }
    },

    attach(admission, socket, ip) {
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
      if (!e) {
        socket.send(encode({ t: 'error', message: 'This room just closed.' }))
        setTimeout(() => socket.close(), 200)
        return
      }
      connections++
      conns.set(ip, (conns.get(ip) ?? 0) + 1)
      const msgs = new TokenBucket(cfg.msgsPerSec * 2, cfg.msgsPerSec, deps.now())
      const bytes = new TokenBucket(cfg.bytesPerSec * 2, cfg.bytesPerSec, deps.now())
      let done = false
      const release = () => {
        if (done) return
        done = true
        connections--
        const n = (conns.get(ip) ?? 1) - 1
        if (n > 0) conns.set(ip, n)
        else conns.delete(ip)
      }
      // per-connection limits: a flooding client is cut off, its seat falls to the room's leave rules
      const limited: TextSocket = {
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
          })
        },
        onClose(cb) {
          socket.onClose(() => {
            release()
            cb()
          })
        },
      }
      if (reservedNow(e) > 0) e.reserved.shift()
      log('info', 'ws.join', { room: admission.code, ip: tag(ip) })
      e.room.accept(new SocketTransport(limited))
    },

    async createRoom(opts = {}) {
      const code = opts.code ?? freeCode()
      const existing = rooms.get(code)
      if (existing) return existing.room
      return newRoom(code, opts)
    },

    room(code) {
      return rooms.get(code)?.room ?? null
    },

    sweep() {
      const now = deps.now()
      for (const [code, e] of rooms) {
        if (e.room.peers() > 0) {
          e.emptySince = -1
          continue
        }
        if (e.emptySince < 0) e.emptySince = now
        else if (now - e.emptySince >= cfg.emptyRoomMs) {
          e.room.close()
          rooms.delete(code)
          log('info', 'room.closed', { room: code, reason: 'empty', rooms: rooms.size })
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
      store?.close()
    },

    stats() {
      return { rooms: rooms.size, players: players(), connections }
    },
  }
  return core
}
