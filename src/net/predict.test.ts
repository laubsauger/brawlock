import { describe, expect, it } from 'vitest'
import { cloneState, hashState, step } from '../sim'
import { fight, pawn } from '../sim/testkit'
import type { InputCommand, PlayerInput, SimEvent, SimState } from '../sim/types'
import { EventLedger, LeadClock, MAX_AHEAD_TICKS, Predictor, SNAP_DIST, type LocalFrame } from './predict'
import { GradeTracker, LossTracker, gradeOf } from './netstats'

const hashNoEvents = (s: SimState) => hashState({ ...s, events: [] })

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
      pred.offer(s.state, s.ack)
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
    // a reversal at walk speed (3.5 / tick) over the prediction lead
    expect(maxErr).toBeGreaterThan(20)
    expect(maxErr).toBeLessThan(2 * 3.5 * (res.lead + 2) + 5)
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
    // 2 ticks late (4 ticks of delay minus the 2-tick margin) at 3.5 units / tick, plus smoothing residue
    expect(maxErr).toBeLessThan(25)
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
