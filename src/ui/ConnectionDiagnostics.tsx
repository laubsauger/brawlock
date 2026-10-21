import { useEffect, useRef, useState } from 'react'
import { online, session } from '../game/session'
import { httpBase } from '../net/online'
import { FrameWindow, watchServerPerf, type LocalFrameSample, type ServerProbe } from './lib/diagnostics'
import { netState } from './lib/netmonitor'
import { usePolled, useTick } from './lib/ticker'
import { renderPerf } from './renderBridge'

const EMPTY: ServerProbe = { state: 'waiting', sample: null, fetchMs: null, receivedAt: null }

/** Local measurements only: no uploads, and sampling stops when F3 is closed. */
export function ConnectionDiagnostics() {
  const region = usePolled(() => session.region(), (r) => r?.url ?? '', 1)
  // every region at once: a spike on all of them is this device's connection, not one server
  const [probes, setProbes] = useState<Record<string, ServerProbe>>({})
  const server = (region && probes[region.id]) || EMPTY
  const [local, setLocal] = useState<(LocalFrameSample & { renderCpuMs: number | null; renderGpuMs: number | null }) | null>(null)
  const [copied, setCopied] = useState('Copy recent samples')
  const frames = useRef(new FrameWindow())
  const latest = useRef(probes)
  latest.current = probes
  const history = useRef<unknown[]>([])

  useEffect(() => {
    frames.current.reset()
    const reset = () => frames.current.reset()
    document.addEventListener('visibilitychange', reset)
    return () => document.removeEventListener('visibilitychange', reset)
  }, [])

  useEffect(() => {
    const stops = online.regions.map((r) => watchServerPerf(httpBase(r.url), (value) => setProbes((all) => ({ ...all, [r.id]: value }))))
    return () => { for (const stop of stops) stop() }
  }, [])

  useEffect(() => { history.current = [] }, [region?.url])

  useTick((now) => {
    if (document.visibilityState !== 'visible') return
    const sample = frames.current.push(now)
    if (!sample) return
    const render = renderPerf()
    setLocal({ ...sample, renderCpuMs: render ? render.cpuMs : null, renderGpuMs: render && render.gpuMs >= 0 ? render.gpuMs : null })
    history.current.push({ at: Date.now(), local: sample,
      render: render ? { cpuMs: render.cpuMs, gpuMs: render.gpuMs, fps: render.fps } : null,
      server: region ? latest.current[region.id] ?? null : null,
      regionsRttMs: Object.fromEntries(online.regions.map((r) => [r.id, latest.current[r.id]?.fetchMs ?? null])),
      links: netState().snap.peers.map((p) => ({ rttMs: p.rttMs, jitterMs: p.jitterMs, lossPct: p.lossPct, snapshotAgeMs: p.snapshotAgeMs, inputAckLagMs: p.inputAckLagMs, correctionPx: p.correctionPx })),
    })
    // At most 30 one-second windows, including frame stalls and tab suspension.
    if (history.current.length > 30) history.current.shift()
  })

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ region: region?.id ?? null, samples: history.current }, null, 2))
      setCopied('Copied')
    } catch { setCopied('Copy failed') }
  }
  const perf = server.sample
  const ms = (n: number) => `${n.toFixed(1)} ms`
  const age = server.receivedAt === null ? null : Math.max(0, Math.round((Date.now() - server.receivedAt) / 1000))
  return <div className="mt-1 border-t border-white/15 pt-1.5 text-[11.5px] text-bone/80" aria-label="Connection diagnostics">
    <div className="flex items-center justify-between"><span className="font-semibold text-bone">This device</span><span>{local ? `${Math.round(local.fps)} fps` : 'Measuring frames…'}</span></div>
    {local && <div className="grid grid-cols-2 gap-x-3"><span>frame avg {ms(local.frameAvgMs)}</span><span>frame max {ms(local.frameMaxMs)}</span><span>render CPU {local.renderCpuMs === null ? '–' : ms(local.renderCpuMs)}</span><span>GPU {local.renderGpuMs === null ? 'unavailable' : ms(local.renderGpuMs)}</span><span className="col-span-2">frames over 50 ms: {local.framesOver50Ms}</span></div>}
    {region && <>
      <div className="mt-1 flex justify-between text-bone"><span>{region.label} server</span>{age !== null && <span className="text-ash">received {age}s ago</span>}</div>
      {perf ? <div className="grid grid-cols-2 gap-x-3">
        <span title="100% means one full CPU core; process threads can use more than one core.">CPU {perf.processCpuPct.toFixed(1)}%</span><span>memory {perf.rssMb.toFixed(0)} MiB</span>
        <span title="Raw event-loop delay, sampled at 20 ms resolution; an idle baseline near 20 ms is normal.">loop p95 {ms(perf.eventLoopP95Ms)}</span><span>loop max {ms(perf.eventLoopMaxMs)}</span>
        <span>sim avg {ms(perf.simStepAvgMs)}</span><span>sim max {ms(perf.simStepMaxMs)}</span>
        <span>sim steps/s {perf.simStepsPerSec.toFixed(0)}</span><span>health RTT {server.fetchMs === null ? '–' : ms(server.fetchMs)}</span>
      </div> : <p className="text-ash">{server.state === 'unavailable' ? 'Server measurements unavailable' : 'Waiting for a server sample…'}</p>}
    </>}
    {online.regions.length > 1 && <div className="mt-1 flex flex-wrap gap-x-3"><span className="text-bone">Health RTT</span>
      {online.regions.map((r) => <span key={r.id}>{r.label} {probes[r.id]?.fetchMs == null ? '–' : ms(probes[r.id].fetchMs!)}</span>)}
    </div>}
    <p className="mt-1 text-[10.5px] leading-snug text-ash">RTT includes processing delays on both devices. Every region spiking together points to this device or its network; one region with a loop max spike points to that server.</p>
    <button type="button" className="pointer-events-auto mt-1 rounded px-1.5 py-0.5 text-[#f3c58c] underline-offset-2 hover:underline focus-visible:outline-1 focus-visible:outline-gold" onClick={() => void copy()}>{copied}</button>
  </div>
}
