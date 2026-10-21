/**
 * The announcer: which line to call out, for whom, and when. Pure and shared, so the voice
 * (src/audio) and the HUD banner (src/ui) say the same words: the audio engine feeds it each
 * tick's sim events plus the state they arrived with, and every chosen line goes out through
 * `announcements` to both. Deterministic: the same events and states give the same lines.
 *
 * Credit follows the sim and the kill stamps: `death.killer` is the last hitter (lava deaths
 * included); no killer, or the victim's own player, credits nothing.
 *
 * Kills
 * - First Blood: the match's first credited kill, for everyone.
 * - Multi-kill: kills chained within MULTI_WINDOW of each other (the kill stamps' window),
 *   2 Double, 3 Triple, 4 Multi, 5 Mega, 6 Ultra, 7+ Monster; only for your own kills.
 * - Streaks: kills without dying, across rounds, reset by any death. 3 Killing Spree,
 *   5 Rampage, 7 Unstoppable, 10 Godlike; yours for you, Rampage and up for everyone.
 *
 * Round flow (rounds mode; deathmatch only gets Round One before its single shop and Fight!)
 * - At the 3-2-1 countdown (3 s before the fight): "Round N" (rounds 1-9; none above), or
 *   "Final Round!" when every competitor (player, or team in team mode) is one win from the
 *   match, "Match Point!" when only some are. Then "Fight!" on the tick the fight starts.
 * - Round end: "Round Won!" for the winner's side, "Draw!" for everyone when nobody is left.
 * - Match end: "Victory!" / "Defeat!" for the local player (by team in team mode); a spectator
 *   (local player -1) hears neither.
 * - "The Arena Shrinks!": the first shrink of the match, for everyone. Every round would
 *   repeat it seconds into each fight; later shrinks are heard (rumble) and seen (sinking tiles).
 * - "Hurry Up!": the shrink that leaves HURRY_TILES tiles or fewer, once per round, for everyone.
 *
 * Occasional (at most OCCASIONAL_CAP per round per credited player)
 * - "Shutdown!": a kill that ends a streak of 3+, for everyone, credited to the killer.
 * - "Revenge!": you kill the player who last killed you.
 * - "Denied!": a Teleport that escapes dangerous lava or a knockback slide off the arena.
 * - "Close Call!": you are still alive CLOSE_CALL_CONFIRM s after a hit left you at <= 8% HP;
 *   once per round.
 * - "Last Warlock Standing!": you win an FFA round that started with 4+ warlocks.
 * - "Ace!": in team modes, your team kills every member of an enemy team of 2+ in one round.
 *
 * One line at a time: queued by priority (multi-kill > shutdown > streak > first blood >
 * occasional and arena > round flow), oldest first within a priority, and a line starts only
 * after the previous one ended. Round-flow lines always play (they wait their turn); every
 * other line older than STALE_AFTER is dropped rather than played late.
 */
import { MULTI_WINDOW } from '../render/overlay/killStamps'
import { tileCount } from '../sim/arena'
import { TEAM_DRAW } from '../sim/config'
import { TICK_HZ, type PlayerId, type SimEvent, type SimState } from '../sim/types'
import { isDeniedEscape, slideDecay, slideSnapshot, type SlideSnapshot } from './teleportSave'

export const ROUND_LINES = [
  'round_one',
  'round_two',
  'round_three',
  'round_four',
  'round_five',
  'round_six',
  'round_seven',
  'round_eight',
  'round_nine',
] as const
export type RoundLine = (typeof ROUND_LINES)[number]

export type AnnouncerLine =
  | 'first_blood'
  | 'double_kill'
  | 'triple_kill'
  | 'multi_kill'
  | 'mega_kill'
  | 'ultra_kill'
  | 'monster_kill'
  | 'killing_spree'
  | 'rampage'
  | 'unstoppable'
  | 'godlike'
  | RoundLine
  | 'fight'
  | 'final_round'
  | 'match_point'
  | 'round_won'
  | 'draw'
  | 'victory'
  | 'defeat'
  | 'arena_shrinks'
  | 'hurry_up'
  | 'shutdown'
  | 'revenge'
  | 'denied'
  | 'close_call'
  | 'last_standing'
  | 'ace'

/** What the voice says, word for word (the banner shows the same). */
export const ANNOUNCER_TEXT: Record<AnnouncerLine, string> = {
  first_blood: 'First Blood!',
  double_kill: 'Double Kill!',
  triple_kill: 'Triple Kill!',
  multi_kill: 'Multi Kill!',
  mega_kill: 'Mega Kill!',
  ultra_kill: 'Ultra Kill!',
  monster_kill: 'Monster Kill!',
  killing_spree: 'Killing Spree!',
  rampage: 'Rampage!',
  unstoppable: 'Unstoppable!',
  godlike: 'Godlike!',
  round_one: 'Round One!',
  round_two: 'Round Two!',
  round_three: 'Round Three!',
  round_four: 'Round Four!',
  round_five: 'Round Five!',
  round_six: 'Round Six!',
  round_seven: 'Round Seven!',
  round_eight: 'Round Eight!',
  round_nine: 'Round Nine!',
  fight: 'Fight!',
  final_round: 'Final Round!',
  match_point: 'Match Point!',
  round_won: 'Round Won!',
  draw: 'Draw!',
  victory: 'Victory!',
  defeat: 'Defeat!',
  arena_shrinks: 'The Arena Shrinks!',
  hurry_up: 'Hurry Up!',
  shutdown: 'Shutdown!',
  revenge: 'Revenge!',
  denied: 'Denied!',
  close_call: 'Close Call!',
  last_standing: 'Last Warlock Standing!',
  ace: 'Ace!',
}

const MULTI_LADDER: readonly AnnouncerLine[] = ['double_kill', 'triple_kill', 'multi_kill', 'mega_kill', 'ultra_kill', 'monster_kill']
export const STREAKS: readonly (readonly [number, AnnouncerLine])[] = [
  [3, 'killing_spree'],
  [5, 'rampage'],
  [7, 'unstoppable'],
  [10, 'godlike'],
]
/** streak length from which everyone hears it */
const PUBLIC_STREAK = 5
/** ending a streak this long is a Shutdown */
export const SHUTDOWN_STREAK = 3
/** a queued line older than this (s) is dropped rather than played late (not round flow) */
export const STALE_AFTER = 1.5
/** silence between two lines (s) */
const LINE_GAP = 0.15
/** the countdown call comes this long before the fight (the HUD's 3-2-1) */
export const COUNTDOWN_SECONDS = 3
/** occasional lines per round per credited player */
export const OCCASIONAL_CAP = 2
/** a hit that leaves at most this share of max HP is a close call ... */
const CLOSE_CALL_HP = 0.08
/** ... once the player is still alive this long after it (s) */
export const CLOSE_CALL_CONFIRM = 1
/** FFA rounds with at least this many starters can end in Last Warlock Standing */
const LAST_STANDING_STARTERS = 4

const PRIORITY = { multi: 6, shutdown: 5, streak: 4, first: 3, occasional: 2, arena: 2, flow: 1 } as const
export type AnnouncementKind = keyof typeof PRIORITY

const OCCASIONAL: ReadonlySet<AnnouncerLine> = new Set(['shutdown', 'revenge', 'denied', 'close_call', 'last_standing', 'ace'])

export interface Announcement {
  line: AnnouncerLine
  text: string
  kind: AnnouncementKind
  /** who earned it (round flow: the local player, -1 for lines about nobody) */
  player: PlayerId
  /** First Blood's victim, retained with the queued announcement. */
  victim?: PlayerId
  /** kills in the chain (multi) or the streak (streak, shutdown); otherwise 1 */
  count: number
  /** sim time (s) it was earned */
  at: number
}

/** The parts of the sim state the announcer reads (all optional: partial states are fine). */
export type AnnouncerView = Partial<Pick<SimState, 'phase' | 'phaseTicksLeft' | 'round' | 'scores' | 'slots' | 'settings' | 'pawns' | 'arena'>>

/** Multi-kill line for a chain of `count` kills (2 = Double ... 7+ = Monster). */
export function multiLine(count: number): AnnouncerLine | null {
  if (count < 2) return null
  return MULTI_LADDER[Math.min(count, 7) - 2]
}

/**
 * The countdown call for the round about to start: Final Round / Match Point when someone is
 * one win from the match (rounds mode), else Round N for rounds 1-9, else none. The HUD shows
 * the same words under its 3-2-1.
 */
export function roundCall(state: AnnouncerView): AnnouncerLine | null {
  const settings = state.settings
  if (!settings || !state.scores) return null
  if (settings.gameMode !== 'deathmatch') {
    // competitors: active players, or teams (best member score) in team mode
    const best = new Map<number, number>()
    for (const sc of state.scores) {
      if (!sc.connected && !settings.botsReplaceLeavers) continue
      const side = settings.teamMode === 'teams' ? (state.slots?.find((s) => s.id === sc.id)?.team ?? sc.id) : sc.id
      best.set(side, Math.max(best.get(side) ?? 0, sc.score))
    }
    const atPoint = [...best.values()].filter((v) => v >= settings.winScore - 1).length
    if (atPoint > 0) return atPoint === best.size ? 'final_round' : 'match_point'
  }
  const next = (state.round ?? 0) + 1
  return next >= 1 && next <= ROUND_LINES.length ? ROUND_LINES[next - 1] : null
}

/** One credited kill as the announcer counts it. */
export interface TalliedKill {
  killer: PlayerId
  /** kills in the current chain (each within MULTI_WINDOW of the previous) */
  chain: number
  /** kills since the killer last died */
  streak: number
  /** the match's first credited kill */
  firstBlood: boolean
}

/**
 * The announcer's kill bookkeeping: first blood, multi-kill chains and streaks. Shared with the
 * match statistics (game/stats.ts) so both count kills the same way.
 */
export class KillTally {
  private firstBlood = false
  private readonly chains = new Map<PlayerId, { count: number; at: number }>()
  private readonly streaks = new Map<PlayerId, number>()

  reset(): void {
    this.firstBlood = false
    this.chains.clear()
    this.streaks.clear()
  }

  streakOf(player: PlayerId): number {
    return this.streaks.get(player) ?? 0
  }

  /** A death at sim time `now` (s). Returns the credited kill, or null (no killer / self). */
  death(owner: PlayerId, killer: PlayerId | null | undefined, now: number): TalliedKill | null {
    // any death ends the victim's streak, credited or not
    this.streaks.set(owner, 0)
    if (killer === null || killer === undefined || killer === owner) return null
    const firstBlood = !this.firstBlood
    this.firstBlood = true
    const prev = this.chains.get(killer)
    const chain = prev && now - prev.at <= MULTI_WINDOW ? prev.count + 1 : 1
    this.chains.set(killer, { count: chain, at: now })
    const streak = (this.streaks.get(killer) ?? 0) + 1
    this.streaks.set(killer, streak)
    return { killer, chain, streak, firstBlood }
  }
}

/** "Hurry Up!" once a shrink leaves this many tiles or fewer (layer 4: the last 3x3 block). */
export const HURRY_TILES = 9

/** Per-round bookkeeping, reset when a fight starts. */
interface RoundMemory {
  /** occasional lines started per credited player */
  occasional: Map<PlayerId, number>
  hurryCalled: boolean
  closeCallDone: boolean
  /** a close call waiting to be confirmed: the hit's time */
  closeCallAt: number | null
  /** pawns alive when the fight started */
  starters: number
  /** team at the fight's start, per player */
  teamAt: Map<PlayerId, number>
  /** per enemy team: its members the local team killed this round */
  wiped: Map<number, Set<PlayerId>>
  aced: Set<number>
}

function newRound(): RoundMemory {
  return {
    occasional: new Map(),
    hurryCalled: false,
    closeCallDone: false,
    closeCallAt: null,
    starters: 0,
    teamAt: new Map(),
    wiped: new Map(),
    aced: new Set(),
  }
}

export class Announcer {
  private readonly tally = new KillTally()
  private queue: Announcement[] = []
  private busyUntil = -Infinity
  private lastNow = -Infinity
  /** per victim: who killed them last (Revenge) */
  private readonly lastKiller = new Map<PlayerId, PlayerId>()
  private round = newRound()
  /** the round number whose countdown call went out */
  private calledRound = -1
  /** "The Arena Shrinks!" went out this match */
  private shrinkCalled = false
  /** the local pawn's last snapshot (Teleport saves) */
  private slide: (SlideSnapshot & { hp: number; maxHp: number }) | null = null
  /** seconds a line plays (the voice file's length); the banner uses it too */
  lineLength: (line: AnnouncerLine) => number = () => 1.1

  /** New match: everything starts over. */
  reset(): void {
    this.tally.reset()
    this.queue = []
    this.busyUntil = -Infinity
    this.lastNow = -Infinity
    this.lastKiller.clear()
    this.round = newRound()
    this.calledRound = -1
    this.shrinkCalled = false
    this.slide = null
  }

  /** Kills in a row without dying (for tests and the HUD). */
  streakOf(player: PlayerId): number {
    return this.tally.streakOf(player)
  }

  /**
   * One tick's events at sim time `now` (s), as heard by `localPlayer` (-1 or null: a
   * spectator), with the state they arrived with. Returns the line to start now, or null
   * (nothing earned, or a line is still playing). Without a state only the event-driven lines
   * run (kills, round end, match end, shrink).
   */
  update(events: readonly SimEvent[], now: number, localPlayer: PlayerId | null, state?: AnnouncerView): Announcement | null {
    // a new match restarts the sim clock
    if (now < this.lastNow - 1) this.reset()
    this.lastNow = now
    const local = localPlayer !== null && localPlayer >= 0 ? localPlayer : null
    const pawns = state?.pawns ?? []
    const localPawn = local === null ? undefined : pawns.find((p) => p.owner === local)
    const teamOf = (id: PlayerId) => this.round.teamAt.get(id) ?? state?.slots?.find((s) => s.id === id)?.team ?? id
    const teamMode = state?.settings?.teamMode
    const alive = (id: PlayerId) => pawns.some((p) => p.owner === id && p.alive)
    for (const e of events) {
      switch (e.type) {
        case 'phase':
          if (e.phase === 'fight') {
            this.round = newRound()
            for (const p of pawns) if (p.alive) this.round.starters++
            for (const s of state?.slots ?? []) this.round.teamAt.set(s.id, s.team)
            this.flow('fight', local ?? -1, now)
          }
          break
        case 'death':
          this.onDeath(e, now, local, teamOf, teamMode, alive)
          break
        case 'damage':
          if (local !== null && localPawn && e.target === localPawn.id && e.source !== null && e.source !== local && e.amount > 0) {
            if (!this.round.closeCallDone && localPawn.alive && localPawn.hp <= CLOSE_CALL_HP * localPawn.maxHp) this.round.closeCallAt = now
          }
          break
        case 'teleport':
          if (local !== null && localPawn?.alive && e.pawn === localPawn.id && this.slide && state?.phase === 'fight') {
            const layer = state.arena?.layer ?? 0
            if (isDeniedEscape(this.slide, this.slide, e.toX, e.toY, layer, slideDecay(state.settings?.friction), state.settings?.lavaDps ?? 0)) this.occasional('denied', local, now)
          }
          break
        case 'arenaShrink':
          if (!this.shrinkCalled) {
            this.shrinkCalled = true
            this.push({ line: 'arena_shrinks', kind: 'arena', player: -1, count: 1, at: now })
          } else if (!this.round.hurryCalled && tileCount(e.layer) <= HURRY_TILES) {
            this.round.hurryCalled = true
            this.push({ line: 'hurry_up', kind: 'arena', player: -1, count: 1, at: now })
          }
          break
        case 'roundWin':
          if (e.team === TEAM_DRAW || e.players.length === 0) this.flow('draw', -1, now)
          else if (local !== null && e.players.includes(local)) {
            if (teamMode === 'ffa' && e.players.length === 1 && this.round.starters >= LAST_STANDING_STARTERS) this.occasional('last_standing', local, now)
            this.flow('round_won', local, now)
          }
          break
        case 'gameOver':
          if (local !== null) this.flow(e.winners.includes(local) ? 'victory' : 'defeat', local, now)
          break
        default:
          break
      }
    }
    if (state) {
      // the countdown call, at the HUD's 3-2-1
      const counting = state.phase === 'shop' || state.phase === 'warmup'
      const upcoming = (state.round ?? 0) + 1
      if (counting && (state.phaseTicksLeft ?? Infinity) <= COUNTDOWN_SECONDS * TICK_HZ && this.calledRound !== upcoming) {
        this.calledRound = upcoming
        const call = roundCall(state)
        if (call) this.flow(call, local ?? -1, now)
      }
      // a close call holds once the player is still standing a moment later
      const at = this.round.closeCallAt
      if (at !== null && local !== null && now - at >= CLOSE_CALL_CONFIRM) {
        this.round.closeCallAt = null
        if (localPawn?.alive && state.phase === 'fight') {
          this.round.closeCallDone = true
          this.occasional('close_call', local, now)
        }
      }
      this.slide = localPawn ? { ...slideSnapshot(localPawn), hp: localPawn.hp, maxHp: localPawn.maxHp } : null
    }
    return this.next(now)
  }

  private onDeath(
    e: Extract<SimEvent, { type: 'death' }>,
    now: number,
    local: PlayerId | null,
    teamOf: (id: PlayerId) => number,
    teamMode: string | undefined,
    alive: (id: PlayerId) => boolean,
  ): void {
    const victimStreak = this.tally.streakOf(e.owner)
    const kill = this.tally.death(e.owner, e.killer, now)
    // Ace: every member of an enemy team of 2+ killed by our team this round, none standing
    if (local !== null && kill && (teamMode === 'teams' || teamMode === 'shuffle')) {
      const team = teamOf(e.owner)
      if (team !== teamOf(local) && teamOf(kill.killer) === teamOf(local)) {
        const ours = this.round.wiped.get(team) ?? new Set<PlayerId>()
        ours.add(e.owner)
        this.round.wiped.set(team, ours)
        const members = [...this.round.teamAt].filter(([, t]) => t === team).map(([id]) => id)
        if (members.length >= 2 && members.every((id) => ours.has(id) && !alive(id)) && !this.round.aced.has(team)) {
          this.round.aced.add(team)
          this.occasional('ace', local, now)
        }
      }
    }
    if (!kill) return
    const k = kill.killer
    if (kill.firstBlood) this.push({ line: 'first_blood', kind: 'first', player: k, victim: e.owner, count: 1, at: now })
    const multi = multiLine(kill.chain)
    if (multi && k === local) this.push({ line: multi, kind: 'multi', player: k, count: kill.chain, at: now })
    const hit = STREAKS.find(([n]) => n === kill.streak)
    if (hit && (k === local || kill.streak >= PUBLIC_STREAK)) this.push({ line: hit[1], kind: 'streak', player: k, count: kill.streak, at: now })
    if (victimStreak >= SHUTDOWN_STREAK) this.occasional('shutdown', k, now, victimStreak)
    if (k === local && this.lastKiller.get(local) === e.owner) {
      this.lastKiller.delete(local)
      this.occasional('revenge', local, now)
    }
    this.lastKiller.set(e.owner, k)
  }

  /** Start the next queued line if none is playing: highest priority, then oldest. */
  next(now: number): Announcement | null {
    this.queue = this.queue.filter((a) => a.kind === 'flow' || now - a.at <= STALE_AFTER)
    this.queue = this.queue.filter((a) => !OCCASIONAL.has(a.line) || (this.round.occasional.get(a.player) ?? 0) < OCCASIONAL_CAP)
    if (now < this.busyUntil || this.queue.length === 0) return null
    this.queue.sort((a, b) => PRIORITY[b.kind] - PRIORITY[a.kind] || a.at - b.at)
    const a = this.queue.shift()!
    if (OCCASIONAL.has(a.line)) this.round.occasional.set(a.player, (this.round.occasional.get(a.player) ?? 0) + 1)
    this.busyUntil = now + this.lineLength(a.line) + LINE_GAP
    return a
  }

  private flow(line: AnnouncerLine, player: PlayerId, at: number): void {
    this.push({ line, kind: 'flow', player, count: 1, at })
  }

  private occasional(line: AnnouncerLine, player: PlayerId, at: number, count = 1): void {
    if ((this.round.occasional.get(player) ?? 0) >= OCCASIONAL_CAP) return
    this.push({ line, kind: line === 'shutdown' ? 'shutdown' : 'occasional', player, count, at })
  }

  private push(a: Omit<Announcement, 'text'>): void {
    this.queue.push({ ...a, text: ANNOUNCER_TEXT[a.line] })
  }
}

type Listener = (a: Announcement) => void
const listeners = new Set<Listener>()

/**
 * Every line the announcer starts, for the voice and the HUD banner alike.
 * `subscribe` returns its own unsubscribe.
 */
export const announcements = {
  subscribe(fn: Listener): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  emit(a: Announcement): void {
    for (const fn of listeners) fn(a)
  },
}

/** The match's announcer (fed by the audio engine from playEvents). */
export const matchAnnouncer = new Announcer()
