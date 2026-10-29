/**
 * How a warlock moves, measured the same way for humans and bots (docs/moonshot/specs/bot-motion.md,
 * "The plausibility metric"). A pure meter: feed it every tick with the state before the step
 * (`motionBefore`), the commands each player sent and the state after; it never touches either state.
 *
 * Per player, over alive fight-seconds:
 * - orders: move and stop commands.
 * - reversals: walking resumes or continues within 0.6 s of the last walking tick, heading more
 *   than 120 degrees away from it (a stop, turn and go counts). Free reversals happen with no
 *   enemy bolt of danger >= 1.6 at the pawn in the last 0.4 s: those are the dance.
 * - dither: share of whole alive seconds with 3+ orders in which walking moved the pawn under 60
 *   units net (and it did walk). It counts orders, so slow thinking lowers it by construction;
 *   reversals are the primary measure.
 * - idle: share of whole alive seconds without walking.
 * - click-flip: share of consecutive move orders within 0.5 s aimed more than 120 degrees apart,
 *   aimed from where the pawn stood; also as flips per second, since the share falls whenever
 *   same-direction re-clicks are many.
 * - short clicks: move orders aimed under 120 units away.
 * - move-order gaps, and for bots the think gaps between decisions.
 * - same-tick ratio, per bot tier: the chance that one bot decides on a tick another bot of its
 *   tier decides, over its chance on any tick. 1 is chance; bots on one shared clock score high.
 */
import { dangerAt } from './danger'
import { BotController } from './controller'
import { BOT_PRESETS, type BotParams } from './presets'
import { DEFAULT_SETTINGS, createMatch, isEnemy, step, ticks } from '../sim'
import { hypot } from '../sim/math'
import { TICK_HZ } from '../sim/types'
import type { BotDifficulty, MatchSettings, PlayerId, PlayerInput, PlayerSlot, SimState } from '../sim/types'

/** Raw counts for one player; `mergeMotion` pools them across matches. */
export interface MotionCounts {
  seconds: number
  orders: number
  casts: number
  reversals: number
  freeReversals: number
  windows: number
  ditherWindows: number
  idleWindows: number
  moves: number
  shortMoves: number
  pairs: number
  flips: number
  /** seconds between consecutive move orders */
  moveGaps: number[]
  /** seconds between consecutive decisions (bots only) */
  thinkGaps: number[]
}

export interface MotionSummary {
  seconds: number
  ordersPerSecond: number
  castsPerSecond: number
  reversalsPerSecond: number
  freeReversalsPerSecond: number
  dither: number
  idle: number
  clickFlip: number
  flipsPerSecond: number
  shortClick: number
  /** p10, p50, p90, s */
  moveGaps: [number, number, number]
  /** p10, p50, p90 and the mean, s; NaN without decisions */
  thinkGaps: [number, number, number, number]
}

const REVERSAL_WINDOW_SECONDS = 0.6
const THREAT_DANGER = 1.6
const THREAT_MEMORY_SECONDS = 0.4
const FLIP_WINDOW_SECONDS = 0.5
/** cos 120 degrees: headings or aims further apart than this are reversals or flips */
const OPPOSED = -0.5
const DITHER_ORDERS = 3
const DITHER_NET = 60
const SHORT_CLICK = 120
/** walking speed below this is standing, units/s */
const WALKING = 1

export const emptyMotion = (): MotionCounts => ({
  seconds: 0, orders: 0, casts: 0, reversals: 0, freeReversals: 0, windows: 0, ditherWindows: 0, idleWindows: 0,
  moves: 0, shortMoves: 0, pairs: 0, flips: 0, moveGaps: [], thinkGaps: [],
})

export function mergeMotion(into: MotionCounts, from: MotionCounts): MotionCounts {
  for (const k of ['seconds', 'orders', 'casts', 'reversals', 'freeReversals', 'windows', 'ditherWindows', 'idleWindows', 'moves', 'shortMoves', 'pairs', 'flips'] as const) into[k] += from[k]
  into.moveGaps.push(...from.moveGaps)
  into.thinkGaps.push(...from.thinkGaps)
  return into
}

function quantile(sorted: readonly number[], q: number): number {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : NaN
}

export function summarizeMotion(c: MotionCounts): MotionSummary {
  const rate = (n: number) => (c.seconds > 0 ? n / c.seconds : 0)
  const share = (n: number, of: number) => (of > 0 ? n / of : 0)
  const gaps = [...c.moveGaps].sort((a, b) => a - b)
  const thinks = [...c.thinkGaps].sort((a, b) => a - b)
  const mean = thinks.length ? thinks.reduce((a, b) => a + b, 0) / thinks.length : NaN
  return {
    seconds: c.seconds,
    ordersPerSecond: rate(c.orders),
    castsPerSecond: rate(c.casts),
    reversalsPerSecond: rate(c.reversals),
    freeReversalsPerSecond: rate(c.freeReversals),
    dither: share(c.ditherWindows, c.windows),
    idle: share(c.idleWindows, c.windows),
    clickFlip: share(c.flips, c.pairs),
    flipsPerSecond: rate(c.flips),
    shortClick: share(c.shortMoves, c.moves),
    moveGaps: [quantile(gaps, 0.1), quantile(gaps, 0.5), quantile(gaps, 0.9)],
    thinkGaps: [quantile(thinks, 0.1), quantile(thinks, 0.5), quantile(thinks, 0.9), mean],
  }
}

interface Track {
  counts: MotionCounts
  /** last walking heading (unit vector) and its tick */
  heading: { x: number; y: number; tick: number } | null
  threatTick: number
  lastMove: { tick: number; x: number; y: number } | null
  lastDecision: number
  /** the current alive stretch, for whole-second windows */
  window: { ticks: number; orders: number; walkingTicks: number; x: number; y: number }
}

/** What the meter needs from the state before a step: cheaper than a clone of it. */
export interface MotionBefore {
  phase: SimState['phase']
  tick: number
  slots: SimState['slots']
  pawns: { owner: PlayerId; alive: boolean; x: number; y: number }[]
}

export const motionBefore = (s: SimState): MotionBefore =>
  ({ phase: s.phase, tick: s.tick, slots: s.slots, pawns: s.pawns.map((p) => ({ owner: p.owner, alive: p.alive, x: p.x, y: p.y })) })

/** Tick-by-tick motion meter over one match (or one replay). */
export class MotionMeter {
  private readonly tracks = new Map<PlayerId, Track>()
  /** per bot tier: ticks with two alive bots of it, and how often each or both decided */
  private readonly lockstep = new Map<BotDifficulty, { ticks: number; a: number; b: number; both: number }>()

  private track(id: PlayerId): Track {
    let t = this.tracks.get(id)
    if (!t) {
      t = { counts: emptyMotion(), heading: null, threatTick: -Infinity, lastMove: null, lastDecision: -1, window: { ticks: 0, orders: 0, walkingTicks: 0, x: 0, y: 0 } }
      this.tracks.set(id, t)
    }
    return t
  }

  /**
   * One sim step. `decided`: bots that made a decision this tick (BotController.decisionTick), for
   * think gaps and the same-tick ratio; omit for humans and replays.
   */
  tick(before: MotionBefore, inputs: readonly PlayerInput[], after: SimState, decided?: ReadonlySet<PlayerId>): void {
    if (before.phase !== 'fight') {
      for (const t of this.tracks.values()) this.restart(t)
      return
    }
    const hz = TICK_HZ
    // orders, judged from where the pawn stood when they were given
    for (const input of inputs) {
      const pawn = before.pawns.find((p) => p.owner === input.player)
      if (!pawn?.alive) continue
      const t = this.track(input.player)
      for (const c of input.cmds) {
        if (c.kind === 'cast') t.counts.casts++
        if (c.kind !== 'move' && c.kind !== 'stop') continue
        t.counts.orders++
        t.window.orders++
        if (c.kind !== 'move') continue
        const dx = c.x - pawn.x
        const dy = c.y - pawn.y
        const reach = hypot(dx, dy)
        t.counts.moves++
        if (reach < SHORT_CLICK) t.counts.shortMoves++
        const last = t.lastMove
        if (last) {
          const gap = (before.tick - last.tick) / hz
          t.counts.moveGaps.push(gap)
          if (gap <= FLIP_WINDOW_SECONDS && reach > 1) {
            t.counts.pairs++
            const lastReach = hypot(last.x, last.y)
            if (lastReach > 1 && (dx * last.x + dy * last.y) / (reach * lastReach) < OPPOSED) t.counts.flips++
          }
        }
        t.lastMove = { tick: before.tick, x: dx, y: dy }
      }
    }
    if (decided) this.decisions(before, decided)
    if (after.phase !== 'fight') return
    // walking, judged after the step
    for (const pawn of after.pawns) {
      const t = this.track(pawn.owner)
      if (!pawn.alive) { this.restart(t); continue }
      const c = t.counts
      c.seconds += 1 / hz
      const shots = after.projectiles.filter((pr) => isEnemy(after, pawn.owner, pr.owner))
      if (shots.length && dangerAt(shots, pawn.x, pawn.y) >= THREAT_DANGER) t.threatTick = after.tick
      const speed = hypot(pawn.walkVx, pawn.walkVy)
      const w = t.window
      if (w.ticks === 0) { w.x = pawn.x; w.y = pawn.y }
      w.ticks++
      if (speed > WALKING) {
        w.walkingTicks++
        const hx = pawn.walkVx / speed
        const hy = pawn.walkVy / speed
        const h = t.heading
        if (h && after.tick - h.tick <= REVERSAL_WINDOW_SECONDS * hz && hx * h.x + hy * h.y < OPPOSED) {
          c.reversals++
          if (after.tick - t.threatTick > THREAT_MEMORY_SECONDS * hz) c.freeReversals++
        }
        t.heading = { x: hx, y: hy, tick: after.tick }
      }
      if (w.ticks >= hz) {
        c.windows++
        const walked = w.walkingTicks * (pawn.moveSpeed / hz)
        const net = hypot(pawn.x - w.x, pawn.y - w.y)
        if (w.orders >= DITHER_ORDERS && net < DITHER_NET && walked > DITHER_NET) c.ditherWindows++
        if (w.walkingTicks === 0) c.idleWindows++
        t.window = { ticks: 0, orders: 0, walkingTicks: 0, x: pawn.x, y: pawn.y }
      }
    }
  }

  private decisions(state: MotionBefore, decided: ReadonlySet<PlayerId>): void {
    const bots = state.slots.filter((s) => s.kind === 'bot' && s.difficulty && state.pawns.some((p) => p.owner === s.id && p.alive))
    for (const s of bots) {
      if (!decided.has(s.id)) continue
      const t = this.track(s.id)
      if (t.lastDecision >= 0) t.counts.thinkGaps.push((state.tick - t.lastDecision) / TICK_HZ)
      t.lastDecision = state.tick
    }
    for (let i = 0; i < bots.length; i++) {
      for (let j = i + 1; j < bots.length; j++) {
        if (bots[i].difficulty !== bots[j].difficulty) continue
        const tier = bots[i].difficulty!
        let l = this.lockstep.get(tier)
        if (!l) this.lockstep.set(tier, (l = { ticks: 0, a: 0, b: 0, both: 0 }))
        const a = decided.has(bots[i].id)
        const b = decided.has(bots[j].id)
        l.ticks++
        if (a) l.a++
        if (b) l.b++
        if (a && b) l.both++
      }
    }
  }

  private restart(t: Track): void {
    t.heading = null
    t.lastMove = null
    t.lastDecision = -1
    t.window = { ticks: 0, orders: 0, walkingTicks: 0, x: 0, y: 0 }
  }

  counts(id: PlayerId): MotionCounts {
    return this.track(id).counts
  }

  players(): PlayerId[] {
    return [...this.tracks.keys()]
  }

  /** Same-tick ratio for a bot tier, with the raw counts to pool across matches. */
  sameTick(tier: BotDifficulty): { ticks: number; a: number; b: number; both: number } | null {
    return this.lockstep.get(tier) ?? null
  }
}

/** P(B decides | A decides) / P(B decides): 1 is chance, NaN without data. */
export function sameTickRatio(l: { ticks: number; a: number; b: number; both: number }): number {
  return l.ticks && l.a && l.b ? (l.both / l.a) / (l.b / l.ticks) : NaN
}

export interface MotionSeat {
  difficulty: BotDifficulty
  /** preset overrides (tuning); the tier's preset otherwise */
  params?: BotParams
}

/**
 * One seeded bot-only match, metered. `botSeed` gives each controller its seed (the menu backdrop
 * seeds every bot with the match seed).
 */
export function meterBotMatch(seats: readonly MotionSeat[], settings: Partial<MatchSettings>, seed: number, botSeed = (id: number) => seed * 31 + id, maxSeconds = 1500): { meter: MotionMeter; state: SimState } {
  const slots: PlayerSlot[] = seats.map((s, id) => ({ id, name: `${s.difficulty}${id}`, color: 0x100000 * (id + 1), team: id, kind: 'bot', difficulty: s.difficulty }))
  const state = createMatch({ ...DEFAULT_SETTINGS, ...settings }, slots, seed)
  const bots = seats.map((s, id) => new BotController(id, s.difficulty, botSeed(id), s.params ?? BOT_PRESETS[s.difficulty]))
  const meter = new MotionMeter()
  const decided = new Set<PlayerId>()
  for (let i = 0; i < ticks(maxSeconds) && state.phase !== 'gameOver'; i++) {
    const inputs = bots.map((b) => ({ player: b.player, tick: state.tick, cmds: b.think(state) }))
    decided.clear()
    for (const b of bots) if (b.decisionTick === state.tick) decided.add(b.player)
    const before = motionBefore(state)
    step(state, inputs)
    meter.tick(before, inputs, state, decided)
  }
  return { meter, state }
}
