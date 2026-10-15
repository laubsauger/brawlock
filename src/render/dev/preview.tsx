/**
 * Dev-only render preview (not part of the app build).
 *   npx vite --port 5191  ->  http://localhost:5191/src/render/dev/preview.html
 * Params: ?view=match|menu  &q=low|medium|high|ultra  &fx=0..1  &inspect
 *         &mock (fake sim instead of the real one)  &bots=1..3  &bot=easy|medium|hard  &slow=0.25
 */
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../index.css'
import { useGame, type Quality } from '../../game/store'
import { input } from '../../game/input'
import { MatchView, MenuBackdrop, recenterCamera, renderStats } from '../index'
import { devTime } from '../stats'
import { startSimDriver } from './simDriver'
import { tweakParams } from '../tweaks'
import { cameraParams, cameraZoomParam, devCamera } from '../cameraRig'

// dev handles for look-dev from the console
;(window as unknown as Record<string, unknown>).__brawlock = { tweaks: tweakParams, camera: cameraParams, zoom: cameraZoomParam, devCamera, stats: renderStats, devTime }

const params = new URLSearchParams(location.search)
const q = params.get('q') as Quality | null
if (q) useGame.getState().setSettings({ quality: q })
if (params.has('slow')) devTime.scale = Number(params.get('slow')) || 1
if (params.has('fx')) useGame.getState().setSettings({ fxIntensity: Number(params.get('fx')) })

function Perf() {
  const [txt, setTxt] = useState('')
  useEffect(() => {
    const id = setInterval(() => {
      const s = renderStats
      setTxt(`${s.backend} ${s.tier} dpr ${s.dpr.toFixed(2)} | ${s.fps.toFixed(0)} fps | cpu ${s.cpuMs.toFixed(2)} ms | gpu ${s.gpuMs.toFixed(2)} ms | ${s.drawCalls} draws | ${(s.triangles / 1000).toFixed(0)}k tris`)
    }, 250)
    return () => clearInterval(id)
  }, [])
  return <div style={{ position: 'absolute', left: 8, top: 8, font: '12px ui-monospace, monospace', color: '#ffd9b0', textShadow: '0 1px 2px #000', pointerEvents: 'none' }} id="perf">{txt}</div>
}

function Preview() {
  const view = params.get('view') ?? 'match'
  const mock = params.has('mock')
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  // real sim + bots + local input (default), unless ?mock
  useEffect(() => {
    if (view !== 'match' || mock) return
    return startSimDriver({
      bots: Number(params.get('bots') ?? 1),
      difficulty: (params.get('bot') as 'easy' | 'medium' | 'hard' | null) ?? 'medium',
    })
  }, [view, mock])
  useEffect(() => {
    if (!host || view !== 'match' || mock) return
    return input.attach(host, { recenter: recenterCamera })
  }, [host, view, mock])
  useEffect(() => {
    if (view !== 'match' || !mock) return
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space') recenterCamera()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, mock])
  return (
    <div ref={setHost} style={{ position: 'fixed', inset: 0 }} onContextMenu={(e) => e.preventDefault()}>
      {view === 'menu' ? <MenuBackdrop /> : <MatchView mock={mock} />}
      <Perf />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
)
