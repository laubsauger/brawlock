import type { NetStatsView } from './netstats'

/** Aggregates only: monitoring never exports player identities or private purchases. */
export function summarizeLinks(views: (NetStatsView | null)[]) {
  const peers = views.flatMap((view) => view?.peers ?? [])
  const values = (key: 'rttMs' | 'jitterMs' | 'lossPct' | 'correctionPx' | 'snapshotAgeMs') => peers.flatMap((p) => p[key] === null ? [] : [p[key]!]).sort((a, b) => a - b)
  const max = (v: number[]) => v.length ? v[v.length - 1] : null
  const rtt = values('rttMs')
  return { measured: rtt.length, rttP95Ms: rtt.length ? rtt[Math.ceil(rtt.length * .95) - 1] : null,
    rttMaxMs: max(rtt), jitterMaxMs: max(values('jitterMs')), lossMaxPct: max(values('lossPct')),
    correctionMaxPx: max(values('correctionPx')), snapshotAgeMaxMs: max(values('snapshotAgeMs')),
    critical: peers.filter((p) => p.grade === 'critical').length }
}
