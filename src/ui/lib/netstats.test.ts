import { describe, expect, it } from 'vitest'
import { CLEAR_HOLD_MS, GAP_MS, JitterEstimate, NetWarnings, REPEAT_MS, WARN_HOLD_MS, gradeOf, normalizePeer, type NetSnapshot, type PeerNet } from './netstats'

const link = (o: Partial<PeerNet> = {}): PeerNet => {
  const p = { playerId: 0, rttMs: 40, jitterMs: 3, lossPct: 0, snapshotAgeMs: 20, channel: 'raw' as const, inputAckLagMs: null, correctionPx: null, desyncs: null, ...o }
  return { ...p, grade: o.grade ?? gradeOf(p) }
}
const client = (o: Partial<PeerNet> = {}): NetSnapshot => ({ role: 'client', peers: [link(o)], source: 'net' })
const names = (id: number) => ['Host', 'Mira', 'Tor'][id] ?? '?'

/** Feed the same snapshot every 250 ms (the monitor's rate) from `from` for `ms`; returns every toast. */
function run(w: NetWarnings, snap: NetSnapshot, from: number, ms: number): string[] {
  const out: string[] = []
  for (let t = from; t <= from + ms; t += 250) out.push(...w.update(snap, t, names))
  return out
}

describe('grading', () => {
  it('rates a LAN-like link good and a reliable-channel fallback no better than fair', () => {
    expect(link().grade).toBe('good')
    expect(link({ channel: 'reliable' }).grade).toBe('ok')
  })

  it('grades the fallback path with the net layer table, so HUD and netcode agree (bad from 150 ms or 5% loss, critical from 250 ms or a stalled second)', () => {
    expect(link({ rttMs: 185 }).grade).toBe('bad')
    expect(link({ lossPct: 7 }).grade).toBe('bad')
    expect(link({ rttMs: 320 }).grade).toBe('critical')
    expect(link({ snapshotAgeMs: 1200 }).grade).toBe('critical')
  })

  it('trusts the grade the net layer reports over its own thresholds', () => {
    const p = normalizePeer({ playerId: 1, rttMs: 30, grade: 'critical' })
    expect(p?.grade).toBe('critical')
  })

  it('grades a net-layer peer itself when no grade is given, and maps the raw channel names', () => {
    const p = normalizePeer({ playerId: 1, rttMs: 210, lossPct: 1, channel: 'unreliable' })
    expect(p?.grade).toBe('bad')
    expect(p?.channel).toBe('raw')
    expect(p?.jitterMs).toBeNull()
  })

  it('keeps a link whose ping is not measured yet, so a stalled client still shows its grade', () => {
    const p = normalizePeer({ playerId: 2, rttMs: null, snapshotAgeMs: 1400, grade: 'critical' })
    expect(p?.rttMs).toBeNull()
    expect(p?.grade).toBe('critical')
  })

  it('drops a row without a player id', () => {
    expect(normalizePeer({ rttMs: 40 })).toBeNull()
  })

  it('estimates jitter only from new readings, so a value polled twice is not counted as calm', () => {
    const j = new JitterEstimate()
    for (const v of [50, 90, 50, 90]) j.push(v)
    const shaky = j.value
    j.push(90)
    j.push(90)
    expect(j.value).toBe(shaky)
    expect(shaky).toBeGreaterThan(10)
  })
})

describe('own link warnings', () => {
  it('stays quiet for one slow packet', () => {
    const w = new NetWarnings()
    run(w, client(), 0, 1000)
    expect(run(w, client({ rttMs: 260 }), 1250, 500)).toEqual([])
    expect(w.active).toEqual([])
  })

  it('warns once a high ping holds for a second, with the number in the text', () => {
    const w = new NetWarnings()
    const toasts = run(w, client({ rttMs: 200 }), 0, WARN_HOLD_MS + 250)
    expect(toasts).toEqual(['High ping 200 ms'])
    expect(w.active.map((a) => a.kind)).toEqual(['ping'])
  })

  it('does not flap: a ping hovering just under the trigger keeps the warning, it clears only after a calm stretch', () => {
    const w = new NetWarnings()
    run(w, client({ rttMs: 200 }), 0, 1500)
    run(w, client({ rttMs: 140 }), 1750, 5000)
    expect(w.active.map((a) => a.kind)).toEqual(['ping'])
    run(w, client({ rttMs: 60 }), 7000, CLEAR_HOLD_MS - 500)
    expect(w.active).not.toEqual([])
    run(w, client({ rttMs: 60 }), 7000 + CLEAR_HOLD_MS - 250, 500)
    expect(w.active).toEqual([])
  })

  it('does not toast the same problem again within the repeat window, but the HUD icon still shows it', () => {
    const w = new NetWarnings()
    expect(run(w, client({ lossPct: 9 }), 0, 1500)).toHaveLength(1)
    run(w, client(), 1750, CLEAR_HOLD_MS + 500)
    expect(w.active).toEqual([])
    // past the global gap, inside the repeat window: icon yes, toast no
    expect(run(w, client({ lossPct: 9 }), GAP_MS + 4000, 1500)).toEqual([])
    expect(w.active.map((a) => a.kind)).toEqual(['loss'])
    run(w, client(), GAP_MS + 5750, CLEAR_HOLD_MS + 500)
    // after the repeat window it is news again
    expect(run(w, client({ lossPct: 9 }), REPEAT_MS + 2000, 1500)).toEqual(['Packet loss 9%'])
  })

  it('never stacks toasts: two problems at once give one toast, the worse one', () => {
    const w = new NetWarnings()
    const toasts = run(w, client({ rttMs: 220, lossPct: 12 }), 0, GAP_MS - 1000)
    expect(toasts).toEqual(['Packet loss 12%'])
    expect(w.active.map((a) => a.kind).sort()).toEqual(['loss', 'ping'])
  })

  it('tells the player when the link fell back to the reliable channel', () => {
    const w = new NetWarnings()
    expect(run(w, client({ channel: 'reliable' }), 0, 1250)[0]).toMatch(/reliable channel/)
  })

  it('flags a new desync right away', () => {
    const w = new NetWarnings()
    run(w, client({ desyncs: 0 }), 0, 500)
    expect(w.update(client({ desyncs: 1 }), 750, names)).toEqual(['Out of sync with the host, resyncing'])
  })

  it('clears everything when the player leaves the online session', () => {
    const w = new NetWarnings()
    run(w, client({ rttMs: 400 }), 0, 1500)
    w.update({ role: 'offline', peers: [], source: 'derived' }, 2000, names)
    expect(w.active).toEqual([])
  })
})

describe('host view of clients', () => {
  const host = (peers: Partial<PeerNet>[]): NetSnapshot => ({ role: 'host', peers: peers.map((p) => link(p)), source: 'net' })

  it('names the client whose link went bad, once it stays bad for a second', () => {
    const w = new NetWarnings()
    const toasts = run(w, host([{ playerId: 1, rttMs: 260 }, { playerId: 2 }]), 0, 1250)
    expect(toasts).toEqual(['Mira: unstable connection'])
    expect([...w.flagged]).toEqual([1])
  })

  it('unflags the client after it recovers, and forgets clients that left', () => {
    const w = new NetWarnings()
    run(w, host([{ playerId: 1, lossPct: 20 }, { playerId: 2, rttMs: 250 }]), 0, 1500)
    expect([...w.flagged].sort()).toEqual([1, 2])
    run(w, host([{ playerId: 1 }, { playerId: 2, rttMs: 250 }]), 1750, CLEAR_HOLD_MS + 250)
    expect([...w.flagged]).toEqual([2])
    w.update(host([{ playerId: 1 }]), 6000, names)
    expect([...w.flagged]).toEqual([])
  })

  it('does not warn the host about its own link (it has none)', () => {
    const w = new NetWarnings()
    run(w, host([{ playerId: 1 }]), 0, 2000)
    expect(w.active).toEqual([])
  })
})
