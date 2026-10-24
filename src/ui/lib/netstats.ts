/**
 * Connection quality for the HUD indicator, net graph, warnings and lobby.
 * Pure: types, normalizing the net layer's per-peer stats (src/net/netstats.ts,
 * `session.netStats()`), a jitter estimate for the fallback path and the
 * warning state machine. Grades and thresholds come from the net layer's
 * table, so the HUD and the netcode agree on what "bad" means. The live
 * sampling lives in netmonitor.ts.
 */
import { GRADE_LIMITS, gradeOf as netGradeOf } from '../../net/netstats'

export type NetGrade = 'good' | 'ok' | 'bad' | 'critical'
/** 'raw' = the unordered, unreliable data channel; 'reliable' = the ordered fallback */
export type NetChannel = 'raw' | 'reliable' | 'pending'

/** One link: the host's view of a client, or a client's view of the host. Null = not measured. */
export interface PeerNet {
  playerId: number
  rttMs: number | null
  jitterMs: number | null
  lossPct: number | null
  snapshotAgeMs: number | null
  channel: NetChannel | null
  inputAckLagMs: number | null
  correctionPx: number | null
  desyncs: number | null
  grade: NetGrade
}

export interface NetSnapshot {
  role: 'offline' | 'host' | 'client'
  /** host: one per client; client: the link to the host */
  peers: PeerNet[]
  /** 'net' = the net layer's stats API, 'derived' = UI fallback from ping and loss */
  source: 'net' | 'derived' | 'sim'
}

export const GRADES: readonly NetGrade[] = ['good', 'ok', 'bad', 'critical']
export const GRADE_COLOR: Record<NetGrade, string> = { good: '#7fe39a', ok: '#ffc548', bad: '#ff8a3d', critical: '#ff4a3d' }
export const GRADE_LABEL: Record<NetGrade, string> = { good: 'Good', ok: 'Fair', bad: 'Poor', critical: 'Critical' }
/** signal bars lit per grade */
export const GRADE_BARS: Record<NetGrade, number> = { good: 4, ok: 3, bad: 2, critical: 1 }

export function worseGrade(a: NetGrade, b: NetGrade): NetGrade {
  return GRADES.indexOf(a) >= GRADES.indexOf(b) ? a : b
}

export function worstGrade(peers: readonly { grade: NetGrade }[]): NetGrade | null {
  return peers.length ? peers.reduce<NetGrade>((w, p) => worseGrade(w, p.grade), 'good') : null
}

/** Grade with the net layer's table, for links it did not grade (the UI fallback path). */
export function gradeOf(p: Omit<PeerNet, 'grade'>): NetGrade {
  const channel = p.channel === 'raw' ? 'unreliable' : p.channel === 'reliable' ? 'reliable' : null
  return netGradeOf({ rttMs: p.rttMs, jitterMs: p.jitterMs, lossPct: p.lossPct, snapshotAgeMs: p.snapshotAgeMs, channel, recentDesync: false }).grade
}

const CHANNEL_LABEL = { raw: 'Fast (unreliable)', reliable: 'Reliable fallback', pending: 'Negotiating' } as const

/** Readable lines for one link; unmeasured values are left out. */
export function peerLines(p: PeerNet): [string, string][] {
  const rows: [string, string][] = [['Ping', p.rttMs === null ? 'measuring…' : `${Math.round(p.rttMs)} ms`]]
  if (p.jitterMs !== null) rows.push(['Jitter', `±${Math.round(p.jitterMs)} ms`])
  if (p.lossPct !== null) rows.push(['Packet loss', `${p.lossPct < 10 ? p.lossPct.toFixed(1) : Math.round(p.lossPct)}%`])
  if (p.snapshotAgeMs !== null) rows.push(['Last update', `${Math.round(p.snapshotAgeMs)} ms ago`])
  if (p.channel !== null) rows.push(['Channel', CHANNEL_LABEL[p.channel]])
  if (p.inputAckLagMs !== null) rows.push(['Input confirmed after', `${Math.round(p.inputAckLagMs)} ms`])
  // game units; a pawn's radius is 30
  if (p.correctionPx !== null) rows.push(['Position correction', `${p.correctionPx.toFixed(1)} units`])
  if (p.desyncs !== null) rows.push(['Desyncs', String(p.desyncs)])
  return rows
}

/** Plain-text summary for native tooltips (lobby ping bars). */
export function peerTitle(p: PeerNet): string {
  return [`Connection: ${GRADE_LABEL[p.grade]}`, ...peerLines(p).map(([k, v]) => `${k}: ${v}`)].join('\n')
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Accepts the net layer's per-peer object leniently (fields may be missing or renamed slightly). */
export function normalizePeer(raw: Record<string, unknown>): PeerNet | null {
  const playerId = num(raw.playerId ?? raw.id)
  const rttMs = num(raw.rttMs ?? raw.rtt)
  if (playerId === null) return null
  const ch = raw.channel ?? raw.channelMode ?? raw.unreliableMode
  const channel: NetChannel | null = ch === 'raw' || ch === 'unreliable' ? 'raw' : ch === 'reliable' ? 'reliable' : ch === 'pending' ? 'pending' : null
  const p = {
    playerId,
    rttMs,
    jitterMs: num(raw.jitterMs ?? raw.jitter),
    lossPct: num(raw.lossPct ?? raw.loss),
    snapshotAgeMs: num(raw.snapshotAgeMs ?? raw.snapshotAge),
    channel,
    inputAckLagMs: num(raw.inputAckLagMs ?? raw.ackLagMs),
    correctionPx: num(raw.correctionPx ?? raw.correction),
    desyncs: num(raw.desyncs ?? raw.desyncCount),
  }
  const g = raw.grade
  return { ...p, grade: typeof g === 'string' && (GRADES as readonly string[]).includes(g) ? (g as NetGrade) : gradeOf(p) }
}

/**
 * Jitter from successive RTT readings (RFC 3550 style smoothing, 1/8 gain).
 * Fed only on a new reading, so a value polled twice does not count as calm.
 */
export class JitterEstimate {
  private last: number | null = null
  value = 0
  push(rttMs: number): number {
    if (this.last !== null && rttMs !== this.last) this.value += (Math.abs(rttMs - this.last) - this.value) / 8
    this.last = rttMs
    return this.value
  }
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

export type WarnKind = 'ping' | 'jitter' | 'loss' | 'stale' | 'reliable' | 'desync'

export interface NetWarning {
  kind: WarnKind
  text: string
}

/**
 * Warn at the net layer's 'bad' line (GRADE_LIMITS: good / ok / bad); clear
 * only once the value is back under the midpoint of 'good' and 'ok', so a
 * value hovering at the line does not flap.
 */
const limit = (lim: readonly number[], value: (p: PeerNet) => number | null) => ({ on: lim[1], off: (lim[0] + lim[1]) / 2, value })
const LIMITS: Record<Exclude<WarnKind, 'reliable' | 'desync'>, { on: number; off: number; value: (p: PeerNet) => number | null }> = {
  ping: limit(GRADE_LIMITS.ping, (p) => p.rttMs),
  jitter: limit(GRADE_LIMITS.jitter, (p) => p.jitterMs),
  loss: limit(GRADE_LIMITS.loss, (p) => p.lossPct),
  stale: limit(GRADE_LIMITS.stale, (p) => p.snapshotAgeMs),
}

function warnText(kind: WarnKind, p: PeerNet): string {
  switch (kind) {
    case 'ping':
      return `High ping ${Math.round(p.rttMs ?? 0)} ms`
    case 'jitter':
      return `Unstable ping, ±${Math.round(p.jitterMs ?? 0)} ms`
    case 'loss':
      return `Packet loss ${Math.round(p.lossPct ?? 0)}%`
    case 'stale':
      return `No updates from the host for ${((p.snapshotAgeMs ?? 0) / 1000).toFixed(1)} s`
    case 'reliable':
      return 'Fallback to the reliable channel: expect extra delay'
    case 'desync':
      return 'Out of sync with the host, resyncing'
  }
}

/** a condition must hold this long before it warns, so one slow packet stays quiet */
export const WARN_HOLD_MS = 1000
/** and must stay clear this long before the warning goes away */
export const CLEAR_HOLD_MS = 3000
/** the same warning toasts again at most this often */
export const REPEAT_MS = 30_000
/** any two warning toasts at least this far apart */
export const GAP_MS = 8000

interface Track {
  since: number
  clearSince: number
  active: boolean
}

/**
 * Turns snapshots of the local link (client) and of every client (host) into:
 * active warnings for the HUD icon, flagged players for scoreboard and lobby,
 * and rate-limited toast lines. Deterministic in `now`, so it is unit tested.
 */
export class NetWarnings {
  private own = new Map<WarnKind, Track>()
  private players = new Map<number, Track>()
  private toastedAt = new Map<string, number>()
  private lastToast = -Infinity
  private lastDesyncs: number | null = null
  private desyncAt = -Infinity

  /** current warnings about your own link */
  active: NetWarning[] = []
  /** host: clients whose link is bad right now */
  flagged = new Set<number>()

  /** Returns the toast lines to show now (at most one per call). */
  update(snap: NetSnapshot, now: number, nameOf: (id: number) => string, localStallMs = 0): string[] {
    const out: string[] = []
    if (snap.role === 'client' && snap.peers[0]) this.updateOwn(snap.peers[0], now, out, localStallMs)
    else this.resetOwn()
    if (snap.role === 'host') this.updatePlayers(snap.peers, now, nameOf, out, localStallMs)
    else this.flagged.clear()
    return out
  }

  private hold(t: Track | undefined, cond: boolean, clear: boolean, now: number): Track {
    const s = t ?? { since: -1, clearSince: -1, active: false }
    if (cond) {
      if (s.since < 0) s.since = now
      s.clearSince = -1
      if (!s.active && now - s.since >= WARN_HOLD_MS) s.active = true
    } else {
      s.since = -1
      if (clear) {
        if (s.clearSince < 0) s.clearSince = now
        if (s.active && now - s.clearSince >= CLEAR_HOLD_MS) s.active = false
      } else s.clearSince = -1
    }
    return s
  }

  private emit(key: string, text: string, now: number, out: string[]): void {
    if (out.length) return
    if (now - this.lastToast < GAP_MS) return
    if (now - (this.toastedAt.get(key) ?? -Infinity) < REPEAT_MS) return
    this.toastedAt.set(key, now)
    this.lastToast = now
    out.push(text)
  }

  private updateOwn(p: PeerNet, now: number, out: string[], localStallMs: number): void {
    const active: NetWarning[] = []
    for (const kind of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
      const lim = LIMITS[kind]
      const v = lim.value(p)
      const t = this.hold(this.own.get(kind), v !== null && v >= lim.on, v === null || v < lim.off, now)
      this.own.set(kind, t)
      if (t.active) {
        const text = localStallMs > 0 && kind !== 'loss'
          ? `${kind === 'ping' ? `High round-trip time ${Math.round(p.rttMs ?? 0)} ms` : kind === 'jitter' ? 'Variable round-trip time' : 'Delayed game updates'} · local device stall observed`
          : warnText(kind, p)
        active.push({ kind, text })
      }
    }
    const rel = this.hold(this.own.get('reliable'), p.channel === 'reliable', p.channel !== 'reliable', now)
    this.own.set('reliable', rel)
    if (rel.active) active.push({ kind: 'reliable', text: warnText('reliable', p) })
    // desync: any new desync shows for a few seconds
    if (p.desyncs !== null) {
      if (this.lastDesyncs !== null && p.desyncs > this.lastDesyncs) this.desyncAt = now
      this.lastDesyncs = p.desyncs
    }
    if (now - this.desyncAt < CLEAR_HOLD_MS) active.push({ kind: 'desync', text: warnText('desync', p) })

    const before = new Set(this.active.map((w) => w.kind))
    // a warning that just became active toasts; the worst one first (stale > loss > ping > ...)
    const order: WarnKind[] = ['stale', 'desync', 'loss', 'ping', 'jitter', 'reliable']
    const fresh = active.filter((w) => !before.has(w.kind)).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
    for (const w of fresh) this.emit(`own:${w.kind}`, w.text, now, out)
    this.active = active
  }

  private resetOwn(): void {
    this.own.clear()
    this.active = []
    this.lastDesyncs = null
    this.desyncAt = -Infinity
  }

  private updatePlayers(peers: readonly PeerNet[], now: number, nameOf: (id: number) => string, out: string[], localStallMs: number): void {
    const seen = new Set<number>()
    for (const p of peers) {
      seen.add(p.playerId)
      const bad = p.grade === 'bad' || p.grade === 'critical'
      const t = this.hold(this.players.get(p.playerId), bad, p.grade === 'good' || p.grade === 'ok', now)
      this.players.set(p.playerId, t)
      if (t.active && !this.flagged.has(p.playerId)) {
        this.flagged.add(p.playerId)
        this.emit(`player:${p.playerId}`, localStallMs > 0 ? `${nameOf(p.playerId)}: delayed link · local device stall observed` : `${nameOf(p.playerId)}: unstable connection`, now, out)
      } else if (!t.active) this.flagged.delete(p.playerId)
    }
    for (const id of [...this.players.keys()]) {
      if (!seen.has(id)) {
        this.players.delete(id)
        this.flagged.delete(id)
      }
    }
  }
}
