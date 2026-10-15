/**
 * Connection monitoring for the UI (overlay, warnings). The session refreshes
 * one NetStatsView every STATS_MS (~4×/s): the host has one row per client, a
 * client one row for its link to the host. Values that cannot be measured
 * (yet) are null.
 *
 * Where each number comes from:
 * - rttMs / jitterMs: transport ping probes on the unreliable path (2 Hz),
 *   smoothed RTT and the mean deviation of RTT samples.
 * - lossPct: the worse direction. Host → client from snapshot counters (client
 *   measures), client → host from input packet counters (host measures). Each
 *   side learns the other direction from the peer's 1 Hz report.
 * - snapshotAgeMs: ms since the newest snapshot arrived (client measures; the
 *   host shows the client's report, or how long that report is overdue).
 * - inputAckLagMs: smoothed time from sending an input frame to its ack.
 * - correctionPx: prediction mode, largest visual correction of the client's own
 *   pawn over the last second (game units; pawn radius is 30). 0 = every own
 *   input was predicted exactly. null in classic mode.
 * - desyncs: failed determinism checks (client re-simulates a snapshot pair with
 *   the host's inputs and compares state hashes, ~2×/s).
 *
 * Grade = worst of these, each against GRADE_LIMITS (good below the first
 * number, ok below the second, bad below the third, else critical):
 *   ping (RTT ms)      80 / 150 / 250
 *   jitter (ms)        10 / 25 / 50
 *   loss (%)            2 / 5 / 15
 *   stale (ms)        150 / 300 / 1000   snapshot age (link stalls)
 *   reliable           at best 'ok': the unreliable channel fell back to the
 *                      reliable one (head-of-line blocking under loss)
 *   desync             'bad' for 10 s after a failed determinism check
 * Hysteresis: a worse grade needs 2 consecutive samples (critical: 1), a better
 * one 4, so a single spike neither warns nor flaps.
 */
import type { PlayerId } from '../sim/types'

export type NetGrade = 'good' | 'ok' | 'bad' | 'critical'
export type NetGradeReason = 'ping' | 'jitter' | 'loss' | 'stale' | 'reliable' | 'desync'

export interface PeerNetStats {
  playerId: PlayerId
  rttMs: number | null
  jitterMs: number | null
  /** 0..100 */
  lossPct: number | null
  snapshotAgeMs: number | null
  channel: 'unreliable' | 'reliable' | null
  inputAckLagMs: number | null
  correctionPx: number | null
  desyncs: number | null
  grade: NetGrade
}

export interface NetStatsView {
  role: 'host' | 'client'
  peers: PeerNetStats[]
}

export interface NetGradeEvent {
  playerId: PlayerId
  from: NetGrade
  to: NetGrade
  reason?: NetGradeReason
}

export const STATS_MS = 250

export const GRADE_LIMITS = {
  ping: [80, 150, 250],
  jitter: [10, 25, 50],
  loss: [2, 5, 15],
  stale: [150, 300, 1000],
} as const

/** a failed determinism check keeps the link at 'bad' this long */
export const DESYNC_HOLD_MS = 10000

const ORDER: NetGrade[] = ['good', 'ok', 'bad', 'critical']
const rank = (g: NetGrade) => ORDER.indexOf(g)

export interface GradeInput {
  rttMs: number | null
  jitterMs: number | null
  lossPct: number | null
  snapshotAgeMs: number | null
  channel: 'unreliable' | 'reliable' | null
  /** a determinism check failed within DESYNC_HOLD_MS */
  recentDesync: boolean
}

/** Raw grade (no hysteresis) and the metric that set it. */
export function gradeOf(s: GradeInput): { grade: NetGrade; reason?: NetGradeReason } {
  let grade: NetGrade = 'good'
  let reason: NetGradeReason | undefined
  const worse = (g: NetGrade, r: NetGradeReason) => {
    if (rank(g) > rank(grade)) {
      grade = g
      reason = r
    }
  }
  const level = (v: number | null, lim: readonly number[]): NetGrade =>
    v === null ? 'good' : v < lim[0] ? 'good' : v < lim[1] ? 'ok' : v < lim[2] ? 'bad' : 'critical'
  worse(level(s.rttMs, GRADE_LIMITS.ping), 'ping')
  worse(level(s.jitterMs, GRADE_LIMITS.jitter), 'jitter')
  worse(level(s.lossPct, GRADE_LIMITS.loss), 'loss')
  worse(level(s.snapshotAgeMs, GRADE_LIMITS.stale), 'stale')
  if (s.channel === 'reliable') worse('ok', 'reliable')
  if (s.recentDesync) worse('bad', 'desync')
  return reason ? { grade, reason } : { grade }
}

/** Hysteresis on top of gradeOf: returns a change event, or null. */
export class GradeTracker {
  grade: NetGrade = 'good'
  private candidate: NetGrade = 'good'
  private count = 0

  update(raw: { grade: NetGrade; reason?: NetGradeReason }, playerId: PlayerId): NetGradeEvent | null {
    if (raw.grade === this.grade) {
      this.count = 0
      return null
    }
    if (raw.grade !== this.candidate) {
      this.candidate = raw.grade
      this.count = 0
    }
    this.count++
    const need = rank(raw.grade) > rank(this.grade) ? (raw.grade === 'critical' ? 1 : 2) : 4
    if (this.count < need) return null
    const from = this.grade
    this.grade = raw.grade
    this.count = 0
    return raw.reason ? { playerId, from, to: raw.grade, reason: raw.reason } : { playerId, from, to: raw.grade }
  }
}

/** Packet loss from a per-packet counter (1, 2, 3, ...), over the last WINDOW packets. */
export class LossTracker {
  private static readonly WINDOW = 120
  private seen: number[] = []
  private max = -1
  private first = -1

  track(n: number): void {
    if (!Number.isInteger(n) || n < 1) return
    if (this.first < 0) this.first = n
    if (this.seen.includes(n)) return
    this.seen.push(n)
    if (n > this.max) this.max = n
    if (this.seen.length > LossTracker.WINDOW * 2) {
      const lo = this.max - LossTracker.WINDOW + 1
      this.seen = this.seen.filter((x) => x >= lo)
    }
  }

  /** 0..100, null before the first packet */
  get pct(): number | null {
    if (this.max < 0) return null
    const lo = Math.max(this.first, this.max - LossTracker.WINDOW + 1)
    let got = 0
    for (const n of this.seen) if (n >= lo) got++
    const expected = this.max - lo + 1
    return Math.max(0, (1 - got / expected) * 100)
  }
}

/** Largest value seen over a sliding time window. */
export class WindowMax {
  private samples: { at: number; v: number }[] = []
  constructor(private readonly windowMs: number) {}

  add(at: number, v: number): void {
    this.samples.push({ at, v })
    this.prune(at)
  }

  value(now: number): number {
    this.prune(now)
    let m = 0
    for (const s of this.samples) if (s.v > m) m = s.v
    return m
  }

  private prune(now: number): void {
    let i = 0
    while (i < this.samples.length && now - this.samples[i].at > this.windowMs) i++
    if (i) this.samples.splice(0, i)
  }
}
