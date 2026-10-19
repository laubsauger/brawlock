/**
 * Public listings of player-hosted (peer-to-peer) rooms: a directory on the game server,
 * so "Host from your PC" rooms show up in Browse games next to server rooms.
 *
 * The server never connects to the P2P host: it only stores what the host reports
 * (room code, host name, players, phase, mode). A listing lives while its host sends a
 * heartbeat (every ~10 s, TTL 30 s); only the holder of its secret token can update or
 * remove it. No device id, profile id or IP is ever part of a listing's public view.
 * Listed rooms are custom games: never ranked, never counted on the leaderboard (that
 * only counts matches a server ran itself, leaderboard.ts).
 */
import { parseRoomCode } from './code'
import { sanitizeName } from './protocol'
import type { GameMode, TeamMode } from '../sim/types'
import type { RoomProgress } from './roomProgress'

export const LISTING_TTL_MS = 30_000
export const LISTING_HEARTBEAT_MS = 10_000

export type ListingPhase = 'lobby' | 'match' | 'results'

/** What a host reports about its room. */
export interface ListingInfo {
  code: string
  host: string
  humans: number
  bots: number
  max: number
  /** Seats humans may claim, including replaceable bots. Full rooms stay discoverable for reconnects. */
  joinable?: number
  phase: ListingPhase
  /** Null clears the previous match when returning to the lobby. */
  progress?: RoomProgress | null
  teamMode: TeamMode
  gameMode: GameMode
  winScore: number
}

/** A listing as Browse games sees it (GET /rooms?public=1, `listings`). */
export interface ListingView extends ListingInfo {
  kind: 'p2p'
}

interface Listing extends ListingInfo {
  id: string
  token: string
  ip: string
  beat: number
}

export interface ListingLimits {
  ttlMs: number
  /** listings per server */
  maxTotal: number
  /** live listings per IP */
  perIp: number
  /** seats a listing may report at most (MAX_PLAYERS) */
  maxSeats: number
}

export type ListingResult<T = object> = ({ ok: true } & T) | { ok: false; status: number; error: string }

const PHASES: readonly ListingPhase[] = ['lobby', 'match', 'results']
const TEAM_MODES: readonly TeamMode[] = ['ffa', 'teams', 'shuffle']
const GAME_MODES: readonly GameMode[] = ['rounds', 'deathmatch']

const int = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null)

/** A full report (create) or the changed fields of one (heartbeat); a string = what is wrong. */
export function parseListing(v: unknown, maxSeats: number, partial: true): Partial<ListingInfo> | string
export function parseListing(v: unknown, maxSeats: number, partial?: false): ListingInfo | string
export function parseListing(v: unknown, maxSeats: number, partial = false): Partial<ListingInfo> | string {
  if (!v || typeof v !== 'object') return 'expected a JSON object'
  const o = v as Record<string, unknown>
  const out: Partial<ListingInfo> = {}
  const need = (k: keyof ListingInfo) => !partial || o[k] !== undefined
  if (need('code')) {
    const c = parseRoomCode(typeof o.code === 'string' ? o.code : '')
    if (!('code' in c)) return 'bad room code'
    out.code = c.code
  }
  if (need('host')) out.host = sanitizeName(o.host)
  for (const [k, lo, hi] of [
    ['humans', 0, maxSeats],
    ['bots', 0, maxSeats],
    ['max', 2, maxSeats],
    ['winScore', 1, 99],
  ] as const) {
    if (!need(k)) continue
    const n = int(o[k], lo, hi)
    if (n === null) return `bad ${k}`
    out[k] = n
  }
  if (need('phase')) {
    if (!PHASES.includes(o.phase as ListingPhase)) return 'bad phase'
    out.phase = o.phase as ListingPhase
  }
  if (o.joinable !== undefined) {
    const seats = int(o.joinable, 0, maxSeats)
    if (seats === null) return 'bad joinable'
    out.joinable = seats
  }
  if (o.progress !== undefined) {
    if (o.progress === null) out.progress = null
    else {
      if (typeof o.progress !== 'object') return 'bad progress'
      const p = o.progress as Record<string, unknown>
      const round = int(p.round, 1, Number.MAX_SAFE_INTEGER)
      const elapsedSeconds = int(p.elapsedSeconds, 0, Number.MAX_SAFE_INTEGER)
      if (round === null || elapsedSeconds === null || typeof p.final !== 'boolean' || !['warmup', 'shop', 'fight', 'roundEnd', 'gameOver'].includes(p.phase as string)) return 'bad progress'
      out.progress = { round, elapsedSeconds, phase: p.phase as RoomProgress['phase'], final: p.final }
    }
  }
  if (need('teamMode')) {
    if (!TEAM_MODES.includes(o.teamMode as TeamMode)) return 'bad teamMode'
    out.teamMode = o.teamMode as TeamMode
  }
  if (need('gameMode')) {
    if (!GAME_MODES.includes(o.gameMode as GameMode)) return 'bad gameMode'
    out.gameMode = o.gameMode as GameMode
  }
  return out
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

/** Same length and content, without an early exit. */
function sameToken(a: string, b: unknown): boolean {
  if (typeof b !== 'string' || a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

/** In memory: listings are seconds-lived and re-sent by their hosts, a restart loses nothing that matters. */
export class ListingDirectory {
  private readonly byId = new Map<string, Listing>()

  constructor(
    private readonly limits: ListingLimits,
    private readonly now: () => number,
  ) {}

  get size(): number {
    return this.byId.size
  }

  create(ip: string, body: unknown): ListingResult<{ id: string; token: string }> {
    this.sweep()
    const info = parseListing(body, this.limits.maxSeats)
    if (typeof info === 'string') return { ok: false, status: 400, error: info }
    if (this.byId.size >= this.limits.maxTotal) return { ok: false, status: 503, error: 'Too many listed games right now.' }
    let mine = 0
    for (const l of this.byId.values()) {
      if (l.ip === ip) mine++
      if (l.code === info.code) return { ok: false, status: 409, error: 'That room is already listed.' }
    }
    if (mine >= this.limits.perIp) return { ok: false, status: 429, error: 'Too many listed games from your network.' }
    const id = randomHex(6)
    const token = randomHex(16)
    this.byId.set(id, { ...info, id, token, ip, beat: this.now() })
    return { ok: true, id, token }
  }

  /** Heartbeat with optional changes. `gone`: no such listing (expired or removed): list again. */
  beat(id: string, body: unknown): ListingResult<{ gone?: boolean }> {
    const l = this.live(id)
    if (!l) return { ok: true, gone: true }
    const b = (body ?? {}) as { token?: unknown }
    if (!sameToken(l.token, b.token)) return { ok: false, status: 403, error: 'bad token' }
    const patch = parseListing(body, this.limits.maxSeats, true)
    if (typeof patch === 'string') return { ok: false, status: 400, error: patch }
    // the code is the listing's identity: a host with a new code lists anew
    if (patch.code !== undefined && patch.code !== l.code) return { ok: false, status: 400, error: 'the code cannot change' }
    Object.assign(l, patch, { beat: this.now() })
    return { ok: true }
  }

  remove(id: string, body: unknown): ListingResult<{ gone?: boolean }> {
    const l = this.live(id)
    if (!l) return { ok: true, gone: true }
    if (!sameToken(l.token, (body as { token?: unknown } | null)?.token)) return { ok: false, status: 403, error: 'bad token' }
    this.byId.delete(id)
    return { ok: true }
  }

  /** Live listings, public view (no id, token or IP). */
  list(): ListingView[] {
    this.sweep()
    return [...this.byId.values()].map((l) => ({
      kind: 'p2p',
      code: l.code,
      host: l.host,
      humans: l.humans,
      bots: l.bots,
      max: l.max,
      ...(l.joinable !== undefined ? { joinable: l.joinable } : {}),
      phase: l.phase,
      ...(l.progress !== undefined ? { progress: l.phase === 'lobby' ? null : l.progress } : {}),
      teamMode: l.teamMode,
      gameMode: l.gameMode,
      winScore: l.winScore,
    }))
  }

  /** Drop listings whose host stopped sending heartbeats. */
  sweep(): number {
    const now = this.now()
    let n = 0
    for (const [id, l] of this.byId) {
      if (now - l.beat >= this.limits.ttlMs) {
        this.byId.delete(id)
        n++
      }
    }
    return n
  }

  private live(id: string): Listing | null {
    const l = this.byId.get(id)
    if (!l) return null
    if (this.now() - l.beat >= this.limits.ttlMs) {
      this.byId.delete(id)
      return null
    }
    return l
  }
}
