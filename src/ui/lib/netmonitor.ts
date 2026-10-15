import { frame } from '../../game/frame'
import { session } from '../../game/session'
import { useGame } from '../../game/store'
import { onTick, usePolled } from './ticker'
import { toast } from './toast'
import { JitterEstimate, NetWarnings, normalizePeer, gradeOf, type NetSnapshot, type NetWarning, type PeerNet } from './netstats'

/**
 * Live connection monitor: samples the link stats at 4 Hz, keeps 30 s of
 * history per peer for the net graph, and drives the warnings (toasts, HUD
 * icon, flagged players).
 *
 * Source, in order:
 * 1. a simulated source set with setNetOverride (tests and screenshots),
 * 2. the net layer's per-peer stats, `session.netStats()`, when it exists,
 * 3. a fallback derived from frame.net (ping, loss) and lobby.pings, with
 *    jitter estimated here and the grade from gradeOf.
 */

export const SAMPLE_MS = 250
/** 30 s at 4 Hz */
export const HISTORY = 120

export interface PeerHistory {
  rtt: number[]
  jitter: number[]
  loss: number[]
}

export interface MonitorState {
  snap: NetSnapshot
  warnings: NetWarning[]
  flagged: ReadonlySet<number>
}

type RawView = { role?: string; peers?: Record<string, unknown>[] } | null | undefined
type Override = (now: number) => RawView

let override: Override | null = null
const history = new Map<number, PeerHistory>()
const jitter = new Map<number, JitterEstimate>()
const warn = new NetWarnings()
let state: MonitorState = { snap: { role: 'offline', peers: [], source: 'derived' }, warnings: [], flagged: new Set() }

/** Replace the live source with simulated stats (screenshots, tests). null restores it. */
export function setNetOverride(fn: Override | null): void {
  override = fn
  history.clear()
  jitter.clear()
}

function fromRaw(raw: RawView, role: NetSnapshot['role'], source: NetSnapshot['source']): NetSnapshot | null {
  if (!raw || !Array.isArray(raw.peers)) return null
  const r = raw.role === 'host' || raw.role === 'client' ? raw.role : role
  const peers = raw.peers.map(normalizePeer).filter((p): p is PeerNet => p !== null)
  return { role: r, peers, source }
}

function jitterFor(id: number, rtt: number): number {
  let j = jitter.get(id)
  if (!j) jitter.set(id, (j = new JitterEstimate()))
  return j.push(rtt)
}

function derived(now: number): NetSnapshot {
  const g = useGame.getState()
  const { role, pings, slots, localPlayer } = g.lobby
  if (role === 'offline') return { role, peers: [], source: 'derived' }
  const peer = (playerId: number, rttMs: number, lossPct: number | null, snapshotAgeMs: number | null): PeerNet => {
    const p = { playerId, rttMs, jitterMs: jitterFor(playerId, rttMs), lossPct, snapshotAgeMs, channel: null, inputAckLagMs: null, correctionPx: null, desyncs: null }
    return { ...p, grade: gradeOf(p) }
  }
  if (role === 'client') {
    const inMatch = g.screen === 'match'
    const live = inMatch && frame.net.rttMs > 0
    const rtt = live ? frame.net.rttMs : pings?.[localPlayer]
    if (rtt == null) return { role, peers: [], source: 'derived' }
    const age = inMatch && frame.currAt > 0 ? Math.max(0, now - frame.currAt) : null
    return { role, peers: [peer(0, rtt, live ? frame.net.lossPct : null, age)], source: 'derived' }
  }
  const peers: PeerNet[] = []
  for (const s of slots) {
    if (s.kind !== 'human' || s.id === localPlayer) continue
    const ms = pings?.[s.id]
    if (ms != null) peers.push(peer(s.id, ms, null, null))
  }
  return { role, peers, source: 'derived' }
}

function read(now: number): NetSnapshot {
  const role = useGame.getState().lobby.role
  if (override) return fromRaw(override(now), role, 'sim') ?? { role, peers: [], source: 'sim' }
  if (role === 'offline') return { role, peers: [], source: 'derived' }
  const api = (session as unknown as { netStats?: () => RawView }).netStats
  if (typeof api === 'function') {
    try {
      const s = fromRaw(api(), role, 'net')
      if (s) return s
    } catch (e) {
      console.error('[ui] netStats failed', e)
    }
  }
  return derived(now)
}

function record(snap: NetSnapshot): void {
  const live = new Set(snap.peers.map((p) => p.playerId))
  for (const id of [...history.keys()]) if (!live.has(id)) history.delete(id)
  for (const p of snap.peers) {
    let h = history.get(p.playerId)
    if (!h) history.set(p.playerId, (h = { rtt: [], jitter: [], loss: [] }))
    h.rtt.push(p.rttMs ?? 0)
    h.jitter.push(p.jitterMs ?? 0)
    h.loss.push(p.lossPct ?? 0)
    if (h.rtt.length > HISTORY) {
      h.rtt.shift()
      h.jitter.shift()
      h.loss.shift()
    }
  }
}

const nameOf = (id: number) => useGame.getState().lobby.slots.find((s) => s.id === id)?.name ?? `Player ${id + 1}`

function sample(now: number): void {
  const snap = read(now)
  record(snap)
  // warnings only where they matter: in the lobby and in a match
  const screen = useGame.getState().screen
  const toasts = screen === 'match' || screen === 'lobby' ? warn.update(snap, now, nameOf) : warn.update({ ...snap, role: 'offline' }, now, nameOf)
  for (const t of toasts) toast(t, 'warn')
  state = { snap, warnings: warn.active, flagged: new Set(warn.flagged) }
}

/** Start sampling (App mounts this once). Returns the stop function. */
export function startNetMonitor(): () => void {
  let last = -Infinity
  return onTick((now) => {
    if (now - last < SAMPLE_MS) return
    last = now
    sample(now)
  })
}

export function historyOf(playerId: number): PeerHistory | undefined {
  return history.get(playerId)
}

/** Re-renders at most 4 times a second, and only when `key` of the selection changes. */
export function useNet<T>(select: (s: MonitorState) => T, key: (v: T) => string = (v) => JSON.stringify(v)): T {
  return usePolled(() => select(state), key, 4)
}

/** The current snapshot without subscribing (rAF writers). */
export function netState(): MonitorState {
  return state
}

/**
 * Link stats per lobby slot id, for ping bars in lobby and scoreboard.
 * Host: every client's link. Client: only its own link to the host (shown on
 * its own card). Plus the players the host flagged as unstable.
 */
export function useLinks(): { links: Record<number, PeerNet>; flagged: number[] } {
  return useNet(
    (s) => {
      const links: Record<number, PeerNet> = {}
      if (s.snap.role === 'host') for (const p of s.snap.peers) links[p.playerId] = p
      else if (s.snap.role === 'client' && s.snap.peers[0]) links[useGame.getState().lobby.localPlayer] = s.snap.peers[0]
      return { links, flagged: [...s.flagged] }
    },
    (v) => JSON.stringify(v),
  )
}
