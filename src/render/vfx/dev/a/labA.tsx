/**
 * Dev-only spell VFX lab for workstream A (columns 1-3 + Redirector / Pact). Not part of the app build.
 *   npx vite --port 5192  ->  http://localhost:5192/src/render/vfx/dev/a/labA.html?spell=boomerang
 * Params: &spell=<id>|all|chaos  &n=2..10 (chaos players)  &q=low|medium|high|ultra  &fx=0..1
 *         &slow=0.3  &zoom=<camera distance 500..1500>  &inspect
 *         &pillars (keep the round's random pillars)  &lethal (dummies die on the first hit)
 *         &shots=t1,t2,..  capture: freeze at each tick after script step 0 (resume via __labA.ctl.resume)
 *         &freeze=<step>,<ticks>  pause the world <ticks> after script step <step> (first loop);
 *         resume / re-freeze from the console: __labA.ctl.resume(0.3), __labA.ctl.freezeIn(10)
 */
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../../../index.css'
import { useGame, type Quality } from '../../../../game/store'
import { MatchView, renderStats } from '../../../index'
import { cameraZoomParam } from '../../../cameraRig'
import { devTime } from '../../../stats'
import { labControl, startLabDriver } from './labDriverA'

const params = new URLSearchParams(location.search)
const q = params.get('q') as Quality | null
if (q) useGame.getState().setSettings({ quality: q })
if (params.has('slow')) devTime.scale = Number(params.get('slow')) || 1
if (params.has('fx')) useGame.getState().setSettings({ fxIntensity: Number(params.get('fx')) })
;(window as unknown as Record<string, unknown>).__labA = { devTime, stats: renderStats, zoom: cameraZoomParam, ctl: labControl }

function Hud({ label }: { label: string }) {
  const [txt, setTxt] = useState('')
  useEffect(() => {
    const id = setInterval(() => {
      const s = renderStats
      setTxt(`${s.backend} ${s.tier} | ${s.fps.toFixed(0)} fps | cpu ${s.cpuMs.toFixed(2)} ms | gpu ${s.gpuMs.toFixed(2)} ms | ${s.drawCalls} draws`)
    }, 250)
    return () => clearInterval(id)
  }, [])
  return (
    <div style={{ position: 'absolute', left: 8, top: 8, font: '12px ui-monospace, monospace', color: '#ffd9b0', textShadow: '0 1px 2px #000', pointerEvents: 'none' }}>
      <div id="perf">{txt}</div>
      <div id="label" style={{ fontSize: 15, marginTop: 4 }}>{label}</div>
    </div>
  )
}

function Lab() {
  const [label, setLabel] = useState('')
  useEffect(() => {
    const fz = (params.get('freeze') ?? '').split(',').map(Number)
    const freeze = fz.length === 2 && fz.every((v) => Number.isFinite(v)) ? { step: fz[0], ticks: fz[1] } : null
    const stop = startLabDriver({ spell: params.get('spell') ?? 'all', chaos: Number(params.get('n') ?? 10), freeze, pillars: params.has('pillars'), lethal: params.has('lethal'), shotsAt: (params.get('shots') ?? '').split(',').filter(Boolean).map(Number) }, setLabel)
    const t = params.has('zoom') ? setTimeout(() => (cameraZoomParam.distance = Number(params.get('zoom'))), 50) : 0
    return () => {
      stop()
      if (t) clearTimeout(t)
    }
  }, [])
  return (
    <div style={{ position: 'fixed', inset: 0 }} onContextMenu={(e) => e.preventDefault()}>
      <MatchView />
      <Hud label={label} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Lab />
  </StrictMode>,
)
