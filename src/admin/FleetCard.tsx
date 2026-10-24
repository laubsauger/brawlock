import type { FleetSample, FleetView } from '../shared/monitoring'

const fmt = (v: number | null | undefined, unit = '', digits = 0) => v == null ? '—' : `${v.toFixed(digits)}${unit}`

/** Operational thresholds, not capacity promises. Unknown and stale samples never look healthy. */
export function MetricBar({ label, value, unit, warning, critical, ceiling, fresh, note }: {
  label: string; value: number | null | undefined; unit: string; warning: number; critical: number; ceiling: number; fresh: boolean; note?: string
}) {
  const measured = value != null && Number.isFinite(value)
  const state = !fresh || !measured ? 'unknown' : value >= critical ? 'critical' : value >= warning ? 'elevated' : 'normal'
  return <div className={`metric-bar ${state}`} title={`${label}: ${state}${note ? `. ${note}` : ''}`}>
    <div><span>{label}</span><b>{fmt(value, unit)}</b></div>
    <div className="meter-track" aria-hidden><i style={{ width: measured ? `${Math.max(0, Math.min(100, value / ceiling * 100))}%` : '0%' }} /></div>
    <small>{state === 'unknown' ? !fresh ? 'Stale / unavailable' : 'No measurement' : state === 'critical' ? 'High' : state === 'elevated' ? 'Elevated' : 'Normal'}</small>
  </div>
}

function Version({ sample }: { sample: FleetSample }) {
  return <span title={`Netcode ${sample.release.net ?? 'not applicable'} · released ${sample.release.releaseDate}`}>{sample.release.version} <code>{sample.release.commit?.slice(0, 8) ?? 'development'}</code></span>
}

export function FleetCard({ id, label, view }: { id: string; label: string; view: FleetView }) {
  const current = view.latest[id], sample = current?.sample
  const stale = !current || Date.now() - current.at > 30_000
  const fresh = !!current?.ok && !stale
  const host = sample?.host
  const memory = host && host.totalMb > 0 && host.availableMb !== null ? (host.totalMb - host.availableMb) / host.totalMb * 100 : null
  const metrics = [
    { label: 'Host CPU peak', value: sample?.hostCpuPeakPct, unit: '%', warning: 70, critical: 90, ceiling: 100, note: 'All host cores combined' },
    { label: 'Process CPU peak', value: sample?.processCpuPeakPct, unit: '%', warning: 70, critical: 90, ceiling: 100, note: 'One full core = 100%; can exceed 100%' },
    { label: 'Host RAM used', value: memory, unit: '%', warning: 80, critical: 90, ceiling: 100 },
    { label: 'Event loop max', value: sample?.loopPeakMs, unit: ' ms', warning: 50, critical: 100, ceiling: 150, note: 'Includes the sampler’s approximately 20 ms baseline' },
    ...(id === 'accounts' ? [] : [
      { label: 'Player RTT p95', value: sample?.links?.rttP95Ms, unit: ' ms', warning: 120, critical: 250, ceiling: 300, note: 'Includes the player’s connection; high RTT alone does not identify a server fault' },
      { label: 'Worst packet loss', value: sample?.links?.lossMaxPct, unit: '%', warning: 1, critical: 5, ceiling: 10 },
    ]),
  ]
  const high = fresh && metrics.some(m => m.value != null && m.value >= m.critical)
  const elevated = fresh && metrics.some(m => m.value != null && m.value >= m.warning)
  const state = !fresh ? 'bad' : sample?.maintenance?.draining || high || elevated ? 'warning' : 'good'
  return <section className="card fleet-card">
    <header><h2>{label}</h2><span className={`status ${state}`}>{!current ? 'Awaiting sample' : stale ? 'Stale' : !current.ok ? 'Unavailable' : sample?.maintenance?.draining ? 'Maintenance' : high ? 'High readings' : elevated ? 'Elevated' : 'Live'}</span></header>
    {!fresh && <p className="error">{current?.error ?? 'No fresh measurements. Check the service and collector.'}</p>}
    {sample && <>
      <div className="fleet-counts"><span><b>{fmt(id === 'accounts' ? sample.online?.total : sample.players)}</b> {id === 'accounts' ? 'in app' : 'human seats'}</span>{sample.rooms && <span><b>{sample.rooms.length}</b> rooms · <b>{sample.rooms.reduce((n, room) => n + room.bots, 0)}</b> bots</span>}</div>
      <div className="metric-bars">{metrics.map(metric => <MetricBar key={metric.label} {...metric} fresh={fresh} />)}</div>
      <details className="instance-details"><summary>Instance details <span>{sample.release.version}</span></summary><div className="details">
        <span><Version sample={sample} /> · sampled {Math.max(0, Math.round((Date.now() - current.at) / 1000))}s ago</span>
        <span>{host ? `${host.cpus} vCPU · ${fmt(host.availableMb)} / ${fmt(host.totalMb, ' MiB')} available` : 'Host counters unavailable'}</span>
        <span>Steal {fmt(host?.stealPct, '%', 1)} · load {fmt(host?.load1, '', 2)}</span>
        {id !== 'accounts' && <span>Internet anchor {fmt(sample.anchorMs, ' ms', 1)} · poll from US {fmt(current.pollMs, ' ms')}</span>}
        <span>Process RSS {fmt(sample.perf?.rssMb, ' MiB')} · {fmt(sample.connections)} connections</span>
        {sample.rooms && <><span>Simulation {fmt(sample.perf?.simStepsPerSec, ' steps/s', 1)} · step max {fmt(sample.stepPeakMs, ' ms', 2)}</span><span>RTT max {fmt(sample.links?.rttMaxMs, ' ms')} · jitter {fmt(sample.links?.jitterMaxMs, ' ms')} · loss {fmt(sample.links?.lossMaxPct, '%', 1)}</span><span>Prediction correction max {fmt(sample.links?.correctionMaxPx, ' units', 1)} · critical links {fmt(sample.links?.critical)}</span></>}
        <span>Uptime {fmt(sample.uptimeSec / 3600, ' h', 1)}</span>
      </div></details>
    </>}
  </section>
}
