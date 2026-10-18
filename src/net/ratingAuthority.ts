/** One server-side rating authority. Regions submit finished simulations, never client scores. */
import { LB_MIN_SECONDS, LB_TOP, publicRow, settleMatch, type BoardQuery, type FinishedMatch, type LeaderboardStore } from './leaderboard'
import type { MatchRating } from './rating'

export interface RatingSubmission {
  key: string
  region: string
  room: string
  at: number
  minSeconds: number
  match: FinishedMatch
}

export interface RatingRead { status: number; body: unknown }
export interface RatingAuthority {
  record(submission: RatingSubmission): Promise<MatchRating>
  rename(device: string, name: string): Promise<boolean>
  read(path: string): Promise<RatingRead>
  close?(): void
}

/** Additive SQLite capabilities; legacy commits remain readable and unchanged. */
export interface RatingReceiptStore extends LeaderboardStore {
  receipt(key: string, fingerprint: string): MatchRating | null
  rememberReceipt(key: string, fingerprint: string, rating: MatchRating): void
  commitReceipt(key: string, fingerprint: string, rating: MatchRating, ...args: Parameters<LeaderboardStore['commit']>): void
  /** Calculation reads and the write share the same lock, including across rolling processes. */
  applyReceipt(key: string, fingerprint: string, calculate: () => { rating: MatchRating; commit?: Parameters<LeaderboardStore['commit']> }): MatchRating
}

const DEVICE = /^[A-Za-z0-9_-]{8,64}$/
const integer = (n: unknown, max: number) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= max
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const only = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every((k) => keys.includes(k))

/** Strict bounded validation at the trusted-server boundary, before SQL or Elo work. */
export function validRatingSubmission(v: unknown): v is RatingSubmission {
  if (!object(v) || !only(v, ['key', 'region', 'room', 'at', 'minSeconds', 'match'])) return false
  if (typeof v.key !== 'string' || !/^[A-Za-z0-9:_-]{8,128}$/.test(v.key)
    || typeof v.region !== 'string' || !/^[A-Za-z0-9_-]{0,32}$/.test(v.region)
    || typeof v.room !== 'string' || !/^[A-Z]{5}$/.test(v.room)
    || !integer(v.at, 9_000_000_000_000) || !integer(v.minSeconds, 3600)) return false
  const m = v.match
  if (!object(m) || !only(m, ['ticks', 'rounds', 'teamMode', 'gameMode', 'bots', 'seats', 'ranked'])
    || !integer(m.ticks, 60 * 60 * 24 * 60) || !integer(m.rounds, 10000) || !integer(m.bots, 10)
    || typeof m.teamMode !== 'string' || !['ffa', 'teams', 'shuffle'].includes(m.teamMode)
    || typeof m.gameMode !== 'string' || !['rounds', 'deathmatch'].includes(m.gameMode)
    || !Array.isArray(m.seats) || m.seats.length > 10 || !Array.isArray(m.ranked) || m.ranked.length > 10000) return false
  const players = new Set<number>()
  for (const s of m.seats) {
    if (!object(s) || !only(s, ['player', 'device', 'name', 'roundsPlayed', 'roundsWon', 'kills', 'deaths', 'won'])
      || !integer(s.player, 9) || players.has(s.player as number)
      || typeof s.device !== 'string' || !DEVICE.test(s.device)
      || typeof s.name !== 'string' || s.name.length === 0 || s.name.length > 24 || /[\u0000-\u001f\u007f]/.test(s.name)
      || !integer(s.roundsPlayed, 10000) || !integer(s.roundsWon, s.roundsPlayed as number)
      || !integer(s.kills, 1_000_000) || !integer(s.deaths, 1_000_000) || typeof s.won !== 'boolean') return false
    players.add(s.player as number)
  }
  for (const r of m.ranked) {
    if (!object(r) || !only(r, ['groups', 'team']) || !Array.isArray(r.groups) || r.groups.length > 10 || !object(r.team)) return false
    const seen = new Set<number>()
    for (const group of r.groups) {
      if (!Array.isArray(group) || group.length === 0 || group.length > 10) return false
      for (const p of group) {
        if (!integer(p, 9) || !players.has(p) || seen.has(p)) return false
        seen.add(p)
      }
    }
    for (const [p, team] of Object.entries(r.team)) if (!/^\d$/.test(p) || !players.has(Number(p)) || !integer(team, 9)) return false
    if ([...seen].some((p) => !Object.hasOwn(r.team as object, String(p)))) return false
  }
  return true
}

/** JSON key order must not make a retried request look like a different match. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (object(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}

export async function ratingFingerprint(v: RatingSubmission): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(v)))
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Preserves the existing database and rating formula; only receipt storage is new. */
export function localRatingAuthority(store: RatingReceiptStore, opts: { minSeconds?: number; clock?: () => number } = {}): RatingAuthority {
  const clock = opts.clock ?? Date.now
  return {
    async record(s) {
      if (!validRatingSubmission(s)) throw new Error('Invalid rating submission')
      const fingerprint = await ratingFingerprint(s)
      return store.applyReceipt(s.key, fingerprint, () => {
        const m = s.match
        const current = store.players(m.seats.map((p) => p.device))
        const settled = settleMatch(m, current, s.at, s.region, Math.max(opts.minSeconds ?? LB_MIN_SECONDS, s.minSeconds))
        if ('skipped' in settled) return { rating: { status: 'unrated', reason: settled.skipped } }
        for (const player of settled.players) {
          const previous = current.get(player.device)
          if (!previous) continue
          if (previous.lastAt > s.at) player.name = previous.name
          player.firstAt = Math.min(previous.firstAt, s.at)
          player.lastAt = Math.max(previous.lastAt, s.at)
        }
        return { rating: { status: 'rated' }, commit: [
          { at: s.at, region: s.region, room: s.room, ticks: m.ticks, rounds: m.rounds, humans: m.seats.length, bots: m.bots }, settled.results, settled.players,
        ] }
      })
    },
    async rename(device, name) {
      if (!DEVICE.test(device) || !name || name.length > 24 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Invalid rating display label')
      return store.rename(device, name)
    },
    async read(path) {
      const url = new URL(path, 'http://rating')
      const parts = url.pathname.split('/').filter(Boolean)
      const all: BoardQuery = { period: 'all', region: null, since: 0 }
      if (parts[0] === 'players' && parts.length === 2) {
        const device = decodeURIComponent(parts[1])
        if (!DEVICE.test(device)) return { status: 400, body: { error: 'bad device id' } }
        const r = store.rank(all, device)
        if (!r) return { status: 200, body: { found: false } }
        const p = store.players([device]).get(device)!
        return { status: 200, body: { found: true, ...publicRow(r.rank, r.row), firstAt: p.firstAt,
          recent: store.recent(device, 10).map((x) => ({ at: x.at, region: x.region, won: x.won, roundsPlayed: x.roundsPlayed, roundsWon: x.roundsWon, kills: x.kills, deaths: x.deaths, delta: Math.round(x.delta), rating: Math.round(x.rating) })) } }
      }
      if (url.pathname !== '/leaderboard') return { status: 404, body: { error: 'not found' } }
      const period = url.searchParams.get('period') ?? 'all'
      if (period !== 'all' && period !== 'week') return { status: 400, body: { error: 'period must be all or week' } }
      // A single global board, including when older clients still send region=.
      const q: BoardQuery = { period, region: null, since: clock() - 7 * 24 * 3600 * 1000 }
      const device = url.searchParams.get('device')
      const mine = device && DEVICE.test(device) ? store.rank(q, device) : null
      return { status: 200, body: { period, region: '', entries: store.top(q, LB_TOP).map((row, i) => publicRow(i + 1, row)), you: mine ? publicRow(mine.rank, mine.row) : null } }
    },
    close: () => store.close(),
  }
}
