/**
 * Ranked global leaderboard (M4.3): server rooms only. The dedicated server records each
 * finished match it ran; clients never report outcomes. Player-hosted (P2P) games, listed
 * in Browse games or not, never reach it: the server does not run them.
 *
 * - Identity: the device id each human sent in `hello` (game/device.ts). It is never
 *   shown: the board shows the name and a short tag derived from it.
 * - Rating: Elo per match on the BOT_ELO scale (src/bots/presets.ts: Medium = 1000,
 *   400 points per 10:1 odds). The match's humans are ranked by its result: match winners
 *   first, then more round wins; equal standings are split by the rounds themselves (the
 *   share of rounds one placed above the other: round winners, then later deaths above
 *   earlier ones). Each pair of humans is one game; a player's change is averaged over their
 *   pairs, so K means "per match" at any player count. (Until 2026-10-19 every round was
 *   rated separately by survival order: a match winner who was knocked out by bots before
 *   the other human in the rounds bots won could lose rating to a player with no round win.)
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
import { MatchTracker, type PlayerMatchStats, type RecordedProfileCoverage, type RecordedProfileDetail } from '../game/stats'
import { hashString } from '../sim/snapshot'
import { TICK_HZ, type GameMode, type MatchSettings, type PlayerId, type PlayerSlot, type SimEvent, type SimState, type TeamMode } from '../sim/types'
import type { MatchRecorder } from './session'

/** a new device's rating: the Medium bot's (BOT_ELO anchor) */
export const LB_RATING_START = 1000
/** per match, averaged over each player's pairs */
export const LB_K = 40
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
  /** All combat (bots included), only when a human controlled this seat for the complete match.
   * Absent on legacy submissions, late joins and any bot-controlled interval. */
  stats?: PlayerMatchStats
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
  const players = [...seat.keys()].filter((p) => seat.get(p)!.roundsPlayed > 0)
  const rating = (p: PlayerId) => ratings.get(seat.get(p)!.device) ?? LB_RATING_START
  // team of each player in the last round they were ranked in (teammates are not rated)
  const team = new Map<PlayerId, number>()
  for (const round of m.ranked) for (const [p, t] of Object.entries(round.team)) team.set(Number(p), t)
  const teams = m.teamMode !== 'ffa'
  /** a's score against b: the match result, then round wins, then the share of rounds a placed above b */
  const score = (a: PlayerId, b: PlayerId): number => {
    const sa = seat.get(a)!
    const sb = seat.get(b)!
    if (sa.won !== sb.won) return sa.won ? 1 : 0
    if (sa.roundsWon !== sb.roundsWon) return sa.roundsWon > sb.roundsWon ? 1 : 0
    let above = 0
    let rounds = 0
    for (const round of m.ranked) {
      const pa = round.groups.findIndex((g) => g.includes(a))
      const pb = round.groups.findIndex((g) => g.includes(b))
      if (pa < 0 || pb < 0) continue
      rounds++
      above += pa < pb ? 1 : pa > pb ? 0 : 0.5
    }
    return rounds > 0 ? above / rounds : 0.5
  }
  const delta = new Map<PlayerId, number>()
  const pairs = new Map<PlayerId, number>()
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i]
      const b = players[j]
      if (teams && team.has(a) && team.get(a) === team.get(b)) continue
      const d = k * (score(a, b) - eloExpected(rating(a), rating(b)))
      delta.set(a, (delta.get(a) ?? 0) + d)
      delta.set(b, (delta.get(b) ?? 0) - d)
      pairs.set(a, (pairs.get(a) ?? 0) + 1)
      pairs.set(b, (pairs.get(b) ?? 0) + 1)
    }
  }
  return new Map(players.map((p) => [seat.get(p)!.device, pairs.get(p) ? delta.get(p)! / pairs.get(p)! : 0]))
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
  /** Bots present at the start, including seats humans take in later rounds. */
  private bots = 0
  private settings: MatchSettings | null = null
  /** seats a bot plays right now (their human left) */
  private botted = new Set<PlayerId>()
  private deaths: PlayerId[] = []
  private ranked: RoundRanking[] = []
  private team = new Map<PlayerId, number>()
  private alive = new Set<PlayerId>()
  /** The extra final rates only its contenders; benched seats keep their five-round totals. */
  private roundParticipants: Set<PlayerId> | null = null
  private active = false
  /** Same bounded counters as local profiles; no history or per-tick snapshots. */
  private details: MatchTracker | null = null
  private detailedSeats = new Set<PlayerId>()
  private observedDetails = false

  constructor(
    private readonly onDone: (m: FinishedMatch, result: MatchResult) => void | Promise<void>,
    private readonly onName?: (device: string, name: string) => void,
  ) {}

  displayName(slot: PlayerSlot, device?: string): void {
    if (slot.kind !== 'human' || !device) return
    const seat = this.seats.get(slot.id)
    if (seat?.device === device) seat.name = slot.name
    this.onName?.(device, slot.name)
  }

  start(info: { slots: PlayerSlot[]; settings: MatchSettings; devices?: Record<PlayerId, string> }): void {
    this.seats.clear()
    this.botted.clear()
    this.deaths = []
    this.ranked = []
    this.roundParticipants = null
    this.settings = info.settings
    this.details = new MatchTracker({ ...info, localPlayer: -1 })
    this.detailedSeats.clear()
    this.observedDetails = false
    this.bots = info.slots.filter((s) => s.kind === 'bot').length
    for (const s of info.slots) {
      const device = info.devices?.[s.id]
      if (s.kind !== 'human' || !device) continue
      this.seats.set(s.id, { player: s.id, device, name: s.name, roundsPlayed: 0, roundsWon: 0, kills: 0, deaths: 0, won: false })
      this.detailedSeats.add(s.id)
    }
    this.active = true
  }

  control(player: PlayerId, by: 'human' | 'bot'): void {
    if (by === 'bot') {
      this.botted.add(player)
      this.detailedSeats.delete(player)
    }
    else this.botted.delete(player)
  }

  /** A bot seat becomes human between rounds; its earlier bot rounds stay excluded. */
  join(slot: PlayerSlot, device?: string): void {
    if (!this.active || slot.kind !== 'human' || !device || this.seats.has(slot.id)) return
    this.seats.set(slot.id, { player: slot.id, device, name: slot.name, roundsPlayed: 0, roundsWon: 0, kills: 0, deaths: 0, won: false })
  }

  private human(p: PlayerId | null): SeatStats | null {
    return p !== null && !this.botted.has(p) && (!this.roundParticipants || this.roundParticipants.has(p)) ? (this.seats.get(p) ?? null) : null
  }

  observe(state: SimState, events: readonly SimEvent[]): void {
    if (!this.active) return
    if (this.details) {
      this.details.observe(state, events)
      this.observedDetails = true
    }
    // The final roster is selected during round 5's ending. That scoring round still
    // belongs to everyone; membership applies only once the extra fight has started.
    this.roundParticipants = state.rankedFinal && state.round > (this.settings?.rankedRounds ?? 0)
      ? new Set(state.rankedFinal.contenders)
      : null
    // teams (shuffle mode changes them per round) and survivors after these events
    this.team.clear()
    this.alive.clear()
    for (const sl of state.slots) {
      this.team.set(sl.id, sl.team)
      const seat = this.seats.get(sl.id)
      if (seat && sl.kind === 'human') seat.name = sl.name
    }
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

  finish(result: MatchResult): void | Promise<void> {
    if (!this.active || !this.settings) return
    this.active = false
    const winners = new Set(result.winners)
    for (const s of this.seats.values()) s.won = !this.botted.has(s.player) && winners.has(s.player)
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
    return this.onDone({
      ticks: result.ticks ?? 0,
      rounds: result.rounds,
      teamMode: this.settings.teamMode,
      gameMode: this.settings.gameMode,
      bots: this.bots,
      seats: [...this.seats.values()].map((s) => ({ ...s,
        ...(this.details && this.observedDetails && this.detailedSeats.has(s.player) ? { stats: this.details.statsOf(s.player) } : {}),
      })),
      ranked: this.ranked,
    }, result)
  }

  abort(): void {
    this.active = false
    this.details = null
    this.detailedSeats.clear()
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
  /** Optional additive detailed counters; never reconstructed for old results. */
  stats?: PlayerMatchStats
}

/** One line of the board as stored (device included: never sent out). */
export interface BoardRow {
  device: string
  publicId: string
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
  /** Refresh an existing player's display label; never creates a player or edits results. */
  rename(device: string, name: string): boolean
  /** one finished match, atomically: its results and the updated players */
  commit(match: { at: number; region: string; room: string; ticks: number; rounds: number; humans: number; bots: number }, results: ResultRow[], players: PlayerRow[]): void
  /** best first: 'all' by rating, 'week' by rating gained this week */
  top(q: BoardQuery, limit: number): BoardRow[]
  /** a device's line and 1-based rank in that board, null when it has none */
  rank(q: BoardQuery, device: string): { rank: number; row: BoardRow } | null
  /** latest results of a device, newest first */
  recent(device: string, limit: number): ResultRow[]
  /** Net rated Elo changes in an inclusive timestamp window, including zero for stored players without results. */
  ratingChanges(devices: string[], since: number, until: number): Map<string, number>
  /** Persistent opaque public identity; the private device id stays server-side. */
  publicDevice(publicId: string): string | null
  details(device: string): { detail: RecordedProfileDetail; firstAt: number; lastAt: number } | null
  close(): void
}

/** A board line as the API sends it: no device id. */
export interface PublicBoardRow {
  /** Stored random UUID, unrelated to a private device/profile id or display tag. */
  publicId: string
  rank: number
  name: string
  tag: string
  rating: number
  /** Net Elo change from counted matches in the rolling seven days ending at this response. */
  ratingChange7d: number
  gain: number
  matches: number
  wins: number
  roundsPlayed: number
  roundsWon: number
  kills: number
  deaths: number
  lastAt: number
}

export function publicRow(rank: number, r: BoardRow, ratingChange7d: number): PublicBoardRow {
  return {
    publicId: r.publicId,
    rank,
    name: r.name,
    tag: r.tag,
    rating: Math.round(r.rating),
    ratingChange7d: Math.round(ratingChange7d),
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

/** Complete recorded ranked matches only, including combat against bots.
 * Legacy results and interrupted/late-joined human seats remain outside this coverage. */
export type PublicProfileDetail = RecordedProfileDetail
export type PublicProfileCoverage = RecordedProfileCoverage

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
    results.push({ device: s.device, name: s.name, at: now, region, won: s.won, roundsPlayed: s.roundsPlayed, roundsWon: s.roundsWon, kills: s.kills, deaths: s.deaths, delta: d, rating,
      ...(s.stats ? { stats: s.stats } : {}),
    })
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
