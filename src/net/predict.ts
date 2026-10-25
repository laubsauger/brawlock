/**
 * Full-world client prediction on top of host-authoritative snapshots (M1 step 1).
 *
 * The client keeps the newest authoritative state (tick N) and re-simulates N → P
 * with the shared deterministic sim, where P is its own predicted present
 * (about one RTT plus a small margin ahead of N, see LeadClock). Its own input
 * frames that the host has not applied yet are replayed at the tick they were
 * stamped with; every other player "repeats their last intent", which in this sim
 * means no new commands (move orders, casts in windup and physics persist in the
 * state). Each new snapshot rolls the prediction back to it and re-simulates.
 *
 * The host applies a stamped frame at its stamp when it arrives in time
 * (session.ts), so own inputs are predicted at exactly the tick the host runs
 * them: after the ack the predicted state for a tick equals the host's.
 *
 * Rendering never sees the working state. Every new predicted tick is emitted
 * as a display copy with a per-entity visual error offset added: when a re-sim
 * moves an entity, the offset absorbs the jump and decays over ~100 ms (snap
 * beyond SNAP_DIST). Display ticks are strictly increasing.
 *
 * Events: re-simulated ticks produce their events again. An EventLedger plays
 * each event once (matched one-to-one by a stable key within ±FUZZ ticks) across
 * predicted timelines and the authoritative event stream that rides every
 * snapshot. Events the predicted timeline missed (a remote cast revealed by a
 * snapshot) play late, with the next displayed tick; nothing replays.
 * Match-flow events (death, roundWin, gameOver, phase) are taken only from the
 * authoritative stream, so a mispredicted death never shows a banner or a
 * killfeed line.
 */
import type { InputCommand, PlayerId, PlayerInput, SimEvent, SimState } from '../sim/types'
import { ticks } from '../sim/config'
import { TICK_HZ, onTickRate } from '../sim/types'
import { EVENT_REDUNDANCY_TICKS, type TickEvents } from './protocol'

let DT_MS = 0

/**
 * Prediction never runs more than this many ticks past the newest confirmed state
 * (caps re-sim cost and blind prediction through a stalled link). It must cover
 * RTT + margin + the confirmed state's age, or the display pins to the cap: 30 ticks
 * covers RTT up to ~380 ms.
 */
export let MAX_AHEAD_TICKS = 0
/**
 * A snapshot that confirms the prediction (only own frames, at their stamps) skips
 * the rollback; one happens at least this often anyway, so a wrong "confirmed" can
 * never drift for longer.
 */
export let FORCE_REBASE_TICKS = 0
onTickRate(() => {
  DT_MS = 1000 / TICK_HZ
  MAX_AHEAD_TICKS = ticks(0.5)
  FORCE_REBASE_TICKS = ticks(0.5)
})
/** visual error offsets beyond this (game units) snap instead of sliding */
export const SNAP_DIST = 250
/** offset multiplier per displayed tick: ~10 % left after 100 ms */
const OFFSET_DECAY = 0.68
const OFFSET_EPS = 0.25
/** event matching tolerance between timelines: ticks, and game units for events with a position */
const FUZZ = 3
const MATCH_DIST = 160
/** played as authoritative only (banners, killfeed, score) */
const AUTHORITATIVE_EVENTS = new Set<SimEvent['type']>(['death', 'roundWin', 'gameOver', 'phase'])

export interface LocalFrame {
  seq: number
  /** tick the frame is applied in (step from `tick` to `tick + 1`) */
  tick: number
  cmds: InputCommand[]
}

export interface PredictorStats {
  /** ticks re-simulated by the last rebase */
  resimTicks: number
  /** largest re-sim so far */
  maxResimTicks: number
  /** wall ms of the last rebase (clone + re-sim) and the largest, when a clock is given */
  resimMs: number
  maxResimMs: number
  /** visual correction of the own pawn by the last rebase, game units */
  ownCorrection: number
  /** largest correction of any entity by the last rebase (snaps excluded), game units */
  anyCorrection: number
  /** corrections that snapped */
  snaps: number
  /** own frames the host applied later than their stamp (input arrived late) */
  lateFrames: number
  rebases: number
  /** snapshots that confirmed the prediction, no rollback needed */
  confirms: number
}

type Step = (state: SimState, inputs: PlayerInput[]) => void
type Clone = (state: SimState) => SimState

interface Offset {
  x: number
  y: number
}

export class Predictor {
  private sim: SimState | null = null
  private pending: { state: SimState; ack: number } | null = null
  private baseTick = -1
  /** the newest base (never mutated): re-simulated from when a hint arrives */
  private baseState: SimState | null = null
  private baseAck = 0
  /** other players' input frames relayed before they are confirmed: tick → player → cmds */
  private hints = new Map<number, Map<PlayerId, InputCommand[]>>()
  private hintsDirty = false
  private plans = new Map<PlayerId, { asOf: number; frames: Map<number, InputCommand[]> }>()
  private frames: LocalFrame[] = []
  private lateSeen = 0
  private offsets = new Map<number, Offset>()
  private ledger = new EventLedger()
  /** events to play with the next displayed tick (late or authoritative) */
  private late: SimEvent[] = []
  private authTick = -1
  private shownTick = -1
  /** base tick of the last real rollback */
  private rebasedAt = -Infinity
  /** First step where a cancellable commit was held; later authority must rebase. */
  private deferredCastAt = Infinity
  readonly stats: PredictorStats = {
    resimTicks: 0,
    maxResimTicks: 0,
    resimMs: 0,
    maxResimMs: 0,
    ownCorrection: 0,
    anyCorrection: 0,
    snaps: 0,
    lateFrames: 0,
    rebases: 0,
    confirms: 0,
  }

  constructor(
    private readonly player: PlayerId,
    private readonly step: Step,
    private readonly clone: Clone,
    private readonly clock: () => number = () => 0,
    /** Joining or changing seats must not replay the previous controller's history. */
    private readonly eventFloor = -1,
  ) {}

  /** Tick of the predicted state (the next own frame is stamped with it); -1 before the first snapshot. */
  get tick(): number {
    return this.sim ? this.sim.tick : -1
  }

  /** Tick of the newest authoritative state applied. */
  get base(): number {
    return this.baseTick
  }

  /** Stamp for the next own frame: the tick the next live step consumes. */
  stampNext(): number {
    return this.sim ? this.sim.tick : Math.max(0, this.pending?.state.tick ?? 0)
  }

  /** Own frame, stamped with stampNext(). Frames must arrive in seq order. */
  local(frame: LocalFrame): void {
    this.frames.push(frame)
  }

  /** Own commands stamped for the step from `tick`, in seq order (what the prediction applied there). */
  ownAt(tick: number): InputCommand[] {
    const out: InputCommand[] = []
    for (const f of this.frames) if (f.tick === tick) for (const c of f.cmds) out.push(c)
    return out
  }

  /** An own frame stamped before `tick` is not in a state that includes frames ≤ `ack`. */
  lateBefore(tick: number, ack: number): boolean {
    return this.frames.some((f) => f.tick < tick && f.seq > ack)
  }

  /**
   * An authoritative state for `state.tick` that includes every own frame with
   * seq ≤ `ack`. Older than the current base: only its events are used. The state is
   * cloned when applied, never mutated. `events` = authoritative events by tick.
   * `confirms`: the caller vouches that the authority stepped nothing since the
   * previous offered state but this predictor's own frames, each at its stamp, so
   * the predicted timeline already holds `state` and the rollback is skipped.
   */
  offer(state: SimState, ack: number, events: readonly TickEvents[] = [], confirms = false): void {
    // authoritative events: the ones no predicted timeline played yet (remote casts
    // revealed by this snapshot, match flow) play late, with the next displayed tick
    for (const e of events) {
      if (e.tick <= Math.max(this.authTick, this.eventFloor)) continue
      for (const ev of this.ledger.take(e.tick, e.events, true)) this.late.push(ev)
      this.authTick = e.tick
    }
    if (state.tick <= this.baseTick) return
    if (this.pending && state.tick <= this.pending.state.tick) return
    const sim = this.sim
    if (confirms && !this.pending && sim && state.tick <= sim.tick && !Number.isFinite(this.deferredCastAt) && state.tick - this.rebasedAt < FORCE_REBASE_TICKS) {
      this.baseTick = state.tick
      this.baseState = state
      this.baseAck = ack
      this.frames = this.frames.filter((f) => f.seq > ack)
      this.dropHints(state.tick)
      this.stats.confirms++
      return
    }
    this.pending = { state, ack }
  }

  /**
   * Another player's input frame, relayed by the host before it is stepped there
   * (it will run in the step from `tick`): predicted at that tick instead of
   * waiting for the confirmation. A wrong hint is corrected by the confirmed stream.
   */
  hint(player: PlayerId, tick: number, cmds: InputCommand[]): void {
    if (player === this.player || tick < this.baseTick || cmds.length === 0) return
    let at = this.hints.get(tick)
    if (!at) this.hints.set(tick, (at = new Map()))
    const prev = at.get(player)
    at.set(player, prev ? prev.concat(cmds) : cmds)
    this.hintsDirty = true
  }

  /** Hinted commands of `player` for the step from `tick`, if any. */
  hintAt(tick: number, player: PlayerId): InputCommand[] | undefined {
    const hint = this.hints.get(tick)?.get(player)
    const plan = this.plans.get(player)?.frames.get(tick)
    return hint && plan ? plan.concat(hint) : hint ?? plan
  }

  /** Players with hints for the step from `tick`. */
  hintedAt(tick: number): PlayerId[] {
    const at = this.hints.get(tick)
    const players = new Set(at?.keys())
    for (const [player, plan] of this.plans) if (plan.frames.has(tick)) players.add(player)
    return [...players]
  }

  /** Exact bot orders already queued on the authority, including their execution ticks. */
  plan(player: PlayerId, asOf: number, frames: readonly [number, InputCommand[]][]): void {
    if (player === this.player || !Number.isInteger(asOf)) return
    const prev = this.plans.get(player)
    if (prev && asOf <= prev.asOf) return
    const next = new Map<number, InputCommand[]>()
    // Keep known past steps for rollback, replace the remaining future schedule.
    if (prev) for (const [tick, cmds] of prev.frames) if (tick >= this.baseTick && tick < asOf) next.set(tick, cmds)
    for (const [tick, cmds] of frames) {
      if (!Number.isInteger(tick) || tick < Math.max(asOf, this.baseTick) || !Array.isArray(cmds) || !cmds.length) continue
      next.set(tick, (next.get(tick) ?? []).concat(cmds))
    }
    const changed = JSON.stringify([...(prev?.frames ?? [])]) !== JSON.stringify([...next])
    this.plans.set(player, { asOf, frames: next })
    if (changed) this.hintsDirty = true
  }

  private dropHints(before: number): void {
    for (const t of this.hints.keys()) if (t < before) this.hints.delete(t)
    for (const plan of this.plans.values()) for (const tick of plan.frames.keys()) if (tick < before) plan.frames.delete(tick)
  }

  /**
   * Apply the newest offered state (roll back and re-simulate to the current
   * predicted tick), then step forward to `target` (capped at base + MAX_AHEAD).
   * `emit` gets one display state per new tick, oldest first, with the events to
   * play for it. Display states are fresh copies; the caller may keep them.
   */
  advance(target: number, emit: (display: SimState, events: SimEvent[]) => void): void {
    // new hints change the predicted ticks: re-simulate them from the current base
    if (!this.pending && this.hintsDirty && this.baseState) this.pending = { state: this.baseState, ack: this.baseAck }
    this.hintsDirty = false
    if (this.pending) this.rebase()
    const sim = this.sim
    if (!sim) return
    const goal = Math.min(target, this.baseTick + MAX_AHEAD_TICKS)
    // the base itself is new to the display (no lead, or it overtook the prediction)
    if (sim.tick <= goal && sim.tick > this.shownTick) this.show(sim, [], emit)
    while (sim.tick < goal) {
      this.stepOne(sim)
      const events = sim.tick > this.eventFloor ? this.ledger.take(sim.tick, sim.events, false, AUTHORITATIVE_EVENTS) : []
      this.show(sim, events, emit)
    }
  }

  private rebase(): void {
    const t0 = this.clock()
    const { state, ack } = this.pending!
    this.pending = null
    this.baseState = state
    this.baseAck = ack
    this.dropHints(state.tick)
    this.frames = this.frames.filter((f) => f.seq > ack)
    // a frame stamped before this snapshot's tick that the host has not applied came in late
    for (const f of this.frames) {
      if (f.tick < state.tick && f.seq > this.lateSeen) {
        this.lateSeen = f.seq
        if (this.baseTick >= 0) this.stats.lateFrames++
      }
    }
    const old = this.sim
    const fresh = this.clone(state)
    this.deferredCastAt = Infinity
    this.baseTick = fresh.tick
    this.rebasedAt = fresh.tick
    // keep what the authoritative stream can still match (it carries the last few ticks)
    this.ledger.beginPass(Math.max(Math.min(fresh.tick, this.authTick), fresh.tick - EVENT_REDUNDANCY_TICKS) - FUZZ - 1)
    // never re-simulate past the old prediction: display ticks only go forward
    const to = old ? old.tick : fresh.tick
    let n = 0
    while (fresh.tick < to) {
      this.stepOne(fresh)
      if (fresh.tick > this.eventFloor) for (const e of this.ledger.take(fresh.tick, fresh.events, false, AUTHORITATIVE_EVENTS)) this.late.push(e)
      n++
    }
    this.stats.resimTicks = n
    if (n > this.stats.maxResimTicks) this.stats.maxResimTicks = n
    this.stats.rebases++
    if (old && old.tick === fresh.tick) this.correct(old, fresh)
    else this.offsets.clear()
    this.sim = fresh
    this.stats.resimMs = this.clock() - t0
    if (this.stats.resimMs > this.stats.maxResimMs) this.stats.maxResimMs = this.stats.resimMs
  }

  /** Own commands for the step from `state.tick`, in seq order. */
  private stepOne(state: SimState): void {
    const t = state.tick
    let cmds: InputCommand[] | null = null
    for (const f of this.frames) {
      const at = f.tick > this.baseTick ? f.tick : this.baseTick
      if (at !== t) continue
      if (!cmds) cmds = []
      for (const c of f.cmds) cmds.push(c)
    }
    const inputs: PlayerInput[] = cmds ? [{ player: this.player, tick: t, cmds }] : []
    for (const player of this.hintedAt(t)) inputs.push({ player, tick: t, cmds: this.hintAt(t, player)! })
    // Other players can still stop a known windup. Our own input can also
    // arrive late and shift its cast point until its original frame is acked.
    // Hold only that final cancellable tick: no speculative projectile,
    // launch sound or downstream impact is created. Orders/death still cancel
    // through the real sim; an authoritative rebase resolves the held commit.
    for (const p of state.pawns) {
      const c = p.cast
      if (!p.alive || !c?.started || c.ticksLeft > 1) continue
      const unacked = p.owner === this.player && this.frames.some((f) => f.seq > this.baseAck && f.tick <= t && f.cmds.some((cmd) => cmd.kind === 'cast' && cmd.slot === c.slot && cmd.x === c.x && cmd.y === c.y))
      if (p.owner === this.player && !unacked) continue
      c.ticksLeft += 1
      this.deferredCastAt = Math.min(this.deferredCastAt, t)
    }
    this.step(state, inputs)
    // A later remote order may supersede our held windup after its real
    // commit. Only authority can say whether it actually cancelled a cast.
    state.events = state.events.filter((e) => e.type !== 'castCancel' || state.pawns.some((p) => p.id === e.pawn && p.owner === this.player))
  }

  /** Visual continuity: the displayed position stays where it was and the error decays. */
  private correct(old: SimState, fresh: SimState): void {
    let own = 0
    let any = 0
    const next = new Map<number, Offset>()
    const oldPawns = new Map(old.pawns.map((p) => [p.id, p]))
    for (const p of fresh.pawns) {
      const o = oldPawns.get(p.id)
      if (!o || o.alive !== p.alive) continue
      const d = this.carry(next, p.id, o.x - p.x, o.y - p.y)
      if (p.owner === this.player) own = d
      if (d > any) any = d
    }
    const oldProj = new Map(old.projectiles.map((p) => [p.id, p]))
    for (const p of fresh.projectiles) {
      const o = oldProj.get(p.id)
      if (!o || o.spell !== p.spell) continue
      const d = this.carry(next, p.id, o.x - p.x, o.y - p.y)
      if (d > any) any = d
    }
    this.offsets = next
    this.stats.ownCorrection = own
    this.stats.anyCorrection = any
  }

  /** Returns the size of this correction (0 when snapped). */
  private carry(next: Map<number, Offset>, id: number, dx: number, dy: number): number {
    const prev = this.offsets.get(id)
    const x = (prev?.x ?? 0) + dx
    const y = (prev?.y ?? 0) + dy
    const d = Math.hypot(dx, dy)
    if (x * x + y * y > SNAP_DIST * SNAP_DIST) {
      this.stats.snaps++
      return 0
    }
    if (Math.abs(x) > OFFSET_EPS || Math.abs(y) > OFFSET_EPS) next.set(id, { x, y })
    return d
  }

  private show(sim: SimState, events: SimEvent[], emit: (display: SimState, events: SimEvent[]) => void): void {
    if (sim.tick <= this.shownTick) return
    this.shownTick = sim.tick
    const display = this.clone(sim)
    if (this.offsets.size) {
      for (const p of display.pawns) {
        const o = this.offsets.get(p.id)
        if (o) {
          p.x += o.x
          p.y += o.y
        }
      }
      for (const p of display.projectiles) {
        const o = this.offsets.get(p.id)
        if (o) {
          p.x += o.x
          p.y += o.y
        }
      }
      for (const [id, o] of this.offsets) {
        o.x *= OFFSET_DECAY
        o.y *= OFFSET_DECAY
        if (Math.abs(o.x) < OFFSET_EPS && Math.abs(o.y) < OFFSET_EPS) this.offsets.delete(id)
      }
    }
    const all = this.late.length ? this.late.concat(events) : events
    this.late = []
    display.events = all
    emit(display, all)
  }
}

/**
 * Plays each event once across timelines. Every rollback starts a new predicted
 * pass; the authoritative stream is one more timeline. Within a timeline an event
 * matches at most one played event with the same key within ±FUZZ ticks (nearest
 * tick first) and each played event is matched at most once, so per-tick series
 * (lava damage) stay one-to-one. Unmatched events are new: recorded and returned.
 * A matched record moves to the tick it matched at (unless the authority already fixed
 * it), so an event that drifts a little with every rebase stays one event: an own input
 * that reached the host late is re-predicted at each newer confirmed tick until its ack,
 * which moves its cast a few ticks per rebase, more than ±FUZZ in total.
 */
interface Played {
  key: string
  /** where it happened (NaN = no position) */
  x: number
  y: number
  pass: number
  auth: boolean
}

export class EventLedger {
  private played = new Map<number, Played[]>()
  private pass = 0

  /** A new predicted timeline (after a rollback). Forgets ticks < `keepFrom`. */
  beginPass(keepFrom: number): void {
    this.pass++
    for (const t of this.played.keys()) if (t < keepFrom) this.played.delete(t)
  }

  /**
   * Events of tick `t` not played yet, from the current predicted pass (auth false)
   * or the authoritative stream (auth true). Types in `skip` are never taken.
   */
  take(t: number, events: readonly SimEvent[], auth: boolean, skip?: ReadonlySet<SimEvent['type']>): SimEvent[] {
    const out: SimEvent[] = []
    for (const e of events) {
      if (skip?.has(e.type)) continue
      const k = eventKey(e)
      const [x, y] = eventPos(e)
      if (this.match(t, k, x, y, auth)) continue
      let list = this.played.get(t)
      if (!list) this.played.set(t, (list = []))
      list.push({ key: k, x, y, pass: auth ? -1 : this.pass, auth })
      out.push(e)
    }
    return out
  }

  private match(t: number, key: string, x: number, y: number, auth: boolean): boolean {
    for (let i = 0; i <= 2 * FUZZ; i++) {
      const d = i === 0 ? 0 : i % 2 ? -((i + 1) >> 1) : i >> 1
      const list = this.played.get(t + d)
      if (!list) continue
      for (const e of list) {
        if (e.key !== key) continue
        if (auth ? e.auth : e.pass === this.pass) continue
        // the same kind of event somewhere else is another event (two explosions)
        if ((e.x - x) * (e.x - x) + (e.y - y) * (e.y - y) > MATCH_DIST * MATCH_DIST) continue
        // follow the event to its newest timing; the authority's timing is final
        if (d !== 0 && (auth || !e.auth)) {
          list.splice(list.indexOf(e), 1)
          let at = this.played.get(t)
          if (!at) this.played.set(t, (at = []))
          at.push(e)
        }
        if (auth) e.auth = true
        else e.pass = this.pass
        return true
      }
    }
    return false
  }
}

/**
 * An event's identity across timelines. Fields that vary with small prediction
 * errors (positions: compared by distance instead, knockback) or with entity id
 * allocation order (projectile ids) are left out. A beam is its caster's cast:
 * where it stopped is the outcome, so a mispredicted hit and the real miss are
 * one bolt, not two. Damage amounts are rounded.
 */
const UNSTABLE_FIELDS = new Set(['x', 'y', 'fromX', 'fromY', 'toX', 'toY', 'kb', 'absorbed', 'ticks', 'radius', 'projectile', 'other'])
const OUTCOME_FIELDS: Partial<Record<SimEvent['type'], ReadonlySet<string>>> = { beam: new Set(['target', 'blocked']) }

export function eventKey(e: SimEvent): string {
  const o = e as unknown as Record<string, unknown>
  const projectileId = e.type.startsWith('projectile')
  const outcome = OUTCOME_FIELDS[e.type]
  let k: string = e.type
  for (const f of Object.keys(o).sort()) {
    if (f === 'type' || UNSTABLE_FIELDS.has(f) || (projectileId && f === 'id') || outcome?.has(f)) continue
    const v = o[f]
    k += '|' + f + '=' + (typeof v === 'object' ? JSON.stringify(v) : f === 'amount' && typeof v === 'number' ? Math.round(v) : String(v))
  }
  return k
}

/** Where an event happened, NaN when it has no position. */
function eventPos(e: SimEvent): [number, number] {
  const o = e as unknown as Record<string, unknown>
  const x = typeof o.x === 'number' ? o.x : typeof o.fromX === 'number' ? o.fromX : NaN
  const y = typeof o.y === 'number' ? o.y : typeof o.fromY === 'number' ? o.fromY : NaN
  return [x, y]
}

/**
 * Maps local time to the predicted tick. Target: the host tick an input sent now
 * would arrive at (base + RTT), plus a margin so it arrives before its stamp.
 * `baseMs` = local arrival time of host tick 0 over the fastest path (the jitter
 * buffer's estimate). The mapping is steered (speed-up ≤ 10 %, slow-down ≤ 5 %,
 * 15 % when more than 4 ticks ahead) and only snaps forward, so predicted time
 * never runs backwards. The jitter term is capped (a tab stall is not jitter; late
 * frames widen the margin instead) and so is the whole lead, below MAX_AHEAD_TICKS.
 */
export class LeadClock {
  /** local ms at which predicted tick 0 would be due */
  private offset = NaN
  private last = NaN
  /** margin ticks on top of RTT; grows when own frames arrive late at the host */
  marginTicks = 1
  /** lead the last update aimed for, ms */
  leadMs = 0
  private calmSince = 0
  private lastLate = 0

  /** lead error that speeds the clock up or snaps it back: 4 frames at 60 Hz, the same time at any rate */
  static readonly SNAP_MS = 4000 / 60
  static readonly MAX_MARGIN_TICKS = 8
  static readonly MAX_JITTER_MS = 25
  static get MAX_LEAD_MS(): number { return (MAX_AHEAD_TICKS - 2) * DT_MS }

  /** Steer toward the target for `now`. `jitterMs` = arrival jitter estimate. */
  update(now: number, baseMs: number, rttMs: number, jitterMs: number): void {
    const jitter = Math.min(jitterMs, LeadClock.MAX_JITTER_MS)
    const leadMs = Math.min(rttMs + this.marginTicks * DT_MS + 2 * jitter, LeadClock.MAX_LEAD_MS)
    this.leadMs = leadMs
    const target = baseMs - leadMs
    const dt = Number.isNaN(this.last) ? 0 : Math.max(0, now - this.last)
    this.last = now
    const d = target - this.offset
    if (Number.isNaN(d) || d < -LeadClock.SNAP_MS) this.offset = target
    else this.offset += clamp(d, -dt * 0.1, dt * (d > LeadClock.SNAP_MS ? 0.15 : 0.05))
  }

  /** Late frames counted so far (Predictor.stats.lateFrames): widen the margin, narrow it after calm. */
  feedLate(lateFrames: number, now: number): void {
    if (lateFrames > this.lastLate) {
      this.lastLate = lateFrames
      if (now - this.calmSince > 250 && this.marginTicks < LeadClock.MAX_MARGIN_TICKS) this.marginTicks++
      this.calmSince = now
    } else if (now - this.calmSince > 5000 && this.marginTicks > 1) {
      this.marginTicks--
      this.calmSince = now
    }
  }

  /** Predicted tick (fractional) at local time `now`. */
  tickAt(now: number): number {
    return Number.isNaN(this.offset) ? -1 : (now - this.offset) / DT_MS
  }

  /** Ideal local display time of `tick`. */
  timeOf(tick: number): number {
    return this.offset + tick * DT_MS
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
