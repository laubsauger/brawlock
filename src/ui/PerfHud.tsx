import { useRef } from 'react'
import { frame } from '../game/frame'
import { useGame } from '../game/store'
import { useTick } from './lib/ticker'
import { renderPerf } from './renderBridge'

/**
 * Perf overlay (settings toggle or F2): fps over a 500 ms window, average and
 * worst frame time, GPU time and draw calls when render reports them, sim
 * tick and ping. Writes text from the shared rAF; no React renders.
 */
export function PerfHud() {
  const on = useGame((s) => s.settings.showPerf)
  if (!on) return null
  return <PerfReadout />
}

function PerfReadout() {
  const ref = useRef<HTMLDivElement>(null)
  const st = useRef({ last: 0, acc: 0, n: 0, worst: 0 })
  useTick((now) => {
    const s = st.current
    if (s.last) {
      const dt = now - s.last
      s.acc += dt
      s.n++
      if (dt > s.worst) s.worst = dt
    }
    s.last = now
    if (s.acc < 500 || !ref.current) return
    const avg = s.acc / s.n
    const p = renderPerf()
    const parts = [`${Math.round(1000 / avg)} fps`, `${avg.toFixed(1)} ms`, `worst ${s.worst.toFixed(0)} ms`]
    if (p && p.gpuMs >= 0) parts.push(`gpu ${p.gpuMs.toFixed(1)} ms`)
    if (p && p.cpuMs > 0) parts.push(`cpu ${p.cpuMs.toFixed(1)} ms`)
    if (p && p.drawCalls > 0) parts.push(`${p.drawCalls} draws`, `${(p.triangles / 1000).toFixed(0)}k tris`)
    if (p?.backend) parts.push(`${p.backend}${p.tier ? ` ${p.tier}` : ''} @${p.dpr.toFixed(2)}x`)
    if (frame.curr) parts.push(`tick ${frame.curr.tick}`)
    if (frame.net.rttMs > 0) parts.push(`ping ${Math.round(frame.net.rttMs)} ms`, `loss ${frame.net.lossPct.toFixed(1)}%`)
    ref.current.textContent = parts.join('   ')
    s.acc = 0
    s.n = 0
    s.worst = 0
  })
  return (
    <div
      ref={ref}
      className="tabular pointer-events-none fixed top-10 left-3 z-[60] rounded bg-black/80 px-2.5 py-1 text-[12px] font-semibold whitespace-pre text-[#e9dccb] ring-1 ring-white/10"
      aria-hidden
    />
  )
}
