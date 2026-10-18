/**
 * Plays a replay back by re-simulating it: the recorded start state, then every tick's
 * recorded inputs (and `connected` patches) through the same deterministic sim step.
 * Every recorded hash checkpoint is compared with the re-simulated state; the first
 * difference marks the replay as desynced (it keeps playing, the UI shows a warning).
 *
 * Seeking: keyframes (full state copies) every KEYFRAME_EVERY ticks are kept as playback
 * passes them; a seek restores the nearest keyframe at or before the target and
 * re-simulates the rest, so it lands on exactly the state forward play reaches.
 */
import { cloneState, step as simStep } from '../../sim'
import type { PlayerInput, SimEvent, SimState } from '../../sim/types'
import { checkReplay, decodeInputs, type ReplayCheck, type ReplayData, type ReplayStep } from './format'
import { replayHash } from './recorder'

/** 10 s */
export const KEYFRAME_EVERY = 600

export interface Desync {
  tick: number
  expected: number
  got: number
}

export class ReplayPlayer {
  readonly data: ReplayData
  readonly check: ReplayCheck
  private readonly steps = new Map<number, ReplayStep>()
  private readonly resyncs = new Map<number, SimState>()
  private readonly hashes = new Map<number, number>()
  private readonly keyframes = new Map<number, SimState>()
  private readonly stepFn: (s: SimState, inputs: PlayerInput[]) => void
  private cur: SimState
  desync: Desync | null = null

  constructor(data: ReplayData, netId: string, stepFn: (s: SimState, inputs: PlayerInput[]) => void = simStep) {
    this.data = data
    this.check = checkReplay(data, netId)
    this.stepFn = stepFn
    for (const s of data.steps) this.steps.set(s[0], s)
    for (const [t, s] of data.resyncs) this.resyncs.set(t, s)
    for (const [t, h] of data.hashes) this.hashes.set(t, h)
    this.cur = cloneState(data.start)
    this.keyframes.set(this.cur.tick, cloneState(this.cur))
  }

  get playable(): boolean {
    return this.check.ok
  }
  get startTick(): number {
    return this.data.start.tick
  }
  get endTick(): number {
    return this.data.endTick
  }
  get tick(): number {
    return this.cur.tick
  }
  /** current state (its `events` = the last step's events). Do not mutate. */
  get state(): SimState {
    return this.cur
  }
  get done(): boolean {
    return this.cur.tick >= this.data.endTick
  }

  /** Advance one tick. Returns that step's events (empty at the end / when unplayable). */
  stepOnce(): SimEvent[] {
    if (!this.check.ok || this.done) return []
    const t = this.cur.tick
    const resync = this.resyncs.get(t)
    if (resync) this.cur = cloneState(resync)
    const rec = this.steps.get(t)
    if (rec?.[2]) {
      for (const [id, on] of rec[2]) {
        const sc = this.cur.scores.find((s) => s.id === id)
        if (sc) sc.connected = on === 1
      }
    }
    this.stepFn(this.cur, rec ? decodeInputs(rec) : [])
    const now = this.cur.tick
    const want = this.hashes.get(now)
    if (want !== undefined && !this.desync) {
      const got = replayHash(this.cur)
      if (got !== want) this.desync = { tick: now, expected: want, got }
    }
    if (now % KEYFRAME_EVERY === 0 && !this.keyframes.has(now)) this.keyframes.set(now, cloneState(this.cur))
    return this.cur.events
  }

  /** Jump to `tick` (clamped to the replay): nearest keyframe at or before it, then re-sim. */
  seek(tick: number): void {
    if (!this.check.ok) return
    const target = Math.max(this.startTick, Math.min(this.endTick, Math.round(tick)))
    let best = this.startTick
    for (const k of this.keyframes.keys()) if (k <= target && k > best) best = k
    // restore only when the current state is past the target or behind the best keyframe;
    // otherwise playing on from here is the shortest way
    if (this.cur.tick > target || this.cur.tick < best) this.cur = cloneState(this.keyframes.get(best)!)
    while (this.cur.tick < target) this.stepOnce()
  }
}
