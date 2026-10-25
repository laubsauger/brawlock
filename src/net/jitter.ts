/**
 * Client-side snapshot playout (jitter buffer).
 *
 * Maps host ticks to local time. base = min over recent snapshots of
 * (arrival - tick * DT), the arrival time of tick 0 over the fastest path. Tick T
 * plays at offset + T * DT where offset = base + delay; `delay` covers jitter
 * (2 snapshot intervals plus a multiple of the measured jitter) so a late packet
 * is still in the buffer when its tick is due. The offset is steered toward its
 * target at most STEER (5 %) of elapsed time, so playback speed never visibly
 * jumps; large errors (tab stalls, first packets) snap.
 *
 * Each played state is handed out with its ideal display time `at`, so render's
 * alpha = (now - currAt) / (currAt - prevAt) interpolates smoothly even though
 * the pull itself runs on a jittery timer.
 */
import { TICK_HZ, onTickRate, type SimState } from '../sim/types'
import type { TickEvents } from './protocol'

let DT_MS = 0
/** delay bounds, ms */
let MIN_DELAY_MS = 0
onTickRate(() => {
  DT_MS = 1000 / TICK_HZ
  MIN_DELAY_MS = 2 * DT_MS
})
const MAX_DELAY_MS = 250
/** max playback-speed correction: 5 % */
const STEER = 0.05
/** base error beyond which we snap instead of steering */
const SNAP_MS = 120
/** arrival samples kept for the base estimate (~2 s at 60 Hz) */
const SAMPLE_WINDOW = 120
/** snapshot counters kept for the loss estimate */
const LOSS_WINDOW = 120
const MAX_BUFFERED = 90

interface Buffered {
  tick: number
  state: SimState
}

export interface IncomingSnap {
  n: number
  iv: number
  ev: TickEvents[]
  state: SimState
}

export class SnapshotBuffer {
  private buf: Buffered[] = []
  private events = new Map<number, TickEvents['events']>()
  private lastPlayed = -1
  private lastEventTick = -1
  /** base + delay, ms */
  private offset = NaN
  private samples: number[] = []
  /** mean deviation from the fastest arrival; starts pessimistic, adapts down */
  private jitter = 8
  private ivMs = DT_MS
  private lastPull = NaN
  private recentN: number[] = []
  private maxN = -1
  private firstN = -1
  /** current playout delay, ms */
  delayMs = 3 * DT_MS
  /** newest tick received */
  latestTick = -1
  latestAt = 0

  /** Returns false for stale or duplicate snapshots (ignored). */
  push(s: IncomingSnap, arrival: number): boolean {
    this.trackLoss(s.n)
    const tick = s.state.tick
    if (tick <= this.lastPlayed) return false
    let i = this.buf.length
    while (i > 0 && this.buf[i - 1].tick > tick) i--
    if (i > 0 && this.buf[i - 1].tick === tick) return false
    this.buf.splice(i, 0, { tick, state: s.state })
    if (this.buf.length > MAX_BUFFERED) this.buf.shift()

    for (const e of s.ev) {
      if (e.tick > this.lastEventTick && !this.events.has(e.tick)) this.events.set(e.tick, e.events)
    }

    const sample = arrival - tick * DT_MS
    this.samples.push(sample)
    if (this.samples.length > SAMPLE_WINDOW) this.samples.shift()
    const min = this.windowMin()
    this.jitter = this.jitter * 0.95 + (sample - min) * 0.05
    this.ivMs = Math.max(1, s.iv) * DT_MS
    if (tick > this.latestTick) {
      this.latestTick = tick
      this.latestAt = arrival
    }
    return true
  }

  /**
   * Play every buffered tick that is due at `now`, oldest first. `play` gets the
   * state (with its own tick's events restored), its ideal display time and the
   * events of every tick since the previous play, in order.
   */
  pull(now: number, play: (state: SimState, at: number, events: TickEvents[]) => void): void {
    if (this.samples.length === 0) return
    const dt = Number.isNaN(this.lastPull) ? 0 : Math.max(0, now - this.lastPull)
    this.lastPull = now

    const min = this.windowMin()
    const target = min + clamp(2 * this.ivMs + 2.5 * this.jitter, MIN_DELAY_MS, MAX_DELAY_MS)
    const d = target - this.offset
    if (Number.isNaN(d) || Math.abs(d) > SNAP_MS) this.offset = target
    else this.offset += clamp(d, -dt * STEER, dt * STEER)
    this.delayMs = this.offset - min

    const renderTick = (now - this.offset) / DT_MS
    while (this.buf.length && this.buf[0].tick <= renderTick) {
      const b = this.buf.shift()!
      const due: TickEvents[] = []
      if (this.events.size) {
        const ticks = [...this.events.keys()].filter((t) => t <= b.tick).sort((x, y) => x - y)
        for (const t of ticks) {
          due.push({ tick: t, events: this.events.get(t)! })
          this.events.delete(t)
        }
      }
      this.lastEventTick = b.tick
      this.lastPlayed = b.tick
      const own = due.length && due[due.length - 1].tick === b.tick ? due[due.length - 1].events : []
      b.state.events = own
      play(b.state, this.offset + b.tick * DT_MS, due)
    }
  }

  /** Local arrival time of host tick 0 over the fastest recent path, ms. NaN before the first snapshot. */
  get baseMs(): number {
    return this.samples.length ? this.windowMin() : NaN
  }

  /** Mean deviation of snapshot arrivals from the fastest path, ms. */
  get jitterMs(): number {
    return this.jitter
  }

  /** Fraction of snapshots lost recently, 0..100. */
  get lossPct(): number {
    if (this.maxN < 0) return 0
    const lo = Math.max(this.firstN, this.maxN - LOSS_WINDOW + 1)
    const expected = this.maxN - lo + 1
    let got = 0
    for (const n of this.recentN) if (n >= lo) got++
    return expected > 0 ? Math.max(0, (1 - got / expected) * 100) : 0
  }

  private trackLoss(n: number): void {
    if (this.firstN < 0) this.firstN = n
    if (this.recentN.includes(n)) return
    this.recentN.push(n)
    if (n > this.maxN) this.maxN = n
    if (this.recentN.length > LOSS_WINDOW * 2) {
      const lo = this.maxN - LOSS_WINDOW + 1
      this.recentN = this.recentN.filter((x) => x >= lo)
    }
  }

  private windowMin(): number {
    let m = Infinity
    for (const s of this.samples) if (s < m) m = s
    return m
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
