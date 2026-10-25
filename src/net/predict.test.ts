import { describe, expect, it } from 'vitest'
import { cloneState, hashState, step } from '../sim'
import { cmd, fight, grant, pawn, place } from '../sim/testkit'
import { FIREBALL_SLOT, PAWN_MOVE_SPEED } from '../sim/config'
import { TICK_HZ, type InputCommand, type PlayerInput, type SimEvent, type SimState } from '../sim/types'
import { EventLedger, FORCE_REBASE_TICKS, LeadClock, MAX_AHEAD_TICKS, Predictor, SNAP_DIST, type LocalFrame } from './predict'
import { GradeTracker, LossTracker, gradeOf } from './netstats'

const hashNoEvents = (s: SimState) => hashState({ ...s, events: [] })
/** walk distance per sim tick (3.5 at 60 Hz) */
const walk = () => PAWN_MOVE_SPEED / TICK_HZ

describe('scheduled authoritative bot plans', () => {
  it('suppresses pre-attachment death history but still delivers a new confirmed death once', () => {
    const state = fight(2)
    const floor = state.tick + 5
    const pred = new Predictor(1, step, cloneState, () => 0, floor)
    const death: SimEvent = { type: 'death', pawn: pawn(state, 1).id, owner: 1, killer: 0, cause: 'lava', x: 0, y: 0 }
    const initial = cloneState(state)
    initial.tick = floor
    const events: SimEvent[] = []
    pred.offer(initial, 0, [{ tick: floor - 1, events: [death] }, { tick: floor, events: [death] }])
    pred.advance(floor + 1, (_s, e) => events.push(...e))
    expect(events.filter((e) => e.type === 'death')).toHaveLength(0)
    const next = cloneState(initial)
    next.tick = floor + 1
    pred.offer(next, 0, [{ tick: floor, events: [death] }, { tick: floor + 1, events: [death] }])
    pred.advance(floor + 2, (_s, e) => events.push(...e))
    pred.offer({ ...next, tick: floor + 2 }, 0, [{ tick: floor + 1, events: [death] }])
    pred.advance(floor + 3, (_s, e) => events.push(...e))
    expect(events.filter((e) => e.type === 'death')).toHaveLength(1)
  })

  it('replaces future orders, ignores reordered repeats, and cancels at handover', () => {
    const state = fight(2)
    const pred = new Predictor(1, step, cloneState)
    const tick = state.tick
    pred.offer(state, 0)
    pred.advance(tick + 1, () => {})
    const old: InputCommand[] = [{ kind: 'move', x: 800, y: 0 }]
    const next: InputCommand[] = [{ kind: 'move', x: -800, y: 0 }]
    pred.plan(0, tick + 1, [[tick + 5, old]])
    pred.plan(0, tick + 2, [[tick + 6, next]])
    pred.plan(0, tick + 1, [[tick + 5, old]])
    expect(pred.hintAt(tick + 5, 0)).toBeUndefined()
    expect(pred.hintAt(tick + 6, 0)).toEqual(next)
    pred.advance(tick + 7, () => {})
    pred.plan(0, tick + 3, [])
    let display: SimState | undefined
    pred.advance(tick + 8, (s) => { display = s })
    expect(pred.hintAt(tick + 6, 0)).toBeUndefined()
    expect(pawn(display!, 0).moveTarget).toBeNull()
  })

  it('retains elapsed planned steps needed for rollback when the pending queue empties', () => {
    const state = fight(2)
    const pred = new Predictor(1, step, cloneState)
    const tick = state.tick
    const cmds: InputCommand[] = [{ kind: 'move', x: 800, y: 0 }]
    pred.offer(state, 0)
    pred.advance(tick + 1, () => {})
    pred.plan(0, tick + 1, [[tick + 3, cmds]])
    pred.plan(0, tick + 4, [])
    expect(pred.hintAt(tick + 3, 0)).toEqual(cmds)
    let display: SimState | undefined
    pred.advance(tick + 5, (s) => { display = s })
    expect(pawn(display!, 0).moveTarget).toEqual({ x: 800, y: 0 })
  })
})

interface Sent {
  frame: LocalFrame
  arrive: number
}

/**
 * A host and one predicting client on a fixed-latency link, in whole ticks.
 * The host runs each stamped frame in the step from its stamp (late frames in
 * the next step), like session.ts. `remote(t)` = commands the host's own player
 * (id 0) issues at host tick t, which the client cannot know in advance.
 */
function simulate(opts: {
  oneWay: number
  ticks: number
  own: (t: number) => InputCommand[] | null
  remote?: (t: number) => InputCommand[] | null
  /** extra ticks a frame takes on its way (late inputs) */
  inputDelay?: (seq: number) => number
  /** offer every snapshot as confirming the prediction (true even when it does not: a lying caller) */
  confirmAll?: boolean
}) {
  const host = fight(2)
  const start = host.tick
  const pred = new Predictor(1, step, cloneState)
  const hostHash = new Map<number, number>()
  const hostStates = new Map<number, SimState>()
  const shown: SimState[] = []
  const snaps: { at: number; state: SimState; ack: number }[] = []
  const inflight: Sent[] = []
  const sched: LocalFrame[] = []
  let ack = 0
  let seq = 0
  let latest = -1
  const lead = 2 * opts.oneWay + 2
  for (let w = 0; w < opts.ticks; w++) {
    // host: frames that arrived by now, each at its stamp (late ones at once)
    for (let i = inflight.length - 1; i >= 0; i--) {
      if (inflight[i].arrive <= w) {
        sched.push(inflight[i].frame)
        inflight.splice(i, 1)
      }
    }
    sched.sort((a, b) => a.seq - b.seq)
    const inputs: PlayerInput[] = []
    const mine: InputCommand[] = []
    while (sched.length && sched[0].tick <= host.tick) {
      const f = sched.shift()!
      mine.push(...f.cmds)
      ack = f.seq
    }
    if (mine.length) inputs.push({ player: 1, tick: host.tick, cmds: mine })
    const r = opts.remote?.(host.tick)
    if (r) inputs.push({ player: 0, tick: host.tick, cmds: r })
    step(host, inputs)
    hostHash.set(host.tick, hashNoEvents(host))
    hostStates.set(host.tick, cloneState(host))
    snaps.push({ at: w + opts.oneWay, state: cloneState(host), ack })

    // client
    while (snaps.length && snaps[0].at <= w) {
      const s = snaps.shift()!
      pred.offer(s.state, s.ack, [], opts.confirmAll === true)
      latest = s.state.tick
    }
    // a player issues orders once they see the match (before that a stamp means nothing)
    const cmds = latest >= 0 ? opts.own(w) : null
    if (cmds) {
      const frame = { seq: ++seq, tick: pred.stampNext(), cmds }
      pred.local(frame)
      inflight.push({ frame, arrive: w + opts.oneWay + (opts.inputDelay?.(frame.seq) ?? 0) })
    }
    if (latest >= 0) pred.advance(latest + lead, (d) => shown.push(d))
  }
  return { pred, hostHash, hostStates, shown, start, lead }
}

/** Move orders around the client's start, every `every` ticks. */
function wander(state0: SimState, player: number, every: number, phase = 0) {
  const p = pawn(state0, player)
  return (t: number): InputCommand[] | null => {
    if ((t + phase) % every !== 0) return null
    const k = Math.floor((t + phase) / every)
    return [{ kind: 'move', x: p.x + (k % 2 ? 260 : -260), y: p.y + ((k >> 1) % 2 ? 200 : -200) }]
  }
}

describe('Predictor', () => {
  /**
   * Why: the host runs a stamped frame at its stamp, so own inputs are predicted at
   * exactly the tick the host applies them. With no unknown inputs the predicted
   * world for a tick IS the host's world for that tick, bit for bit: no drift.
   */
  it('own inputs at their stamp: every displayed tick equals the host state for that tick (hash)', () => {
    const s0 = fight(2)
    const { shown, hostHash, pred } = simulate({ oneWay: 5, ticks: 600, own: wander(s0, 1, 23) })
    expect(shown.length).toBeGreaterThan(500)
    for (const d of shown) {
      if (!hostHash.has(d.tick)) continue
      expect(hashNoEvents(d)).toBe(hostHash.get(d.tick))
    }
    expect(pred.stats.lateFrames).toBe(0)
    expect(pred.stats.ownCorrection).toBe(0)
  })

  /**
   * Why: instant feel. The order shows in the very next displayed tick (the pawn
   * turns toward the target, then walks), not an RTT later.
   */
  it('a move order changes the displayed own pawn on the next predicted tick', () => {
    const s0 = fight(2)
    const target = { x: pawn(s0, 1).x + 300, y: pawn(s0, 1).y }
    let issuedAt = -1
    const res = simulate({
      oneWay: 8,
      ticks: 200,
      own: (w) => {
        if (w !== 120) return null
        issuedAt = w
        return [{ kind: 'move', ...target }]
      },
    })
    const after = res.shown.filter((d) => d.tick > 0)
    const first = after.find((d) => {
      const mt = pawn(d, 1).moveTarget
      return mt !== null && mt.x === target.x
    })!
    expect(issuedAt).toBe(120)
    // the display tick after the one current at issue time
    const shownBefore = after.filter((d) => d.tick < first.tick)
    const before = shownBefore[shownBefore.length - 1]
    expect(first.tick).toBe(before.tick + 1)
    const a = pawn(before, 1)
    const b = pawn(first, 1)
    expect(a.facing !== b.facing || a.x !== b.x || a.y !== b.y).toBe(true)
  })

  /**
   * Why: remote players are predicted by repeating their last intent, so their
   * direction changes arrive late. The display must converge to the host state once
   * the snapshot shows them, and the jump must be spread over a few frames.
   */
  it('remote direction changes: corrections are smooth, bounded, and the display converges to the host', () => {
    const s0 = fight(2)
    const res = simulate({ oneWay: 5, ticks: 700, own: wander(s0, 1, 37), remote: wander(s0, 0, 29, 7) })
    const { shown, hostStates, pred } = res
    expect(pred.stats.anyCorrection + pred.stats.maxResimTicks).toBeGreaterThan(0)
    // track the remote pawn's displayed motion and each correction size
    let maxJump = 0
    let maxErr = 0
    for (let i = 1; i < shown.length; i++) {
      if (shown[i].tick !== shown[i - 1].tick + 1) continue
      const a = pawn(shown[i - 1], 0)
      const b = pawn(shown[i], 0)
      maxJump = Math.max(maxJump, Math.hypot(b.x - a.x, b.y - a.y))
      const h = hostStates.get(shown[i].tick)
      if (h) maxErr = Math.max(maxErr, Math.hypot(b.x - pawn(h, 0).x, b.y - pawn(h, 0).y))
    }
    // a reversal at walk speed (per tick) over the prediction lead
    expect(maxErr).toBeGreaterThan(20)
    expect(maxErr).toBeLessThan(2 * walk() * (res.lead + 2) + 5)
    // no frame jumps by the full error: it decays over several frames
    expect(maxJump).toBeLessThan(0.4 * maxErr + 3.6)
    // the client's own pawn never needs a correction: its inputs ran at their stamps
    expect(pred.stats.ownCorrection).toBe(0)
  })

  it('converges exactly once the remote player stops issuing orders', () => {
    const s0 = fight(2)
    const remote = wander(s0, 0, 29, 7)
    const res = simulate({ oneWay: 5, ticks: 500, own: wander(s0, 1, 37), remote: (t) => (t < 300 ? remote(t) : null) })
    // the client runs ahead: only ticks the host has simulated can be compared
    const late = res.shown.filter((d) => d.tick > 300 + 2 * 5 + 40 && res.hostHash.has(d.tick))
    expect(late.length).toBeGreaterThan(50)
    for (const d of late) expect(hashNoEvents(d)).toBe(res.hostHash.get(d.tick))
  })

  /**
   * Why: an input that misses its tick on the host (loss, jitter) is applied a tick
   * later; the client must notice (to widen its lead) and correct its own pawn by a
   * few units, not rubber-band.
   */
  it('late own frames are detected and corrected by a small amount', () => {
    const s0 = fight(2)
    const res = simulate({ oneWay: 4, ticks: 400, own: wander(s0, 1, 31), inputDelay: (seq) => (seq % 3 === 0 ? 4 : 0) })
    expect(res.pred.stats.lateFrames).toBeGreaterThan(0)
    let maxErr = 0
    for (const d of res.shown) {
      const h = res.hostStates.get(d.tick)
      if (h) maxErr = Math.max(maxErr, Math.hypot(pawn(d, 1).x - pawn(h, 1).x, pawn(d, 1).y - pawn(h, 1).y))
    }
    // 2 ticks late (4 ticks of delay minus the 2-tick margin) at walk speed, plus smoothing residue
    expect(maxErr).toBeLessThan(2 * walk() + 18)
  })

  /**
   * Why: most snapshots only confirm what the client already predicted (bots and
   * players issue sticky orders, a few per second). Skipping those rollbacks cuts the
   * re-sim cost several times over and must not cost any exactness.
   */
  it('confirmed snapshots skip the rollback and every displayed tick stays exact', () => {
    const s0 = fight(2)
    const { shown, hostHash, pred } = simulate({ oneWay: 5, ticks: 600, own: wander(s0, 1, 23), confirmAll: true })
    for (const d of shown) if (hostHash.has(d.tick)) expect(hashNoEvents(d)).toBe(hostHash.get(d.tick))
    expect(pred.stats.confirms).toBeGreaterThan(pred.stats.rebases * 5)
  })

  /** Why: a wrong "confirmed" (a bug, a desync) must never drift for long: a rollback still happens periodically. */
  it('a wrong confirmation heals within FORCE_REBASE_TICKS', () => {
    const s0 = fight(2)
    const remote = wander(s0, 0, 29, 7)
    const res = simulate({ oneWay: 5, ticks: 500, own: wander(s0, 1, 37), remote: (t) => (t < 300 ? remote(t) : null), confirmAll: true })
    const after = res.shown.filter((d) => d.tick > 300 + FORCE_REBASE_TICKS + 2 * 5 + 20 && res.hostHash.has(d.tick))
    expect(after.length).toBeGreaterThan(50)
    for (const d of after) expect(hashNoEvents(d)).toBe(res.hostHash.get(d.tick))
  })

  it('re-simulation never exceeds MAX_AHEAD_TICKS and display ticks only go forward', () => {
    const s0 = fight(2)
    const res = simulate({ oneWay: 30, ticks: 300, own: wander(s0, 1, 17) })
    expect(res.pred.stats.maxResimTicks).toBeLessThanOrEqual(MAX_AHEAD_TICKS)
    for (let i = 1; i < res.shown.length; i++) expect(res.shown[i].tick).toBeGreaterThan(res.shown[i - 1].tick)
  })

  it('a correction beyond SNAP_DIST snaps instead of sliding across the arena', () => {
    const s = fight(2)
    const pred = new Predictor(1, step, cloneState)
    pred.offer(cloneState(s), 0)
    const shown: SimState[] = []
    pred.advance(s.tick + 5, (d) => shown.push(d))
    // the host says pawn 0 is far away (a teleport the client did not predict)
    const h = cloneState(s)
    for (let i = 0; i < 3; i++) step(h, [])
    pawn(h, 0).x += SNAP_DIST * 2
    pred.offer(h, 0)
    pred.advance(s.tick + 6, (d) => shown.push(d))
    const last = shown[shown.length - 1]
    expect(pred.stats.snaps).toBeGreaterThan(0)
    expect(Math.abs(pawn(last, 0).x - pawn(h, 0).x)).toBeLessThan(10)
  })
})

describe('EventLedger', () => {
  const cast = (pawnId: number): SimEvent => ({ type: 'cast', pawn: pawnId, spell: 'fireball', x: 1, y: 2 })
  const lava = (target: number): SimEvent => ({ type: 'damage', target, amount: 1.6, source: null, x: 0, y: 0, kb: 0 })

  /** Why: a rollback re-runs ticks; their SFX / VFX must not fire twice. */
  it('re-simulated and authoritative copies of an event play once, even a tick apart', () => {
    const l = new EventLedger()
    expect(l.take(10, [cast(3)], false)).toHaveLength(1)
    l.beginPass(0)
    // re-simulated a tick later, at a slightly different spot: the same cast
    expect(l.take(11, [{ type: 'cast', pawn: 3, spell: 'fireball', x: 5, y: 2 }], false)).toHaveLength(0)
    expect(l.take(10, [cast(3)], true)).toHaveLength(0)
    // a different caster is a different event
    expect(l.take(10, [cast(4)], true)).toHaveLength(1)
  })

  /** Why: per-tick series (lava damage) must stay one-to-one, not collapse into one event. */
  it('keeps per-tick series one-to-one across passes', () => {
    const l = new EventLedger()
    let played = 0
    for (let t = 1; t <= 5; t++) played += l.take(t, [lava(2)], false).length
    expect(played).toBe(5)
    l.beginPass(0)
    played = 0
    for (let t = 1; t <= 5; t++) played += l.take(t, [lava(2)], false).length
    expect(played).toBe(0)
    l.beginPass(0)
    played = 0
    for (let t = 2; t <= 6; t++) played += l.take(t, [lava(2)], false).length
    expect(played).toBe(1)
  })
})

describe('Predictor events', () => {
  /**
   * Why: a remote cast is revealed by a snapshot at or after its tick, which is never
   * re-simulated. It must still play (late), once, although every snapshot repeats it.
   */
  it('plays authoritative-only events once from the event stream, never from prediction', () => {
    const s = fight(2)
    const pred = new Predictor(1, step, cloneState)
    const got: SimEvent[] = []
    const ev = [{ tick: s.tick, events: [cast(0), { type: 'death', pawn: 9, owner: 0, killer: null } as SimEvent] }]
    pred.offer(cloneState(s), 0, ev)
    pred.advance(s.tick + 3, (_d, e) => got.push(...e))
    const s2 = cloneState(s)
    step(s2, [])
    pred.offer(s2, 0, ev)
    pred.advance(s.tick + 6, (_d, e) => got.push(...e))
    expect(got.filter((e) => e.type === 'cast')).toHaveLength(1)
    expect(got.filter((e) => e.type === 'death')).toHaveLength(1)
  })
  function cast(pawnId: number): SimEvent {
    return { type: 'cast', pawn: pawnId, spell: 'fireball', x: 1, y: 2 }
  }
})

describe('cancellable cast presentation', () => {
  function setup(player: number) {
    const state = fight(2)
    place(pawn(state, 0), -500, -500)
    place(pawn(state, 1), 0, 0, 0)
    const pred = new Predictor(player, step, cloneState)
    const shown: SimState[] = []
    const events: SimEvent[] = []
    const emit = (s: SimState, e: SimEvent[]) => { shown.push(s); events.push(...e) }
    const cast: InputCommand = { kind: 'cast', slot: FIREBALL_SLOT, x: 800, y: 0 }
    return { state, pred, shown, events, emit, cast }
  }

  it('keeps a remote windup charging until commit, so an unseen stop never launches a phantom', () => {
    const { state, pred, shown, events, emit, cast } = setup(0)
    step(state, [cmd(1, cast)])
    const start = state.tick
    const remaining = pawn(state, 1).cast!.ticksLeft
    pred.offer(cloneState(state), 0)
    pred.advance(start + remaining + 2, emit)
    expect(shown.every((s) => s.projectiles.length === 0)).toBe(true)
    expect(pawn(shown.at(-1)!, 1).cast?.spell).toBe('fireball')
    expect(events.filter((e) => e.type === 'cast' || e.type === 'projectileSpawn')).toEqual([])
    for (let i = 0; i < remaining - 1; i++) step(state, [])
    step(state, [cmd(1, { kind: 'stop' })])
    pred.offer(cloneState(state), 0, [{ tick: state.tick, events: state.events }])
    pred.advance(start + remaining + 3, emit)
    expect(state.projectiles).toEqual([])
    expect(shown.at(-1)!.projectiles).toEqual([])
    expect(pawn(shown.at(-1)!, 1).cast).toBeNull()
    expect(events.filter((e) => e.type === 'castCancel')).toHaveLength(1)
  })

  it('holds an unacknowledged own release when a late original cast can still be stopped', () => {
    const { state, pred, shown, events, emit, cast } = setup(1)
    const start = state.tick
    const trial = cloneState(state)
    step(trial, [cmd(1, cast)])
    const remaining = pawn(trial, 1).cast!.ticksLeft
    pred.offer(cloneState(state), 0)
    pred.advance(start, emit)
    pred.local({ seq: 1, tick: start, cmds: [cast] })
    pred.advance(start + remaining + 1, emit)
    expect(shown.every((s) => s.projectiles.length === 0)).toBe(true)
    expect(pawn(shown.at(-1)!, 1).cast?.spell).toBe('fireball')
    expect(events.filter((e) => e.type === 'cast' || e.type === 'projectileSpawn')).toEqual([])
    // The cast input reaches authority three ticks late. Stop is on time at
    // the client's predicted release, but authority is still winding up.
    for (let i = 0; i < 3; i++) step(state, [])
    step(state, [cmd(1, cast)])
    while (state.tick < start + remaining + 1) step(state, [])
    expect(pawn(state, 1).cast!.ticksLeft).toBe(3)
    pred.local({ seq: 2, tick: pred.stampNext(), cmds: [{ kind: 'stop' }] })
    pred.advance(pred.tick + 1, emit)
    expect(pawn(shown.at(-1)!, 1).cast).toBeNull()
    step(state, [cmd(1, { kind: 'stop' })])
    pred.offer(cloneState(state), 2, [{ tick: state.tick, events: state.events }])
    pred.advance(state.tick + 1, emit)
    expect(shown.every((s) => s.projectiles.length === 0)).toBe(true)
    expect(pawn(shown.at(-1)!, 1).cast).toBeNull()
    expect(events.filter((e) => e.type === 'cast' || e.type === 'projectileSpawn')).toEqual([])
  })

  it('keeps acknowledged own casts immediate and delivers confirmed remote releases once', () => {
    for (const player of [0, 1]) {
      const { state, pred, shown, events, emit, cast } = setup(player)
      const start = state.tick
      pred.offer(cloneState(state), 0)
      pred.advance(start, emit)
      if (player === 1) pred.local({ seq: 1, tick: start, cmds: [cast] })
      step(state, [cmd(1, cast)])
      const remaining = pawn(state, 1).cast!.ticksLeft
      pred.offer(cloneState(state), player === 1 ? 1 : 0)
      pred.advance(state.tick + remaining + 1, emit)
      expect(shown.at(-1)!.projectiles).toHaveLength(player === 1 ? 1 : 0)
      expect(events.filter((e) => e.type === 'cast')).toHaveLength(player === 1 ? 1 : 0)
      const confirmed: { tick: number; events: SimEvent[] }[] = []
      for (let i = 0; i < remaining; i++) {
        step(state, [])
        if (state.events.length) confirmed.push({ tick: state.tick, events: state.events.slice() })
      }
      pred.offer(cloneState(state), player === 1 ? 1 : 0, confirmed, true)
      pred.advance(state.tick + 2, emit)
      expect(shown.at(-1)!.projectiles).toHaveLength(1)
      expect(pawn(shown.at(-1)!, 1).cast).toBeNull()
      expect(events.filter((e) => e.type === 'cast')).toHaveLength(1)
      expect(events.filter((e) => e.type === 'projectileSpawn')).toHaveLength(1)
      pred.offer(cloneState(state), player === 1 ? 1 : 0, confirmed)
      pred.advance(state.tick + 3, emit)
      expect(events.filter((e) => e.type === 'cast')).toHaveLength(1)
      expect(events.filter((e) => e.type === 'projectileSpawn')).toHaveLength(1)
    }
  })

  it('creates no close-target hit, damage or explosion before a remote cast commits', () => {
    const { state, pred, shown, events, emit, cast } = setup(0)
    place(pawn(state, 0), 100, 0)
    const hp = pawn(state, 0).hp
    step(state, [cmd(1, cast)])
    const remaining = pawn(state, 1).cast!.ticksLeft
    pred.offer(cloneState(state), 0)
    pred.advance(state.tick + remaining + 12, emit)
    expect(shown.every((s) => pawn(s, 0).hp >= hp)).toBe(true)
    expect(events.filter((e) => ['cast', 'projectileSpawn', 'projectileHit', 'projectileExpire', 'damage', 'explosion'].includes(e.type))).toEqual([])
  })

  it('does not invent a remote cancel when a later order supersedes a locally held commit', () => {
    const { state, pred, shown, events, emit, cast } = setup(0)
    step(state, [cmd(1, cast)])
    const remaining = pawn(state, 1).cast!.ticksLeft
    const start = state.tick
    pred.offer(cloneState(state), 0)
    pred.advance(start + remaining + 1, emit)
    pred.hint(1, pred.tick, [{ kind: 'move', x: 700, y: 100 }])
    pred.advance(pred.tick + 1, emit)
    expect(pawn(shown.at(-1)!, 1).cast).toBeNull()
    expect(events.filter((e) => e.type === 'castCancel')).toEqual([])
    const confirmed: { tick: number; events: SimEvent[] }[] = []
    for (let i = 0; i < remaining; i++) {
      step(state, [])
      if (state.events.length) confirmed.push({ tick: state.tick, events: state.events.slice() })
    }
    pred.offer(cloneState(state), 0, confirmed, true)
    pred.advance(pred.tick + 1, emit)
    expect(events.filter((e) => e.type === 'cast')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'castCancel')).toEqual([])
  })

  it('rebases an already-held own release when a confirming ack aligns the original cast', () => {
    const { state, pred, shown, events, emit, cast } = setup(1)
    const start = state.tick
    pred.offer(cloneState(state), 0)
    pred.advance(start, emit)
    pred.local({ seq: 1, tick: start, cmds: [cast] })
    step(state, [cmd(1, cast)])
    const remaining = pawn(state, 1).cast!.ticksLeft
    pred.advance(state.tick + remaining + 1, emit)
    expect(shown.at(-1)!.projectiles).toEqual([])
    const target = pred.tick + 1
    const expected = cloneState(state)
    while (expected.tick < target) step(expected, [])
    pred.offer(cloneState(state), 1, [{ tick: state.tick, events: state.events }], true)
    pred.advance(target, emit)
    expect(shown.at(-1)!.projectiles).toEqual(expected.projectiles)
    expect(pawn(shown.at(-1)!, 1).cast).toBeNull()
    expect(events.filter((e) => e.type === 'cast')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'projectileSpawn')).toHaveLength(1)
  })

  it.each(['swap', 'splitter'])('keeps zero-point own %s casts immediate before acknowledgment', (spell) => {
    const { state, pred, shown, events, emit } = setup(1)
    const slot = grant(state, 1, spell)
    const start = state.tick
    pred.offer(cloneState(state), 0)
    pred.advance(start, emit)
    pred.local({ seq: 1, tick: start, cmds: [{ kind: 'cast', slot, x: 800, y: 0 }] })
    pred.advance(start + 1, emit)
    expect(events.some((e) => e.type === 'cast' && e.spell === spell)).toBe(true)
    expect(events.some((e) => e.type === 'projectileSpawn' && e.spell === spell)).toBe(true)
    expect(shown.at(-1)!.projectiles.length).toBeGreaterThan(0)
  })
})

describe('LeadClock', () => {
  /** Why: display ticks must never run backwards (render would reset the match). */
  it('predicted time only moves forward while the target swings both ways', () => {
    const c = new LeadClock()
    let last = -Infinity
    for (let now = 0; now < 5000; now += 4) {
      const rtt = now < 2000 ? 300 : now < 3000 ? 40 : 160
      c.update(now, 1000 + Math.sin(now / 100) * 3, rtt, 5)
      const t = c.tickAt(now)
      expect(t).toBeGreaterThanOrEqual(last)
      last = t
    }
  })

  /**
   * Why: a match start stalls the tab (shader compile) and inflates the jitter and RTT
   * estimates for a moment. The lead must stay capped and come back within a couple
   * of seconds, or the client predicts 300+ ms ahead (big remote corrections, 3× the re-sim).
   */
  it('recovers from a stall spike: lead capped, back near its target within ~2 s', () => {
    const c = new LeadClock()
    const base = 1000
    const frameMs = 1000 / TICK_HZ
    const ahead = (now: number) => c.tickAt(now) - (now - base) / frameMs
    for (let now = 0; now < 1000; now += 4) c.update(now, base, 100, 5)
    const steady = ahead(1000)
    expect(steady).toBeCloseTo((100 + frameMs + 10) / frameMs, 0)
    // a 2 s stall: jitter estimate 850 ms, RTT 330 ms
    for (let now = 1000; now < 3000; now += 4) c.update(now, base, 330, 850)
    expect(ahead(3000)).toBeLessThanOrEqual(MAX_AHEAD_TICKS - 2 + 0.01)
    for (let now = 3000; now < 5500; now += 4) c.update(now, base, 100, 8)
    expect(ahead(5500)).toBeLessThan(steady + 1.5)
  })

  it('widens the margin after late frames and narrows it after a calm spell', () => {
    const c = new LeadClock()
    c.feedLate(1, 1000)
    c.feedLate(2, 1500)
    expect(c.marginTicks).toBe(3)
    c.feedLate(2, 7000)
    expect(c.marginTicks).toBe(2)
  })
})

describe('net grades', () => {
  const ok = { rttMs: 40, jitterMs: 3, lossPct: 0, snapshotAgeMs: 20, channel: 'unreliable' as const, recentDesync: false }

  it('grades by the worst metric and names it', () => {
    expect(gradeOf(ok)).toEqual({ grade: 'good' })
    expect(gradeOf({ ...ok, rttMs: 160 })).toEqual({ grade: 'bad', reason: 'ping' })
    expect(gradeOf({ ...ok, lossPct: 10, rttMs: 100 })).toEqual({ grade: 'bad', reason: 'loss' })
    expect(gradeOf({ ...ok, snapshotAgeMs: 1500 })).toEqual({ grade: 'critical', reason: 'stale' })
    expect(gradeOf({ ...ok, channel: 'reliable' })).toEqual({ grade: 'ok', reason: 'reliable' })
    expect(gradeOf({ ...ok, recentDesync: true })).toEqual({ grade: 'bad', reason: 'desync' })
    expect(gradeOf({ ...ok, rttMs: null, jitterMs: null, lossPct: null, snapshotAgeMs: null, channel: null })).toEqual({ grade: 'good' })
  })

  /** Why: one spike must not flash a warning; a recovery must not flap. */
  it('hysteresis: worse after 2 samples (critical at once), better after 4', () => {
    const t = new GradeTracker()
    expect(t.update({ grade: 'bad', reason: 'ping' }, 1)).toBeNull()
    expect(t.update({ grade: 'bad', reason: 'ping' }, 1)).toEqual({ playerId: 1, from: 'good', to: 'bad', reason: 'ping' })
    expect(t.update({ grade: 'critical', reason: 'stale' }, 1)).toEqual({ playerId: 1, from: 'bad', to: 'critical', reason: 'stale' })
    for (let i = 0; i < 3; i++) expect(t.update({ grade: 'good' }, 1)).toBeNull()
    expect(t.update({ grade: 'good' }, 1)).toEqual({ playerId: 1, from: 'critical', to: 'good' })
  })

  it('loss from packet counters, duplicates and reordering ignored', () => {
    const l = new LossTracker()
    expect(l.pct).toBeNull()
    for (let n = 1; n <= 100; n++) if (n % 10 !== 0) l.track(n)
    l.track(5)
    expect(l.pct).toBeCloseTo(9, 0)
  })
})
