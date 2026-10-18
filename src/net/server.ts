/**
 * Dedicated server core (M4.1, docs/M4.md §11): room registry, HTTP API, WebSocket
 * admission, rate limits and structured logs. Transport-agnostic and typed:
 * server/listen.mjs binds it to Node's http server and upgraded sockets.
 *
 * HTTP (JSON, CORS):
 *   GET  /health        {ok, build, protocol, region, rooms, maxRooms, players, connections, uptimeS}
 *                       (clients time it for the region ping, so it stays cheap)
 *   POST /rooms         create a room → 201 {code, build, protocol}; 429 rate limited, 503 full
 *   GET  /rooms/:code   {code, exists: true, state, humans, peers, matchTick} or 404 {exists: false}
 * WebSocket: /ws?room=CODE joins that room (session protocol, ws.ts). The first connected
 * human owns the room (lobby controls via `ctl`). A room nobody is connected to closes
 * after emptyRoomMs. IPs are only logged as salted hashes.
 */
import { hashString } from '../sim/snapshot'
import { newRoomCode, parseRoomCode } from './code'
import { createRoom, type Room, type RoomDeps } from './dedicated'
import { PROTOCOL_VERSION, encode } from './protocol'
import { KeyedLimiter, TokenBucket } from './ratelimit'
import { SocketTransport, type TextSocket } from './ws'
import type { BotDifficulty, MatchSettings } from '../sim/types'

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
}

export type LogLevel = 'info' | 'warn' | 'error'
export type LogFn = (level: LogLevel, event: string, fields?: Record<string, unknown>) => void

export interface HttpRequest {
  method: string
  /** path with query, e.g. '/rooms/ABCDE' */
  path: string
  ip: string
  origin: string | null
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
}

interface Entry {
  room: Room
  created: number
  emptySince: number
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

export function createServerCore(cfg: ServerConfig, deps: RoomDeps & { log: LogFn; now: () => number }): ServerCore {
  const rooms = new Map<string, Entry>()
  const creating = new Set<string>()
  const started = deps.now()
  const salt = Math.floor(Math.random() * 0x7fffffff).toString(36)
  const tag = (ip: string) => hashString(salt + ip).toString(36)
  const createLimit = new KeyedLimiter(cfg.roomCreatesPerMin, cfg.roomCreatesPerMin / 60)
  const connectLimit = new KeyedLimiter(cfg.connectsPerMin, cfg.connectsPerMin / 60)
  const lookupLimit = new KeyedLimiter(cfg.lookupsPerMin, cfg.lookupsPerMin / 60)
  const conns = new Map<string, number>()
  let connections = 0
  const log = deps.log

  const originOk = (origin: string | null) => cfg.allowedOrigins === null || (origin !== null && cfg.allowedOrigins.includes(origin))

  function cors(origin: string | null): Record<string, string> {
    const allow = cfg.allowedOrigins === null ? '*' : origin && cfg.allowedOrigins.includes(origin) ? origin : 'null'
    return {
      'access-control-allow-origin': allow,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
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
        settings: setup.settings,
        autoStartMs: setup.autoStartMs,
        rematchMs: setup.rematchMs,
        log: (msg) => log('info', 'room.policy', { room: code, msg }),
      },
      deps,
    )
    rooms.set(code, { room, created: deps.now(), emptySince: deps.now() })
    log('info', 'room.created', { room: code, rooms: rooms.size })
    return room
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
        return json(200, { ok: true, build: cfg.build, protocol: PROTOCOL_VERSION, region: cfg.region, rooms: rooms.size, maxRooms: cfg.maxRooms, players: players(), connections, uptimeS: Math.round((deps.now() - started) / 1000) }, req.origin)
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
      if (parts[0] === 'rooms' && parts.length === 2 && req.method === 'GET') {
        if (!lookupLimit.take(req.ip, deps.now())) {
          log('warn', 'room.lookup.limited', { ip: tag(req.ip) })
          return json(429, { error: 'Too many lookups, try again in a minute.' }, req.origin)
        }
        const parsed = parseRoomCode(parts[1])
        const e = 'code' in parsed ? rooms.get(parsed.code) : undefined
        if (!e) return json(404, { exists: false }, req.origin)
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
    },

    close() {
      for (const e of rooms.values()) e.room.close()
      rooms.clear()
    },

    stats() {
      return { rooms: rooms.size, players: players(), connections }
    },
  }
  return core
}
