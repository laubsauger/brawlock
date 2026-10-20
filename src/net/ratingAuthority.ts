/** One server-side rating authority. Regions submit finished simulations, never client scores. */
import { LB_MIN_SECONDS, LB_TOP, publicRow, settleMatch, type BoardQuery, type BoardRow, type FinishedMatch, type LeaderboardStore, type StoredMatchHistory, type HistoryQueue } from './leaderboard'
import type { MatchRating } from './rating'
import { PASSIVE_ITEMS, SPELL_IDS } from '../sim/spells/data'
import type { PlayerMatchStats } from '../game/stats'
import { validHistoryBuild } from './matchHistory'

export interface RatingSubmission {
  key: string
  region: string
  room: string
  at: number
  minSeconds: number
  match: FinishedMatch
  queue?: HistoryQueue
}

export interface RatingRead { status: number; body: unknown }
export interface RatingAuthority {
  /** Durable undelivered result/rename operations; local authority has none. */
  pending?(): number
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
  applyReceipt(key: string, fingerprint: string, calculate: () => { rating: MatchRating; commit?: Parameters<LeaderboardStore['commit']>; history?: StoredMatchHistory }): MatchRating
}

const DEVICE = /^[A-Za-z0-9_-]{8,64}$/
const integer = (n: unknown, max: number) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= max
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const only = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every((k) => keys.includes(k))
export const PUBLIC_PLAYER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const STAT_NUMBERS = [
  'walked', 'pushed', 'longestFlight', 'teleported', 'damageDealt', 'damageTaken', 'knockbacksDealt', 'knockbacksTaken',
  'selfKills', 'lastHitKills', 'bestStreak', 'bestMulti', 'scourgeHits', 'teleportSaves', 'shieldReflects',
  'pillarsDestroyed', 'lavaDamage', 'roundsSurvived', 'goldEarned', 'goldSpent',
] as const
const SPELLS = new Set(SPELL_IDS)
const CAUSES = new Set([...SPELL_IDS, 'lava', 'obstacle', 'disconnect', 'unknown'])
const ITEMS = new Set([...SPELL_IDS, ...Object.keys(PASSIVE_ITEMS)])

/** Additive detail is complete, bounded server data; sparse legacy records omit it entirely. */
function validStats(value: unknown, ticks: number): value is PlayerMatchStats {
  if (!object(value) || !only(value, [...STAT_NUMBERS, 'firstBlood', 'aliveSec', 'lavaSec', 'killsByCause', 'deathsByCause', 'spells', 'topSpell'])
    || STAT_NUMBERS.some((key) => !integer(value[key], 1_000_000_000_000)) || typeof value.firstBlood !== 'boolean') return false
  for (const key of ['aliveSec', 'lavaSec']) {
    const n = value[key]
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > ticks / 60 + 1) return false
  }
  if ((value.lavaSec as number) > (value.aliveSec as number)) return false
  for (const key of ['killsByCause', 'deathsByCause']) {
    const rows = value[key]
    if (!object(rows) || Object.keys(rows).length > CAUSES.size
      || Object.entries(rows).some(([cause, count]) => !CAUSES.has(cause) || !integer(count, 1_000_000))) return false
  }
  if (!object(value.spells) || Object.keys(value.spells).length > SPELLS.size) return false
  for (const [id, row] of Object.entries(value.spells)) {
    if (!SPELLS.has(id) || !Array.isArray(row) || row.length !== 2 || !integer(row[0], 1_000_000) || !integer(row[1], row[0] as number)) return false
  }
  return value.topSpell === null || (Array.isArray(value.topSpell) && value.topSpell.length === 2
    && typeof value.topSpell[0] === 'string' && ITEMS.has(value.topSpell[0]) && integer(value.topSpell[1], 7) && value.topSpell[1] > 0)
}

/** Strict bounded validation at the trusted-server boundary, before SQL or Elo work. */
export function validRatingSubmission(v: unknown): v is RatingSubmission {
  if (!object(v) || !only(v, ['key', 'region', 'room', 'at', 'minSeconds', 'match', 'queue'])) return false
  if (typeof v.key !== 'string' || !/^[A-Za-z0-9:_-]{8,128}$/.test(v.key)
    || typeof v.region !== 'string' || !/^[A-Za-z0-9_-]{0,32}$/.test(v.region)
    || typeof v.room !== 'string' || !/^[A-Z]{5}$/.test(v.room)
    || !integer(v.at, 9_000_000_000_000) || !integer(v.minSeconds, 3600)) return false
  if (v.queue !== undefined && !['ranked', 'casual', 'custom'].includes(v.queue as string)) return false
  const m = v.match
  if (!object(m) || !only(m, ['ticks', 'rounds', 'teamMode', 'gameMode', 'bots', 'seats', 'ranked', 'roster', 'abandoned', 'combatPairs'])
    || !integer(m.ticks, 60 * 60 * 24 * 60) || !integer(m.rounds, 10000) || !integer(m.bots, 10)
    || typeof m.teamMode !== 'string' || !['ffa', 'teams', 'shuffle'].includes(m.teamMode)
    || typeof m.gameMode !== 'string' || !['rounds', 'deathmatch'].includes(m.gameMode)
    || !Array.isArray(m.seats) || m.seats.length > 10 || !Array.isArray(m.ranked) || m.ranked.length > 10000) return false
  if (m.abandoned !== undefined && typeof m.abandoned !== 'boolean') return false
  const players = new Set<number>()
  for (const s of m.seats) {
    if (!object(s) || !only(s, ['player', 'device', 'name', 'roundsPlayed', 'roundsWon', 'kills', 'deaths', 'won', 'stats', 'forfeited', 'combatTicks', 'build'])
      || !integer(s.player, 9) || players.has(s.player as number)
      || typeof s.device !== 'string' || !DEVICE.test(s.device)
      || typeof s.name !== 'string' || s.name.length === 0 || s.name.length > 24 || /[\u0000-\u001f\u007f]/.test(s.name)
      || !integer(s.roundsPlayed, 10000) || !integer(s.roundsWon, s.roundsPlayed as number)
      || !integer(s.kills, 1_000_000) || !integer(s.deaths, 1_000_000) || typeof s.won !== 'boolean'
      || (s.forfeited !== undefined && (typeof s.forfeited !== 'boolean' || (s.forfeited && s.won)))
      || (s.combatTicks !== undefined && !integer(s.combatTicks, m.ticks as number))
      || (s.build !== undefined && !validHistoryBuild(s.build))
      || (Object.hasOwn(s, 'stats') && !validStats(s.stats, m.ticks as number))) return false
    players.add(s.player as number)
  }
  if (m.combatPairs !== undefined) {
    if (!Array.isArray(m.combatPairs) || m.combatPairs.length > 45) return false
    const pairs = new Set<string>()
    for (const pair of m.combatPairs) {
      if (!object(pair) || !only(pair, ['players', 'ticks']) || !Array.isArray(pair.players) || pair.players.length !== 2
        || !pair.players.every((p) => integer(p, 9) && players.has(p)) || pair.players[0] >= pair.players[1]
        || !integer(pair.ticks, m.ticks as number)) return false
      const key = pair.players.join(':')
      if (pairs.has(key)) return false
      pairs.add(key)
    }
  }
  if (m.roster !== undefined) {
    if (!Array.isArray(m.roster) || m.roster.length > 10) return false
    const ids = new Set<number>()
    for (const p of m.roster) {
      if (!object(p) || !only(p, ['player', 'device', 'name', 'color', 'kind', 'team', 'score', 'roundsPlayed', 'roundsWon', 'kills', 'deaths', 'won', 'forfeited', 'build'])
        || !integer(p.player, 9) || ids.has(p.player as number) || typeof p.name !== 'string' || !p.name || p.name.length > 24 || /[\u0000-\u001f\u007f]/.test(p.name)
        || (p.device !== undefined && (typeof p.device !== 'string' || !DEVICE.test(p.device)))
        || (p.kind !== undefined && !['human', 'bot'].includes(p.kind as string))
        || (p.color !== undefined && !integer(p.color, 0xffffff)) || (p.team !== undefined && !integer(p.team, 9))
        || (p.score !== undefined && (typeof p.score !== 'number' || !Number.isFinite(p.score) || Math.abs(p.score) > 1_000_000))
        || !integer(p.kills, 1_000_000) || !integer(p.deaths, 1_000_000) || typeof p.won !== 'boolean'
        || (p.roundsPlayed !== undefined && !integer(p.roundsPlayed, 10000))
        || (p.roundsWon !== undefined && !integer(p.roundsWon, 10000))
        || (p.forfeited !== undefined && (typeof p.forfeited !== 'boolean' || (p.forfeited && p.won)))
        || (p.build !== undefined && !validHistoryBuild(p.build))) return false
      if (p.device !== undefined && !m.seats.some((s) => object(s) && s.player === p.player && s.device === p.device)) return false
      ids.add(p.player as number)
    }
    if (m.seats.some((s) => object(s) && !ids.has(s.player as number))) return false
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
export function localRatingAuthority(store: RatingReceiptStore, opts: { minSeconds?: number; clock?: () => number; names?: (devices: string[]) => Promise<Map<string, string>> } = {}): RatingAuthority {
  const clock = opts.clock ?? Date.now
  return {
    async record(s) {
      if (!validRatingSubmission(s)) throw new Error('Invalid rating submission')
      const fingerprint = await ratingFingerprint(s)
      return store.applyReceipt(s.key, fingerprint, () => {
        const m = s.match
        const current = store.players(m.seats.map((p) => p.device))
        const history: StoredMatchHistory | undefined = s.queue === undefined ? undefined : {
          queue: s.queue, at: s.at, region: s.region, room: s.room, ticks: m.ticks, rounds: m.rounds,
          teamMode: m.teamMode, gameMode: m.gameMode,
          players: m.roster ?? m.seats.map(({ stats: _stats, combatTicks: _ticks, ...seat }) => ({ ...seat, kind: 'human' as const })),
        }
        const settled = s.queue !== undefined && s.queue !== 'ranked'
          ? { skipped: 'Casual and custom games do not affect global Elo.' }
          : settleMatch(m, current, s.at, s.region, Math.max(opts.minSeconds ?? LB_MIN_SECONDS, s.minSeconds))
        if ('skipped' in settled) return { rating: { status: 'unrated', reason: settled.skipped }, history }
        if (history) history.deltas = Object.fromEntries(settled.results.map((r) => [r.device, { delta: r.delta, rating: r.rating }]))
        for (const player of settled.players) {
          const previous = current.get(player.device)
          if (!previous) continue
          if (previous.lastAt > s.at) player.name = previous.name
          player.firstAt = Math.min(previous.firstAt, s.at)
          player.lastAt = Math.max(previous.lastAt, s.at)
        }
        return { rating: { status: 'rated' }, history, commit: [
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
      const now = clock()
      const since = now - 7 * 24 * 3600 * 1000
      async function publicRows(rows: { rank: number; row: BoardRow }[]) {
        const changes = store.ratingChanges(rows.map(({ row }) => row.device), since, now)
        const names = opts.names ? await opts.names([...new Set(rows.map(({ row }) => row.device))]) : null
        return rows.map(({ rank, row }) => {
          const change = changes.get(row.device)
          if (change === undefined) throw new Error('Missing rating change for a stored leaderboard player')
          if (names && !names.has(row.device)) throw new Error('Missing canonical player name')
          return publicRow(rank, names ? { ...row, name: names.get(row.device)! } : row, change)
        })
      }
      const all: BoardQuery = { period: 'all', region: null, since: 0 }
      if ((parts[0] === 'players' || parts[0] === 'profiles') && parts.length === 3 && parts[2] === 'history') {
        let id: string
        try { id = decodeURIComponent(parts[1]) } catch { return { status: 400, body: { error: 'bad player id encoding' } } }
        if (parts[0] === 'players' ? !DEVICE.test(id) : !PUBLIC_PLAYER_ID.test(id)) return { status: 400, body: { error: 'bad player id' } }
        const queue = url.searchParams.get('queue')
        const limit = Number(url.searchParams.get('limit') ?? '10')
        if ((queue !== null && !['ranked', 'casual', 'custom'].includes(queue)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) return { status: 400, body: { error: 'Invalid history filter or limit (1–10).' } }
        const device = parts[0] === 'players' ? id : store.publicDevice(id)
        return { status: 200, body: { matches: device ? store.history(device, { queue: queue === null ? undefined : queue as HistoryQueue, limit }) : [] } }
      }
      if ((parts[0] === 'players' || parts[0] === 'profiles') && parts.length === 2) {
        let id: string
        try { id = decodeURIComponent(parts[1]) }
        catch { return { status: 400, body: { error: 'bad player id encoding' } } }
        if (parts[0] === 'players' ? !DEVICE.test(id) : !PUBLIC_PLAYER_ID.test(id)) {
          return { status: 400, body: { error: parts[0] === 'players' ? 'bad device id' : 'bad public player id' } }
        }
        const device = parts[0] === 'players' ? id : store.publicDevice(id)
        if (!device) return { status: 200, body: { found: false } }
        const r = store.rank(all, device)
        if (!r) return { status: 200, body: { found: false } }
        const p = store.players([device]).get(device)!
        const details = store.details(device)
        return { status: 200, body: { found: true, ...(await publicRows([r]))[0], firstAt: p.firstAt,
          coverage: { totalMatches: p.matches, detailedMatches: details?.detail.matches ?? 0,
            firstDetailedAt: details?.firstAt ?? null, lastDetailedAt: details?.lastAt ?? null },
          detail: details?.detail ?? null,
          recent: store.recent(device, 10).map((x) => ({ at: x.at, region: x.region, won: x.won, ...(x.forfeited === undefined ? {} : { forfeited: x.forfeited }), roundsPlayed: x.roundsPlayed, roundsWon: x.roundsWon, kills: x.kills, deaths: x.deaths, delta: Math.round(x.delta), rating: Math.round(x.rating) })) } }
      }
      if (url.pathname !== '/leaderboard') return { status: 404, body: { error: 'not found' } }
      const period = url.searchParams.get('period') ?? 'all'
      if (period !== 'all' && period !== 'week') return { status: 400, body: { error: 'period must be all or week' } }
      // A single global board, including when older clients still send region=.
      const q: BoardQuery = { period, region: null, since }
      const device = url.searchParams.get('device')
      const mine = device && DEVICE.test(device) ? store.rank(q, device) : null
      const entries = store.top(q, LB_TOP)
      const rows = await publicRows([...entries.map((row, i) => ({ rank: i + 1, row })), ...(mine ? [mine] : [])])
      return { status: 200, body: { period, region: '', entries: rows.slice(0, entries.length), you: mine ? rows[entries.length] : null } }
    },
    close: () => store.close(),
  }
}
