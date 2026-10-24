import { useGame } from '../game/store'
import { useClientPerformance } from './lib/clientPerformance'
import { usePolled } from './lib/ticker'
import { renderPerf } from './renderBridge'

/** F2 / Interface setting. During a match the same readout lives beside RTT. */
export function PerfHud() {
  const on = useGame((s) => s.settings.showPerf)
  const screen = useGame((s) => s.screen)
  if (!on || screen === 'match') return null
  return <div className="tabular pointer-events-none fixed top-10 left-3 z-[60] rounded bg-black/80 px-2.5 py-1 text-[12px] font-semibold text-[#e9dccb] ring-1 ring-white/10"><FpsReadout /></div>
}

export function FpsReadout() {
  const local = useClientPerformance()
  const render = usePolled(() => {
    const p = renderPerf()
    return p ? { fps: p.fps ?? null, cpuMs: p.cpuMs, gpuMs: p.gpuMs, draws: p.drawCalls, triangles: p.triangles } : null
  }, (p) => JSON.stringify(p), 4)
  const fps = render?.fps
  const detail = [local.frames ? `Page ${Math.round(local.frames.fps)} FPS; worst frame ${Math.round(local.frames.frameMaxMs)} ms` : 'Measuring frames',
    `Local scheduling delay ${Math.round(local.mainThreadStallMs)} ms in the last 5 s`,
    render ? `Render CPU ${render.cpuMs.toFixed(1)} ms; GPU ${render.gpuMs >= 0 ? `${render.gpuMs.toFixed(1)} ms` : 'timing not measured'}; ${render.draws} draws; ${Math.round(render.triangles / 1000)}k triangles` : 'Waiting for renderer'].join('\n')
  return <span className="tabular text-bone" title={detail} data-testid="fps-readout">{fps !== null && fps !== undefined && fps > 0 ? Math.round(fps) : '–'} FPS</span>
}
