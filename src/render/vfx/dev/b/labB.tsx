/**
 * Dev-only VFX lab (not part of the app build): the real sim with unreleased spells granted
 * and scripted casts, for looking at spell VFX in motion.
 *   npx vite --port 5194  ->  http://localhost:5194/src/render/vfx/dev/b/labB.html?grant=meteor&script=1:meteor:t0
 * Params (plus everything in grant.ts): &q=low|medium|high|ultra  &fx=0..1  &slow=0.3  &inspect
 *   &pov=<player>     render from that player's point of view (enemy / ally visibility)
 *   &focus=<x>_<y>    pin the camera there      &zoom=500..1500   camera distance
 *   &style=tripo|cc0|procedural  &staff=gnarled|iron|bone  &castFrom=palm|staff
 */
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../../../index.css'
import { useGame, type Quality } from '../../../../game/store'
import { frame } from '../../../../game/frame'
import { input } from '../../../../game/input'
import { MatchView, preloadWarlock, warlockParams, recenterCamera, renderStats } from '../../../index'
import { devTime } from '../../../stats'
import { cameraZoomParam, devCamera } from '../../../cameraRig'
import { labOptionsFromUrl, startLabDriver } from '../grant'

const params = new URLSearchParams(location.search)
const style = params.get('style')
if (style !== null && style !== 'cc0' && style !== 'tripo' && style !== 'procedural') throw new Error('Unknown character style: ' + style)
if (style) {
  await preloadWarlock(style)
  warlockParams.style = style
}
const staff = params.get('staff')
if (staff !== null) {
  if (staff !== 'gnarled' && staff !== 'iron' && staff !== 'bone') throw new Error('Unknown staff: ' + staff)
  warlockParams.staff = true
  warlockParams.staffVariant = staff
}
const castFrom = params.get('castFrom')
if (castFrom !== null) {
  if (castFrom !== 'staff' && castFrom !== 'palm') throw new Error('Unknown cast origin: ' + castFrom)
  warlockParams.castFrom = castFrom
}
const q = params.get('q') as Quality | null
if (q) useGame.getState().setSettings({ quality: q })
if (params.has('slow')) devTime.scale = Number(params.get('slow')) || 1
if (params.has('fx')) useGame.getState().setSettings({ fxIntensity: Number(params.get('fx')) })
if (params.has('focus')) {
  const [x, y] = (params.get('focus') ?? '0_0').split('_').map(Number)
  devCamera.focus = { x, y }
}
;(window as unknown as Record<string, unknown>).__brawlock = { stats: renderStats, devTime, devCamera, zoom: cameraZoomParam, warlock: warlockParams, frame }

function Perf() {
  const [txt, setTxt] = useState('')
  useEffect(() => {
    const id = setInterval(() => {
      const s = renderStats
      setTxt(`${s.backend} ${s.tier} | ${s.fps.toFixed(0)} fps | cpu ${s.cpuMs.toFixed(2)} ms | gpu ${s.gpuMs.toFixed(2)} ms | ${s.drawCalls} draws | ${(s.triangles / 1000).toFixed(0)}k tris`)
    }, 250)
    return () => clearInterval(id)
  }, [])
  return <div style={{ position: 'absolute', left: 8, top: 8, font: '12px ui-monospace, monospace', color: '#ffd9b0', textShadow: '0 1px 2px #000', pointerEvents: 'none' }} id="perf">{txt}</div>
}

function Lab() {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    const stop = startLabDriver(labOptionsFromUrl(params))
    if (params.has('pov')) frame.localPlayer = Number(params.get('pov'))
    if (params.has('zoom')) {
      const z = Number(params.get('zoom'))
      setTimeout(() => (cameraZoomParam.distance = z), 50)
    }
    return stop
  }, [])
  useEffect(() => {
    if (!host) return
    return input.attach(host, { recenter: recenterCamera })
  }, [host])
  return (
    <div ref={setHost} style={{ position: 'fixed', inset: 0 }} onContextMenu={(e) => e.preventDefault()}>
      <MatchView />
      <Perf />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Lab />
  </StrictMode>,
)
