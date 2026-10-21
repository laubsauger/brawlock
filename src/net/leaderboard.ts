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
import { MatchTracker, mergeMatchStats, type PlayerMatchStats, type RecordedProfileCoverage, type RecordedProfileDetail } from '../game/stats'
import { hashString } from '../sim/snapshot'
import { TICK_HZ, type GameMode, type MatchSettings, type PlayerId, type PlayerSlot, type SimEvent, type SimState, type TeamMode } from '../sim/types'
import type { MatchRecorder } from './session'
import type { InspectedKit } from '../game/inspect'

/** a new device's rating: the Medium bot's (BOT_ELO anchor) */
export const LB_RATING_START = 1000
/** per match, averaged over each player's pairs */
export const LB_K = 40
export const LB_MIN_HUMANS = 2
export const LB_MIN_SECONDS = 120
/** A departed human owes a match loss after one minute of combat participation. */
export const LB_FORFEIT_SECONDS = 60
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
  /** Human-controlled combat of a seat without complete coverage (late join, bot interval,
   * departure, aborted match): only the intervals a human played, merged. Never with `stats`. */
  partialStats?: PlayerMatchStats
  /** Ticks (every phase) this seat was human-controlled; sent with `partialStats`. */
  controlTicks?: number
  forfeited?: boolean
  combatTicks?: number
  build?: InspectedKit
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
  roster?: HistoryPlayer[]
  abandoned?: boolean
  /** Ended without any result (operational stop, simulation failure, room closed mid-match):
   * carries only partial combat activity; never rated, never history, never rewards. */
  aborted?: boolean
  /** Overlapping combat participation by distinct human seats; bounded to 45 pairs. */
  combatPairs?: { players: [PlayerId, PlayerId]; ticks: number }[]
}

/** Why a match does not count (null: it counts). */
export function ineligible(m: FinishedMatch, minSeconds = LB_MIN_SECONDS): string | null {
  const devices = countedDevices(m)
  if (devices.size < LB_MIN_HUMANS) return 'fewer than 2 humans'
  // A qualifying departure cannot erase a first-round result by making the
  // entire room empty before the ordinary two-minute completion threshold.
  if (qualifyingForfeitPairs(m).length > 0) return null
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

function qualifyingForfeitPairs(m: FinishedMatch): { players: [PlayerId, PlayerId]; ticks: number }[] {
  const seats = seatsByPlayer(m)
  return (m.combatPairs ?? []).filter(({ players, ticks }) => ticks >= LB_FORFEIT_SECONDS * TICK_HZ
    && players.every((p) => (seats.get(p)?.combatTicks ?? 0) >= LB_FORFEIT_SECONDS * TICK_HZ)
    && players.some((p) => seats.get(p)?.forfeited === true))
}

/** One unique human's combat from a ranked game that has no complete-match detail for them. */
export interface UnfinishedActivity {
  device: string
  stats: PlayerMatchStats
  /** human-controlled time, whole seconds */
  seconds: number
}

/**
 * Ranked combat that complete-match detail leaves out: aborted games, unrated games, late
 * joins, bot-controlled intervals and departures. Only human-controlled intervals (the
 * tracker's `partialStats`; a complete but unrated seat's `stats`), only devices in exactly
 * one seat, only seats with human fight time. `covered`: devices whose complete stats were
 * folded as detail for this same match. Wins, Elo, match counts and rewards never read this.
 */
export function unfinishedActivity(m: FinishedMatch, covered: ReadonlySet<string>): UnfinishedActivity[] {
  return [...seatsByPlayer(m).values()].flatMap((s) => {
    if (covered.has(s.device) || !((s.combatTicks ?? 0) > 0)) return []
    const stats = s.stats ?? s.partialStats
    if (!stats) return []
    return [{ device: s.device, stats, seconds: Math.round((s.stats ? m.ticks : (s.controlTicks ?? 0)) / TICK_HZ) }]
  })
}

function ratingParticipants(m: FinishedMatch): Set<PlayerId> {
  return new Set([...m.seats.filter((s) => s.roundsPlayed > 0).map((s) => s.player), ...qualifyingForfeitPairs(m).flatMap((p) => p.players)])
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
  const participating = ratingParticipants(m)
  const players = [...seat.keys()].filter((p) => participating.has(p))
  const rating = (p: PlayerId) => ratings.get(seat.get(p)!.device) ?? LB_RATING_START
  // team of each player in the last round they were ranked in (teammates are not rated)
  const team = new Map<PlayerId, number>()
  for (const p of m.roster ?? []) if (p.team !== undefined) team.set(p.player, p.team)
  for (const round of m.ranked) for (const [p, t] of Object.entries(round.team)) team.set(Number(p), t)
  const teams = m.teamMode !== 'ffa'
  /** a's score against b: the match result, then round wins, then the share of rounds a placed above b */
  const score = (a: PlayerId, b: PlayerId): number => {
    const sa = seat.get(a)!
    const sb = seat.get(b)!
    if (sa.forfeited) return 0
    if (sb.forfeited) return 1
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
      // A first-round leaver is rated only against humans they actually shared
      // the qualifying combat minute with, never against later bot-seat joins.
      if ((seat.get(a)!.roundsPlayed === 0 || seat.get(b)!.roundsPlayed === 0)
        && !qualifyingForfeitPairs(m).some((p) => p.players.includes(a) && p.players.includes(b))) continue
      const da = k * (score(a, b) - eloExpected(rating(a), rating(b)))
      const db = k * (score(b, a) - eloExpected(rating(b), rating(a)))
      delta.set(a, (delta.get(a) ?? 0) + da)
      delta.set(b, (delta.get(b) ?? 0) + db)
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
  private lastTick = 0
  private lastPhase: SimState['phase'] | null = null
  private combatPairs = new Map<string, { players: [PlayerId, PlayerId]; ticks: number }>()
  private roster = new Map<PlayerId, HistoryPlayer>()
  /** Closed human-controlled pieces of seats that lost complete coverage. */
  private pieces = new Map<PlayerId, PlayerMatchStats[]>()
  /** The open human-controlled piece of such a seat: a tracker that only saw this interval. */
  private intervals = new Map<PlayerId, MatchTracker>()
  private controlTicks = new Map<PlayerId, number>()
  /** First blood counts for a seat only if its human, not a replacement bot, drew it. */
  private firstBloodHuman: PlayerId | null = null
  private slots: PlayerSlot[] = []
  private round = 0

  constructor(
    private readonly onDone: (m: FinishedMatch, result: MatchResult) => void | Promise<void>,
    private readonly onName?: (device: string, name: string) => void,
    /** `partial`: record human-controlled pieces (default on). `onAbort`: a match that ends
     * without a result hands its partial activity here, once. */
    private readonly opts: { partial?: boolean; onAbort?: (m: FinishedMatch) => void | Promise<unknown> } = {},
  ) {}

  displayName(slot: PlayerSlot, device?: string): void {
    if (slot.kind !== 'human' || !device) return
    const seat = this.seats.get(slot.id)
    if (seat?.device === device) seat.name = slot.name
    this.onName?.(device, slot.name)
  }

  start(info: { slots: PlayerSlot[]; settings: MatchSettings; devices?: Record<PlayerId, string> }): void {
    // A new match never silently drops the activity of one that did not end.
    if (this.active) this.abort()
    this.pieces.clear()
    this.intervals.clear()
    this.controlTicks.clear()
    this.firstBloodHuman = null
    this.slots = info.slots
    this.round = 0
    this.seats.clear()
    this.botted.clear()
    this.deaths = []
    this.ranked = []
    this.roundParticipants = null
    this.settings = info.settings
    this.details = new MatchTracker({ ...info, localPlayer: -1 })
    this.detailedSeats.clear()
    this.observedDetails = false
    this.lastTick = 0
    this.lastPhase = null
    this.combatPairs.clear()
    this.roster.clear()
    this.bots = info.slots.filter((s) => s.kind === 'bot').length
    for (const s of info.slots) {
      const device = info.devices?.[s.id]
      this.roster.set(s.id, { player: s.id, name: s.name, color: s.color, kind: s.kind, team: s.team,
        ...(s.kind === 'human' && device ? { device } : {}), kills: 0, deaths: 0, won: false })
      if (s.kind !== 'human' || !device) continue
      this.seats.set(s.id, { player: s.id, device, name: s.name, roundsPlayed: 0, roundsWon: 0, kills: 0, deaths: 0, won: false, combatTicks: 0 })
      this.detailedSeats.add(s.id)
    }
    this.active = true
  }

  control(player: PlayerId, by: 'human' | 'bot'): void {
    if (!this.active) return
    if (by === 'bot') {
      this.closePiece(player)
      this.botted.add(player)
      this.detailedSeats.delete(player)
    } else {
      this.botted.delete(player)
      this.openPiece(player)
    }
  }

  private get partial(): boolean {
    return this.opts.partial !== false
  }

  /** The human hands the seat to a bot: keep what they played so far as one piece. */
  private closePiece(player: PlayerId): void {
    if (!this.partial || !this.seats.has(player)) return
    const open = this.intervals.get(player)
    const piece = open ? open.statsOf(player)
      : this.detailedSeats.has(player) && this.details && this.observedDetails ? this.details.statsOf(player) : null
    this.intervals.delete(player)
    if (piece) this.pieces.set(player, [...(this.pieces.get(player) ?? []), piece])
  }

  /** A human (back or new) controls the seat: a fresh tracker sees only this interval. */
  private openPiece(player: PlayerId): void {
    if (!this.partial || !this.settings || !this.seats.has(player) || this.detailedSeats.has(player) || this.intervals.has(player)) return
    this.intervals.set(player, new MatchTracker({ slots: this.slots, settings: this.settings, localPlayer: -1 }))
  }

  /** All human-controlled pieces of a seat merged; `whole`: include complete coverage too. */
  private partialOf(player: PlayerId, whole: boolean): PlayerMatchStats | null {
    const parts = [...(this.pieces.get(player) ?? [])]
    const open = this.intervals.get(player)
    if (open) parts.push(open.statsOf(player))
    if (whole && this.detailedSeats.has(player) && this.details && this.observedDetails) parts.push(this.details.statsOf(player))
    if (parts.length === 0) return null
    // Interval trackers each see their own "first" kill; the whole match has one first blood.
    return { ...parts.reduce(mergeMatchStats), firstBlood: this.firstBloodHuman === player }
  }

  /** A bot seat becomes human between rounds; its earlier bot rounds stay excluded. */
  join(slot: PlayerSlot, device?: string): void {
    if (!this.active || slot.kind !== 'human' || !device || this.seats.has(slot.id)) return
    this.seats.set(slot.id, { player: slot.id, device, name: slot.name, roundsPlayed: 0, roundsWon: 0, kills: 0, deaths: 0, won: false, combatTicks: 0 })
    this.roster.set(slot.id, { player: slot.id, device, name: slot.name, color: slot.color, kind: 'human', team: slot.team, kills: 0, deaths: 0, won: false })
  }

  private human(p: PlayerId | null): SeatStats | null {
    return p !== null && !this.botted.has(p) && (!this.roundParticipants || this.roundParticipants.has(p)) ? (this.seats.get(p) ?? null) : null
  }

  observe(state: SimState, events: readonly SimEvent[]): void {
    if (!this.active) return
    if (this.details) {
      const before = this.details.firstBloodBy()
      this.details.observe(state, events)
      this.observedDetails = true
      const by = this.details.firstBloodBy()
      if (before === null && by !== null && this.seats.has(by) && !this.botted.has(by)) this.firstBloodHuman = by
    }
    for (const interval of this.intervals.values()) interval.observe(state, events)
    if (Array.isArray(state.slots)) this.slots = state.slots
    if (Number.isSafeInteger(state.round)) this.round = state.round
    // The final roster is selected during round 5's ending. That scoring round still
    // belongs to everyone; membership applies only once the extra fight has started.
    this.roundParticipants = state.rankedFinal && state.round > (this.settings?.rankedRounds ?? 0)
      ? new Set(state.rankedFinal.contenders)
      : null
    const elapsed = Math.max(0, state.tick - this.lastTick)
    this.lastTick = state.tick
    if (elapsed > 0) for (const p of this.seats.keys()) if (!this.botted.has(p)) this.controlTicks.set(p, (this.controlTicks.get(p) ?? 0) + elapsed)
    if (this.lastPhase === 'fight' && elapsed > 0) {
      // Dead players still participate as spectators until they leave. Alive
      // time would incorrectly excuse a player who watched then rage-quit.
      const humans = [...this.seats.values()].filter((s) => this.human(s.player) !== null)
      for (const s of humans) s.combatTicks = (s.combatTicks ?? 0) + elapsed
      for (let i = 0; i < humans.length; i++) for (let j = i + 1; j < humans.length; j++) {
        const a = humans[i].player
        const b = humans[j].player
        if (this.settings?.teamMode !== 'ffa' && state.slots.find((s) => s.id === a)?.team === state.slots.find((s) => s.id === b)?.team) continue
        const key = a < b ? `${a}:${b}` : `${b}:${a}`
        const pair = this.combatPairs.get(key) ?? { players: [Math.min(a, b), Math.max(a, b)] as [PlayerId, PlayerId], ticks: 0 }
        pair.ticks += elapsed
        this.combatPairs.set(key, pair)
      }
    }
    this.lastPhase = state.phase
    // teams (shuffle mode changes them per round) and survivors after these events
    this.team.clear()
    this.alive.clear()
    for (const sl of state.slots) {
      this.team.set(sl.id, sl.team)
      const seat = this.seats.get(sl.id)
      if (seat && sl.kind === 'human') seat.name = sl.name
      // Preserve a departed human's last equipment and score. Replacement bot
      // upgrades never become purchases attributed to the absent player.
      if (!seat || !this.botted.has(sl.id)) {
        const score = state.scores?.find((s) => s.id === sl.id)
        const build = this.details?.buildOf(sl.id)
        if (seat && build) seat.build = build
        const previous = this.roster.get(sl.id)
        this.roster.set(sl.id, { player: sl.id, name: sl.name, color: sl.color, kind: sl.kind, team: sl.team,
          ...(seat ? { device: seat.device } : {}),
          kills: score?.kills ?? previous?.kills ?? 0, deaths: score?.deaths ?? previous?.deaths ?? 0,
          ...(score ? { score: score.score } : {}), ...(build ? { build } : {}), won: false })
      }
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
    const abandoned = result.abandoned === true
    const winners = new Set(abandoned ? [] : result.winners)
    for (const s of this.seats.values()) {
      if (this.botted.has(s.player) && (s.combatTicks ?? 0) >= LB_FORFEIT_SECONDS * TICK_HZ) s.forfeited = true
      s.won = !this.botted.has(s.player) && winners.has(s.player)
    }
    // deathmatch (no rounds): the whole match is one ranking by score
    if (!abandoned && this.settings.gameMode === 'deathmatch' && this.ranked.length === 0 && result.scores.length > 0) {
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
      seats: [...this.seats.values()].map((s) => {
        const complete = !!this.details && this.observedDetails && this.detailedSeats.has(s.player)
        const partial = complete ? null : this.partialOf(s.player, false)
        return { ...s,
          ...(complete ? { stats: this.details!.statsOf(s.player) } : {}),
          ...(partial ? { partialStats: partial, controlTicks: Math.min(this.controlTicks.get(s.player) ?? 0, result.ticks ?? 0) } : {}),
        }
      }),
      ranked: this.ranked,
      combatPairs: [...this.combatPairs.values()],
      ...(abandoned ? { abandoned: true } : {}),
      roster: [...this.roster.values()].map((p) => {
        const seat = this.seats.get(p.player)
        return { ...p, won: seat ? seat.won : winners.has(p.player),
          ...(seat ? { roundsPlayed: seat.roundsPlayed, roundsWon: seat.roundsWon } : {}),
          ...(seat?.forfeited ? { forfeited: true } : {}) }
      }),
    }, result)
  }

  abort(): void {
    const activity = this.active && this.settings && this.partial && this.opts.onAbort ? this.abortedActivity(this.settings) : null
    this.active = false
    this.details = null
    this.detailedSeats.clear()
    this.intervals.clear()
    this.pieces.clear()
    if (activity) {
      // Abort is synchronous teardown; delivery (and its own error logging) runs after it.
      void Promise.resolve().then(() => this.opts.onAbort!(activity))
        .catch((error) => { console.error('[leaderboard] saving unfinished match activity failed', error) })
    }
  }

  /** The human-controlled combat of a match that ends without a result; no outcome at all. */
  private abortedActivity(settings: MatchSettings): FinishedMatch | null {
    const seats = [...this.seats.values()].flatMap((s) => {
      const partial = this.partialOf(s.player, true)
      return partial && (s.combatTicks ?? 0) > 0
        ? [{ ...s, won: false, partialStats: partial, controlTicks: Math.min(this.controlTicks.get(s.player) ?? 0, this.lastTick) }]
        : []
    })
    if (seats.length === 0) return null
    return { ticks: this.lastTick, rounds: this.round, teamMode: settings.teamMode, gameMode: settings.gameMode,
      bots: this.bots, seats, ranked: [], aborted: true }
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
  forfeited?: boolean
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

export type HistoryQueue = 'ranked' | 'casual' | 'custom'
export interface HistoryPlayer {
  player: PlayerId
  device?: string
  name: string
  color?: number
  kind?: 'human' | 'bot'
  team?: number
  score?: number
  roundsPlayed?: number
  roundsWon?: number
  kills: number
  deaths: number
  won: boolean
  forfeited?: boolean
  build?: InspectedKit
}
export interface StoredMatchHistory {
  queue: HistoryQueue
  at: number
  region: string
  room: string
  ticks: number
  rounds: number
  teamMode: TeamMode
  gameMode: GameMode
  players: HistoryPlayer[]
  deltas?: Record<string, { delta: number; rating: number }>
}
export interface MatchHistoryEntry extends Omit<StoredMatchHistory, 'room' | 'players' | 'deltas'> {
  id: string
  self: PlayerId
  outcome: 'win' | 'loss' | 'forfeit'
  delta: number | null
  rating: number | null
  players: Omit<HistoryPlayer, 'device'>[]
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
  /** Folded unfinished/partly played ranked combat (unfinishedActivity), separate from complete detail. */
  activity(device: string): { detail: RecordedProfileDetail; firstAt: number; lastAt: number } | null
  history(device: string, options: { queue?: HistoryQueue; limit: number }): MatchHistoryEntry[]
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
  const participating = ratingParticipants(m)
  for (const s of seat.values()) {
    if (!participating.has(s.player)) continue
    const d = delta.get(s.device) ?? 0
    const before = current.get(s.device)
    const rating = (before?.rating ?? LB_RATING_START) + d
    const won = s.won && !s.forfeited
    results.push({ device: s.device, name: s.name, at: now, region, won, roundsPlayed: s.roundsPlayed, roundsWon: s.roundsWon, kills: s.kills, deaths: s.deaths, delta: d, rating,
      ...(s.stats ? { stats: s.stats } : {}),
      ...(s.forfeited ? { forfeited: true } : {}),
    })
    players.push({
      device: s.device,
      name: s.name,
      tag: deviceTag(s.device),
      rating,
      matches: (before?.matches ?? 0) + 1,
      wins: (before?.wins ?? 0) + (won ? 1 : 0),
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
