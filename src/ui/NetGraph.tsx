import { useRef } from 'react'
import { useGame } from '../game/store'
import { useTick } from './lib/ticker'
import { HISTORY, SAMPLE_MS, historyOf, useNet } from './lib/netmonitor'
import { GRADE_COLOR, GRADE_LABEL, type PeerNet } from './lib/netstats'
import { SignalBars } from './hud/ConnIndicator'
import { ConnectionDiagnostics } from './ConnectionDiagnostics'

/**
 * Net graph (Settings > Interface or F3), in the spirit of Dota's net_graph:
 * 30 s sparklines of ping, jitter and loss per link, plus last update age,
 * channel, input ack lag, correction and desyncs. Host: one row per client.
 * Client: the link to the host. Canvases redraw at the 4 Hz sample rate.
 */
export function NetGraph() {
  const on = useGame((s) => s.settings.netGraph)
  if (!on) return null
  return <NetGraphPanel />
}

const SPARK_W = 104
const SPARK_H = 22

function NetGraphPanel() {
  const slots = useGame((s) => s.lobby.slots)
  // bottom left, above the hint row; while the shop is open it moves past the left dock
  const besideDock = useGame((s) => s.screen === 'match' && s.shopOpen)
  const v = useNet(
    (s) => ({ role: s.snap.role, source: s.snap.source, peers: s.snap.peers, flagged: [...s.flagged] }),
    (x) => JSON.stringify(x),
  )
  const name = (id: number) => slots.find((s) => s.id === id)?.name ?? `Player ${id + 1}`
  return (
    <div
      id="net-graph-panel"
      className="tabular pointer-events-none fixed bottom-11 z-[60] max-h-[calc(100vh-140px)] w-[340px] overflow-hidden rounded bg-black/80 px-3 py-2 text-[12px] font-semibold text-[#e9dccb] ring-1 ring-white/10"
      style={{ left: besideDock ? 'calc(var(--dock-left-w, 330px) * var(--ui-scale, 1) + 24px)' : 12 }}
      role="region"
      aria-label="Net graph"
    >
      <div className="mb-1 flex items-baseline justify-between text-[11px] tracking-wide text-ash uppercase">
        <span>Net graph{v.role === 'host' ? ', host' : v.role === 'client' ? ', client' : ''}</span>
        <span className="normal-case">{v.source === 'derived' ? 'estimated' : v.source === 'sim' ? 'simulated' : 'measured'} · F3</span>
      </div>
      {v.role === 'offline' && <p className="text-ash">Offline: no connection to measure.</p>}
      {v.role !== 'offline' && v.peers.length === 0 && <p className="text-ash">{v.role === 'host' ? 'No clients connected.' : 'Waiting for the first measurement.'}</p>}
      {v.peers.map((p) => (
        <PeerRow key={p.playerId} peer={p} label={v.role === 'client' ? 'Host link' : name(p.playerId)} flagged={v.flagged.includes(p.playerId)} compact={v.peers.length > 2} />
      ))}
      <ConnectionDiagnostics />
    </div>
  )
}

function fmtMs(n: number | null): string {
  return n === null ? '–' : `${Math.round(n)} ms`
}

function PeerRow({ peer: p, label, flagged, compact }: { peer: PeerNet; label: string; flagged: boolean; compact: boolean }) {
  // three or more clients: one line each, ping sparkline only
  if (compact)
    return (
      <div className="flex items-center gap-2 border-t border-white/10 py-1 first:border-t-0">
        <SignalBars grade={p.grade} scale={0.7} />
        <span className="w-20 truncate text-bone" style={flagged ? { color: '#ffb08a' } : undefined}>
          {label}
        </span>
        <Spark id={p.playerId} series="rtt" value={fmtMs(p.rttMs)} color={GRADE_COLOR[p.grade]} floor={150} width={84} />
        <span className="w-12 text-right text-bone/75">{p.jitterMs === null ? '–' : `±${Math.round(p.jitterMs)}`}</span>
        <span className="w-10 text-right text-bone/75">{p.lossPct === null ? '–' : `${Math.round(p.lossPct)}%`}</span>
      </div>
    )
  return (
    <div className="border-t border-white/10 py-1.5 first:border-t-0">
      <div className="mb-1 flex items-center gap-2">
        <SignalBars grade={p.grade} scale={0.8} />
        <span className="truncate text-[13px] text-bone">{label}</span>
        {flagged && <span className="text-[#ffb08a]">unstable</span>}
        <span className="ml-auto" style={{ color: GRADE_COLOR[p.grade] }}>
          {GRADE_LABEL[p.grade]}
        </span>
      </div>
      <Spark id={p.playerId} series="rtt" label="RTT" value={fmtMs(p.rttMs)} color="#ffc548" floor={150} />
      <Spark id={p.playerId} series="jitter" label="jitter" value={p.jitterMs === null ? '–' : `±${Math.round(p.jitterMs)} ms`} color="#8fd0ff" floor={40} />
      <Spark id={p.playerId} series="loss" label="loss" value={p.lossPct === null ? '–' : `${p.lossPct.toFixed(1)}%`} color="#ff7a5c" floor={10} />
      <div className="mt-0.5 grid grid-cols-2 gap-x-3 text-[11.5px] text-bone/75">
        <span>update age {fmtMs(p.snapshotAgeMs)}</span>
        <span>channel {p.channel ?? '–'}</span>
        <span>input ack {fmtMs(p.inputAckLagMs)}</span>
        <span>correction {p.correctionPx === null ? '–' : p.correctionPx.toFixed(1)}</span>
        <span>desyncs {p.desyncs ?? '–'}</span>
      </div>
    </div>
  )
}

/** One 30 s sparkline. The y range starts at `floor` and grows with the data, so calm links look flat and low. */
function Spark({ id, series, label, value, color, floor, width = SPARK_W }: { id: number; series: 'rtt' | 'jitter' | 'loss'; label?: string; value: string; color: string; floor: number; width?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const last = useRef(0)
  useTick((now) => {
    if (now - last.current < SAMPLE_MS) return
    last.current = now
    const c = ref.current
    const data = historyOf(id)?.[series]
    if (!c || !data) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    if (c.width !== width * dpr) {
      c.width = width * dpr
      c.height = SPARK_H * dpr
    }
    const g = c.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, width, SPARK_H)
    g.fillStyle = 'rgba(255,255,255,.05)'
    g.fillRect(0, 0, width, SPARK_H)
    if (data.length < 2) return
    const max = Math.max(floor, ...data) * 1.1
    const step = width / (HISTORY - 1)
    const x0 = width - (data.length - 1) * step
    g.beginPath()
    data.forEach((d, i) => {
      const x = x0 + i * step
      const y = SPARK_H - 1 - (d / max) * (SPARK_H - 2)
      if (i === 0) g.moveTo(x, y)
      else g.lineTo(x, y)
    })
    g.strokeStyle = color
    g.lineWidth = 1.25
    g.stroke()
    g.lineTo(width, SPARK_H)
    g.lineTo(x0, SPARK_H)
    g.closePath()
    g.globalAlpha = 0.18
    g.fillStyle = color
    g.fill()
    g.globalAlpha = 1
  })
  return (
    <div className={`flex items-center gap-2 ${label ? '' : 'flex-1'}`}>
      {label && <span className="w-10 text-[11px] text-ash">{label}</span>}
      <canvas ref={ref} style={{ width, height: SPARK_H }} aria-hidden />
      <span className="ml-auto">{value}</span>
    </div>
  )
}
