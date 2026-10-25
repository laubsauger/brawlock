/**
 * Dev-only render preview (not part of the app build).
 *   npx vite --port 5191  ->  http://localhost:5191/src/render/dev/preview.html
 * Params: ?view=match|menu  &q=low|medium|high|ultra  &fx=0..1  &inspect
 *         &mock (fake sim instead of the real one)  &mode=ffa|teams|shuffle  &bots=1..9  &bot=easy|medium|hard  &slow=0.25
 *         &wear=head-ram+shoulders-spiked+robe-tattered,head-party,...  (cosmetics per player, comma separated)
 */
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../index.css'
import { installErrorCapture } from '../errorCapture'

installErrorCapture()
import { useGame, type Quality } from '../../game/store'
import { input } from '../../game/input'
import { MatchView, MenuBackdrop, preloadWarlock, recenterCamera, renderStats, warlockParams } from '../index'
import { devTime, perfProbe } from '../stats'
import { cullFlags } from '../frameCull'
import { startSimDriver } from './simDriver'
import { tweakParams } from '../tweaks'
import { cameraParams, cameraZoomParam, devCamera } from '../cameraRig'
import { COSMETICS, EMPTY_EQUIPMENT, type CosmeticEquipment } from '../../game/progressionCatalog'

// dev handles for look-dev from the console
;(window as unknown as Record<string, unknown>).__brawlock = { tweaks: tweakParams, camera: cameraParams, zoom: cameraZoomParam, devCamera, stats: renderStats, devTime, perfProbe, input, store: useGame, warlock: warlockParams, cull: cullFlags }

const params = new URLSearchParams(location.search)
const q = params.get('q') as Quality | null
if (q) useGame.getState().setSettings({ quality: q })
const style = params.get('style')
if (style === 'procedural' || style === 'cc0' || style === 'tripo') {
  await preloadWarlock(style)
  warlockParams.style = style
}
const staff = params.get('staff')
if (staff === 'gnarled' || staff === 'iron' || staff === 'bone') {
  warlockParams.staff = true
  warlockParams.staffVariant = staff
}
if (params.get('castFrom') === 'palm') warlockParams.castFrom = 'palm'
if (params.has('slow')) devTime.scale = Number(params.get('slow')) || 1
if (params.has('fx')) useGame.getState().setSettings({ fxIntensity: Number(params.get('fx')) })

/** ?wear: one '+'-joined list of cosmetic ids per player, comma separated */
function wear(): CosmeticEquipment[] | undefined {
  const raw = params.get('wear')
  if (!raw) return undefined
  return raw.split(',').map((list) => {
    const eq: CosmeticEquipment = { ...EMPTY_EQUIPMENT }
    for (const id of list.split('+')) {
      const item = COSMETICS.find((c) => c.id === id)
      if (item) (eq as unknown as Record<string, string>)[item.slot] = item.id
    }
    return eq
  })
}

function Perf() {
  const [txt, setTxt] = useState('')
  useEffect(() => {
    const id = setInterval(() => {
      const s = renderStats
      setTxt(`${s.backend} ${s.tier} dpr ${s.dpr.toFixed(2)} | ${s.fps.toFixed(0)} fps | cpu ${s.cpuMs.toFixed(2)} ms | gpu ${s.gpuMs >= 0 ? s.gpuMs.toFixed(2) + ' ms' : 'n/a'} | ${s.drawCalls} draws | ${(s.triangles / 1000).toFixed(0)}k tris`)
    }, 250)
    return () => clearInterval(id)
  }, [])
  return <div style={{ position: 'absolute', left: 8, top: 8, font: '12px ui-monospace, monospace', color: '#ffd9b0', textShadow: '0 1px 2px #000', pointerEvents: 'none' }} id="perf">{txt}</div>
}

function Preview() {
  const view = params.get('view') ?? 'match'
  const mock = params.has('mock')
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  // ?prewarm: mount hidden, start the sim only on window.__brawlockStart()
  const [warm, setWarm] = useState(params.has('prewarm'))
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>
    w.__brawlockStart = () => setWarm(false)
  }, [])
  // real sim + bots + local input (default), unless ?mock
  useEffect(() => {
    if (view !== 'match' || mock || warm) return
    const start = () =>
      startSimDriver({
        bots: Number(params.get('bots') ?? 1),
        difficulty: (params.get('bot') as 'easy' | 'medium' | 'hard' | null) ?? 'medium',
        teamMode: (params.get('mode') as 'ffa' | 'teams' | 'shuffle' | null) ?? 'ffa',
        // ?game=hill|deathmatch: another game mode (default rounds)
        gameMode: (params.get('game') as 'hill' | 'deathmatch' | null) ?? undefined,
        cosmetics: wear(),
      })
    let stop = start()
    // dev: start a second match in the same view (match reset path)
    ;(window as unknown as Record<string, unknown>).__brawlockRestart = () => {
      stop()
      stop = start()
    }
    return () => stop()
  }, [view, mock, warm])
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
      {view === 'menu' ? (
        <MenuBackdrop />
      ) : (
        <MatchView
          mock={mock}
          prewarm={warm}
          onReady={() => ((window as unknown as Record<string, unknown>).__brawlockReady = performance.now())}
        />
      )}
      <Perf />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
)
