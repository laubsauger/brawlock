/**
 * Casual global leaderboard (M4.3): server rooms only. The dedicated server records each
 * finished match it ran; clients never report outcomes.
 *
 * - Identity: the device id each human sent in `hello` (game/device.ts). It is never
 *   shown: the board shows the name and a short tag derived from it.
 * - Rating: Elo per round on the BOT_ELO scale (src/bots/presets.ts: Medium = 1000,
 *   400 points per 10:1 odds). Every round ranks its human players (round winners first,
 *   then later deaths above earlier ones) and each pair of them is one game. A player's
 *   change is averaged over their pairs (the same rule as game/stats.ts eloUpdate), so K
 *   means "per round" at any player count.
 * - Bots never count: no rating from rounds against them, no kills of them, no deaths to
 *   them. A seat a bot took over (its player left) stops counting from then on.
 * - Eligible matches only: at least 2 distinct devices in human seats (a second tab of
 *   the same browser shares its device id), at least 2 minutes long, and at least one
 *   round with 2 humans in it.
 *
 * Pure: the tracker turns a match's state / event stream into a FinishedMatch, rateMatch
 * turns that into rating changes. Storage is server/leaderboard-store.mjs (node:sqlite).
 */
import type { MatchResult } from '../game/store'
import { hashString } from '../sim/snapshot'
import { TICK_HZ, type GameMode, type MatchSettings, type PlayerId, type PlayerSlot, type SimEvent, type SimState, type TeamMode } from '../sim/types'
import type { MatchRecorder } from './session'

/** a new device's rating: the Medium bot's (BOT_ELO anchor) */
export const LB_RATING_START = 1000
/** per round, averaged over the round's pairs */
export const LB_K = 20
export const LB_MIN_HUMANS = 2
export const LB_MIN_SECONDS = 120
export const LB_TOP = 100

/** One human seat of a finished match. */
export interface SeatStats {
  player: PlayerId
  device: string
  name: string
  roundsPlayed: number
  roundsWon: number
  /** humans this player killed */
  kills: number
  /** deaths to a human or to the player's own mistake (lava, own blast); deaths to bots excluded */
  deaths: number
  /** among the match's winners */
  won: boolean
}

/** One round: its human players ranked, best first (a group shares a place). */
export interface RoundRanking {
  groups: PlayerId[][]
  /** team of each ranked player in that round (teammates are not rated against each other) */
  team: Record<PlayerId, number>
}

export interface FinishedMatch {
  ticks: number
  rounds: number
  teamMode: TeamMode
  gameMode: GameMode
  bots: number
  /** human seats that sent a device id */
  seats: SeatStats[]
  ranked: RoundRanking[]
}

/** Why a match does not count (null: it counts). */
export function ineligible(m: FinishedMatch, minSeconds = LB_MIN_SECONDS): string | null {
  const devices = countedDevices(m)
  if (devices.size < LB_MIN_HUMANS) return 'fewer than 2 humans'
  if (m.ticks < minSeconds * TICK_HZ) return `shorter than ${minSeconds} s`
  const byPlayer = seatsByPlayer(m)
  if (!m.ranked.some((r) => r.groups.flat().filter((p) => byPlayer.has(p)).length >= 2)) return 'no round between humans'
  return null
}

/** Devices in exactly one human seat (one device playing two seats counts for neither). */
function countedDevices(m: FinishedMatch): Set<string> {
  const n = new Map<string, number>()
  for (const s of m.seats) n.set(s.device, (n.get(s.device) ?? 0) + 1)
  return new Set([...n].filter(([, c]) => c === 1).map(([d]) => d))
}

function seatsByPlayer(m: FinishedMatch): Map<PlayerId, SeatStats> {
  const ok = countedDevices(m)
  return new Map(m.seats.filter((s) => ok.has(s.device)).map((s) => [s.player, s]))
}

export function eloExpected(a: number, b: number): number {
  return 1 / (1 + Math.pow(10, (b - a) / 400))
}

/**
 * Rating changes of one eligible match, round by round. `ratings`: current rating per
 * device (missing = LB_RATING_START). Returns the change per counted device.
 */
export function rateMatch(m: FinishedMatch, ratings: ReadonlyMap<string, number>, k = LB_K): Map<string, number> {
  const seat = seatsByPlayer(m)
  const r = new Map<string, number>()
  for (const s of seat.values()) r.set(s.device, ratings.get(s.device) ?? LB_RATING_START)
  const start = new Map(r)
  const teams = m.teamMode !== 'ffa'
  for (const round of m.ranked) {
    const place = new Map<PlayerId, number>()
    round.groups.forEach((g, i) => g.forEach((p) => seat.has(p) && place.set(p, i)))
    const players = [...place.keys()]
    if (players.length < 2) continue
    const delta = new Map<PlayerId, number>()
    const pairs = new Map<PlayerId, number>()
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const a = players[i]
        const b = players[j]
        if (teams && round.team[a] === round.team[b]) continue
        const pa = place.get(a)!
        const pb = place.get(b)!
        const s = pa < pb ? 1 : pa > pb ? 0 : 0.5
        const d = k * (s - eloExpected(r.get(seat.get(a)!.device)!, r.get(seat.get(b)!.device)!))
        delta.set(a, (delta.get(a) ?? 0) + d)
        delta.set(b, (delta.get(b) ?? 0) - d)
        pairs.set(a, (pairs.get(a) ?? 0) + 1)
        pairs.set(b, (pairs.get(b) ?? 0) + 1)
      }
    }
    for (const [p, d] of delta) {
      const dev = seat.get(p)!.device
      r.set(dev, r.get(dev)! + d / pairs.get(p)!)
    }
  }
  return new Map([...r].map(([d, v]) => [d, v - start.get(d)!]))
}

/** Public tag of a device: 5 base-36 characters, stable, says nothing about the id. */
export function deviceTag(device: string): string {
  return hashString(`brawlock-tag:${device}`).toString(36).padStart(7, '0').slice(-5)
}

/**
 * Server-side MatchRecorder: per round, which humans placed where; per seat, kills,
 * deaths and rounds. Bounded memory (counters only).
 */
export class ServerMatchTracker implements MatchRecorder {
  private seats = new Map<PlayerId, SeatStats>()
  private bots = 0
  private settings: MatchSettings | null = null
  /** seats a bot plays right now (their human left) */
  private botted = new Set<PlayerId>()
  private deaths: PlayerId[] = []
  private ranked: RoundRanking[] = []
  private team = new Map<PlayerId, number>()
  private alive = new Set<PlayerId>()
  private active = false

  constructor(private readonly onDone: (m: FinishedMatch) => void) {}

  start(info: { slots: PlayerSlot[]; settings: MatchSettings; devices?: Record<PlayerId, string> }): void {
    this.seats.clear()
    this.botted.clear()
    this.deaths = []
    this.ranked = []
    this.settings = info.settings
    this.bots = info.slots.filter((s) => s.kind === 'bot').length
    for (const s of info.slots) {
      const device = info.devices?.[s.id]
      if (s.kind !== 'human' || !device) continue
      this.seats.set(s.id, { player: s.id, device, name: s.name, roundsPlayed: 0, roundsWon: 0, kills: 0, deaths: 0, won: false })
    }
    this.active = true
  }

  control(player: PlayerId, by: 'human' | 'bot'): void {
    if (by === 'bot') this.botted.add(player)
    else this.botted.delete(player)
  }

  private human(p: PlayerId | null): SeatStats | null {
    return p !== null && !this.botted.has(p) ? (this.seats.get(p) ?? null) : null
  }

  observe(state: SimState, events: readonly SimEvent[]): void {
    if (!this.active) return
    // teams (shuffle mode changes them per round) and survivors after these events
    this.team.clear()
    this.alive.clear()
    for (const sl of state.slots) this.team.set(sl.id, sl.team)
    for (const p of state.pawns) if (p.alive) this.alive.add(p.owner)
    for (const e of events) {
      if (e.type === 'death') {
        if (!this.deaths.includes(e.owner)) this.deaths.push(e.owner)
        const victim = this.human(e.owner)
        if (!victim || e.cause === 'disconnect') continue
        if (e.killer === null || e.killer === e.owner) victim.deaths++
        else {
          const killer = this.human(e.killer)
          if (killer) {
            killer.kills++
            victim.deaths++
          }
        }
      } else if (e.type === 'roundWin') this.endRound(e.players)
    }
  }

  private endRound(winners: readonly PlayerId[]): void {
    const counted = (p: PlayerId) => this.human(p) !== null
    const win = winners.filter(counted)
    const standing = [...this.alive].filter((p) => counted(p) && !win.includes(p))
    const dead = [...this.deaths].reverse().filter((p) => counted(p) && !win.includes(p) && !standing.includes(p))
    const groups = [win, standing, ...dead.map((p) => [p])].filter((g) => g.length > 0)
    const players = groups.flat()
    const team: Record<PlayerId, number> = {}
    for (const p of players) team[p] = this.team.get(p) ?? p
    for (const p of players) this.seats.get(p)!.roundsPlayed++
    for (const p of win) this.seats.get(p)!.roundsWon++
    if (players.length > 0) this.ranked.push({ groups, team })
    this.deaths = []
  }

  finish(result: MatchResult): void {
    if (!this.active || !this.settings) return
    this.active = false
    const winners = new Set(result.winners)
    for (const s of this.seats.values()) s.won = winners.has(s.player)
    // deathmatch (no rounds): the whole match is one ranking by score
    if (this.ranked.length === 0 && result.scores.length > 0) {
      const score = new Map(result.scores.map((x) => [x.id, x.score]))
      const players = [...this.seats.keys()].filter((p) => !this.botted.has(p) && score.has(p))
      const levels = [...new Set(players.map((p) => score.get(p)!))].sort((a, b) => b - a)
      const groups = levels.map((v) => players.filter((p) => score.get(p) === v))
      const team: Record<PlayerId, number> = {}
      for (const p of players) team[p] = this.team.get(p) ?? p
      if (players.length > 0) this.ranked.push({ groups, team })
      for (const p of players) this.seats.get(p)!.roundsPlayed++
    }
    this.onDone({
      ticks: result.ticks ?? 0,
      rounds: result.rounds,
      teamMode: this.settings.teamMode,
      gameMode: this.settings.gameMode,
      bots: this.bots,
      seats: [...this.seats.values()].map((s) => ({ ...s })),
      ranked: this.ranked,
    })
  }

  abort(): void {
    this.active = false
  }
}

// ---------------------------------------------------------------------------
// Storage contract (server/leaderboard-store.mjs) and API shapes
// ---------------------------------------------------------------------------

export type Period = 'all' | 'week'

/** One stored player (one device). */
export interface PlayerRow {
  device: string
  name: string
  tag: string
  rating: number
  matches: number
  wins: number
  roundsPlayed: number
  roundsWon: number
  kills: number
  deaths: number
  /** ms since epoch */
  firstAt: number
  lastAt: number
}

/** One stored match result of one device. */
export interface ResultRow {
  device: string
  name: string
  at: number
  region: string
  won: boolean
  roundsPlayed: number
  roundsWon: number
  kills: number
  deaths: number
  /** rating change and rating after */
  delta: number
  rating: number
}

/** One line of the board as stored (device included: never sent out). */
export interface BoardRow {
  device: string
  name: string
  tag: string
  rating: number
  /** period 'week': rating gained this week; 'all': same as rating - LB_RATING_START */
  gain: number
  matches: number
  wins: number
  roundsPlayed: number
  roundsWon: number
  kills: number
  deaths: number
  lastAt: number
}

export interface BoardQuery {
  period: Period
  /** only devices with a result in this region (null: every result this server holds) */
  region: string | null
  /** period 'week': results since this time (ms since epoch) */
  since: number
}

export interface LeaderboardStore {
  /** current rows of these devices */
  players(devices: string[]): Map<string, PlayerRow>
  /** one finished match, atomically: its results and the updated players */
  commit(match: { at: number; region: string; room: string; ticks: number; rounds: number; humans: number; bots: number }, results: ResultRow[], players: PlayerRow[]): void
  /** best first: 'all' by rating, 'week' by rating gained this week */
  top(q: BoardQuery, limit: number): BoardRow[]
  /** a device's line and 1-based rank in that board, null when it has none */
  rank(q: BoardQuery, device: string): { rank: number; row: BoardRow } | null
  /** latest results of a device, newest first */
  recent(device: string, limit: number): ResultRow[]
  close(): void
}

/** A board line as the API sends it: no device id. */
export interface PublicBoardRow {
  rank: number
  name: string
  tag: string
  rating: number
  gain: number
  matches: number
  wins: number
  roundsPlayed: number
  roundsWon: number
  kills: number
  deaths: number
  lastAt: number
}

export function publicRow(rank: number, r: BoardRow): PublicBoardRow {
  return {
    rank,
    name: r.name,
    tag: r.tag,
    rating: Math.round(r.rating),
    gain: Math.round(r.gain),
    matches: r.matches,
    wins: r.wins,
    roundsPlayed: r.roundsPlayed,
    roundsWon: r.roundsWon,
    kills: r.kills,
    deaths: r.deaths,
    lastAt: r.lastAt,
  }
}

/**
 * Turn an eligible match into the rows to store. `now`: ms since epoch. Returns null
 * (with the reason) when the match does not count.
 */
export function settleMatch(
  m: FinishedMatch,
  current: ReadonlyMap<string, PlayerRow>,
  now: number,
  region: string,
  minSeconds = LB_MIN_SECONDS,
): { results: ResultRow[]; players: PlayerRow[] } | { skipped: string } {
  const why = ineligible(m, minSeconds)
  if (why) return { skipped: why }
  const seat = seatsByPlayer(m)
  const ratings = new Map<string, number>()
  for (const s of seat.values()) ratings.set(s.device, current.get(s.device)?.rating ?? LB_RATING_START)
  const delta = rateMatch(m, ratings)
  const results: ResultRow[] = []
  const players: PlayerRow[] = []
  for (const s of seat.values()) {
    if (s.roundsPlayed === 0) continue
    const d = delta.get(s.device) ?? 0
    const before = current.get(s.device)
    const rating = (before?.rating ?? LB_RATING_START) + d
    results.push({ device: s.device, name: s.name, at: now, region, won: s.won, roundsPlayed: s.roundsPlayed, roundsWon: s.roundsWon, kills: s.kills, deaths: s.deaths, delta: d, rating })
    players.push({
      device: s.device,
      name: s.name,
      tag: deviceTag(s.device),
      rating,
      matches: (before?.matches ?? 0) + 1,
      wins: (before?.wins ?? 0) + (s.won ? 1 : 0),
      roundsPlayed: (before?.roundsPlayed ?? 0) + s.roundsPlayed,
      roundsWon: (before?.roundsWon ?? 0) + s.roundsWon,
      kills: (before?.kills ?? 0) + s.kills,
      deaths: (before?.deaths ?? 0) + s.deaths,
      firstAt: before?.firstAt ?? now,
      lastAt: now,
    })
  }
  return { results, players }
}
