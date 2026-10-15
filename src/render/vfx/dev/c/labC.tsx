/**
 * Dev-only death / after-hit VFX lab (workstream C). Not part of the app build.
 *   npx vite --port 5196 -> http://localhost:5196/src/render/vfx/dev/c/labC.html?cause=fireball
 * Params: &cause=<fireball|lava|scourge|obstacle|disconnect|<spell id>|all>  &every=3.5 (s per cycle)
 *         &hit (after-hit mode: damage instead of kill)  &q=low|medium|high|ultra  &fx=0..1
 *         &slow=0.3  &zoom=500..1500  &vc=<victim colour hex, e.g. ff6fb5>
 * Console: __labC.since() = sim seconds since the victim's last death (screenshot timing),
 *          __labC.devTime.scale = 0 freezes everything (render clock too).
 */
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../../../index.css'
import { useGame, type Quality } from '../../../../game/store'
import { MatchView, renderStats } from '../../../index'
import { cameraZoomParam } from '../../../cameraRig'
import { devTime } from '../../../stats'
import { ALL_CAUSES, labState, startDeathLab } from './deathLab'

const params = new URLSearchParams(location.search)
const q = params.get('q') as Quality | null
if (q) useGame.getState().setSettings({ quality: q })
if (params.has('slow')) devTime.scale = Number(params.get('slow')) || 1
if (params.has('fx')) useGame.getState().setSettings({ fxIntensity: Number(params.get('fx')) })
;(window as unknown as Record<string, unknown>).__labC = {
  devTime,
  stats: renderStats,
  zoom: cameraZoomParam,
  state: labState,
  since: () => (labState.deathTick < 0 ? -1 : (labState.tick - labState.deathTick) / 60),
  sinceHit: () => (labState.hitTick < 0 ? -1 : (labState.tick - labState.hitTick) / 60),
}

function Lab() {
  const [label, setLabel] = useState('')
  const [perf, setPerf] = useState('')
  useEffect(() => {
    const c = params.get('cause') ?? 'all'
    const causes = c === 'all' ? [...ALL_CAUSES] : c.split(',')
    const vc = params.get('vc')
    const stop = startDeathLab({ causes, every: Number(params.get('every') ?? 3.5), hit: params.has('hit'), victimColor: vc ? parseInt(vc, 16) : undefined }, setLabel)
    const t = params.has('zoom') ? setTimeout(() => (cameraZoomParam.distance = Number(params.get('zoom'))), 50) : 0
    const id = setInterval(() => {
      const s = renderStats
      setPerf(`${s.backend} ${s.tier} | ${s.fps.toFixed(0)} fps | cpu ${s.cpuMs.toFixed(2)} ms | gpu ${s.gpuMs.toFixed(2)} ms | ${s.drawCalls} draws`)
    }, 250)
    return () => {
      stop()
      clearInterval(id)
      if (t) clearTimeout(t)
    }
  }, [])
  return (
    <div style={{ position: 'fixed', inset: 0 }} onContextMenu={(e) => e.preventDefault()}>
      <MatchView />
      <div style={{ position: 'absolute', left: 8, top: 8, font: '12px ui-monospace, monospace', color: '#ffd9b0', textShadow: '0 1px 2px #000', pointerEvents: 'none' }}>
        <div id="perf">{perf}</div>
        <div id="label" style={{ fontSize: 15, marginTop: 4 }}>{label}</div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Lab />
  </StrictMode>,
)
