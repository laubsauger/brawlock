/**
 * Dev-only props preview (not part of the app build).
 *   npx vite --port 5241  ->  http://localhost:5241/src/render/scene/props/dev/props.html
 *
 * ?mode=sheet (default): every pillar variant of a theme in the real
 *   MatchWorld (lights, floor, lava, post), rows = damage stages, Rockpillar
 *   at the end. &theme=0|1|2 &spin (turntable) &rows=1,0.5,0.15 &zoom=1100
 *   &fx=x,y (camera focus, game units) &q=low|medium|high|ultra &dress (rim dressing)
 *   keys: h = hit all, r = replay the rise, 1..9 = hp 10..90 %, 0 = full hp
 * ?mode=game: real sim + bots in MatchView; the world's pillars are swapped
 *   for props/ PropObstacles via the dev handle (window.__brawlockWorld).
 */
import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three/webgpu'
import '../../../../index.css'
import { frame } from '../../../../game/frame'
import { input } from '../../../../game/input'
import { useGame, type Quality } from '../../../../game/store'
import { DEFAULT_SETTINGS, createMatch } from '../../../../sim'
import { OBSTACLE_RADII } from '../../../../sim/config'
import type { SimState } from '../../../../sim/types'
import { cameraRig, devCamera } from '../../../cameraRig'
import { GpuCanvas, useEffectiveQuality } from '../../../GpuCanvas'
import { MatchView, recenterCamera, renderStats } from '../../../index'
import { tierConfig } from '../../../quality'
import { RenderLoop } from '../../../RenderLoop'
import { createPrivateSource } from '../../../source'
import { startSimDriver } from '../../../dev/simDriver'
import { S, TILE_TOP_H } from '../../../coords'
import { MatchWorld } from '../../MatchWorld'
import { PropObstacles, createObstacleVisual, type ObstacleVisual } from '..'

const params = new URLSearchParams(location.search)
const q = (params.get('q') as Quality | null) ?? 'high'
useGame.getState().setSettings({ quality: q })
const mode = params.get('mode') ?? 'sheet'
const theme = Number(params.get('theme') ?? 0) as 0 | 1 | 2
const rows = (params.get('rows') ?? '1,0.5,0.15').split(',').map(Number)
const spin = params.has('spin')
const zoom = Number(params.get('zoom') ?? 1100)
const focus = (params.get('fx') ?? '0,0').split(',').map(Number)

type Win = Record<string, unknown>

function Perf() {
  const [txt, setTxt] = useState('')
  useEffect(() => {
    const id = setInterval(() => {
      const s = renderStats
      setTxt(`${s.backend} ${s.tier} | ${s.fps.toFixed(0)} fps | cpu ${s.cpuMs.toFixed(2)} ms | gpu ${s.gpuMs >= 0 ? s.gpuMs.toFixed(2) + ' ms' : 'n/a'} | ${s.drawCalls} draws | ${(s.triangles / 1000).toFixed(0)}k tris`)
    }, 250)
    return () => clearInterval(id)
  }, [])
  return <div id="perf" style={{ position: 'absolute', left: 8, top: 8, font: '12px ui-monospace, monospace', color: '#ffd9b0', textShadow: '0 1px 2px #000', pointerEvents: 'none' }}>{txt}</div>
}

// ------------------------------------------------------------------ sheet

function sheetState(): SimState {
  const s = createMatch({ ...DEFAULT_SETTINGS }, [
    { id: 0, name: 'You', color: 0xff5a36, team: 0, kind: 'human' },
    { id: 1, name: 'Ref', color: 0x3fa9ff, team: 1, kind: 'human' },
  ], 7)
  s.obstacles = []
  s.arena.theme = theme
  s.arena.layer = 16
  s.pawns.forEach((p, i) => {
    p.x = -640 + i * 1280
    p.y = -560
    p.facing = Math.PI / 2
  })
  return s
}

function SheetScene() {
  const scene = useThree((s) => s.scene)
  const gl = useThree((s) => s.gl)
  const eff = useEffectiveQuality(q)
  const worldRef = useRef<MatchWorld | null>(null)
  const props = useRef<{ vis: ObstacleVisual; hp: number; t0: number; spin: number }[]>([])
  const src = useRef(createPrivateSource())
  const state = useRef(sheetState())

  useEffect(() => {
    const tier = tierConfig(eff)
    const r = gl as unknown as THREE.WebGPURenderer
    r.shadowMap.enabled = tier.shadowMap > 0
    r.shadowMap.type = THREE.PCFShadowMap
    const world = new MatchWorld({ source: src.current, tier, fx: 1, overlayParent: null, mode: 'match', quality: eff })
    scene.add(world.root)
    scene.background = new THREE.Color(0x0b0604)
    scene.fogNode = world.fogNode
    worldRef.current = world
    const w = world as unknown as { obstacles: { group: THREE.Group } }
    w.obstacles.group.visible = false
    devCamera.focus = { x: focus[0], y: focus[1] }
    cameraRig.dist = cameraRig.targetDist = zoom
    // lineup
    const radii = [...OBSTACLE_RADII[theme], 90]
    const n = radii.length
    const gap = 300
    const list: { vis: ObstacleVisual; hp: number; t0: number; spin: number }[] = []
    rows.forEach((hp, ri) => {
      radii.forEach((rad, i) => {
        const variant = i === n - 1 ? -1 : i
        const vis = createObstacleVisual({ theme, variant, radius: rad, seed: 11 + i * 7 + ri * 101, castShadow: tier.shadowMap > 0, anisotropy: tier.anisotropy })
        const x = (i - (n - 1) / 2) * gap
        const y = 330 - ri * 330
        vis.object3d.position.set(x * S, TILE_TOP_H * S, -y * S)
        vis.setDamage(hp)
        world.root.add(vis.object3d)
        list.push({ vis, hp, t0: -10, spin: 0 })
      })
    })
    props.current = list
    const api = {
      hit: () => list.forEach((p) => p.vis.hitShudder(Math.random() - 0.5, Math.random() - 0.5, 1.2)),
      rise: () => list.forEach((p) => (p.t0 = performance.now() / 1000)),
      hp: (v: number) => list.forEach((p) => p.vis.setDamage(v)),
    }
    ;(window as unknown as Win).__props = api
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'h') api.hit()
      else if (e.key === 'r') api.rise()
      else if (e.key >= '0' && e.key <= '9') api.hp(e.key === '0' ? 1 : Number(e.key) / 10)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      for (const p of list) p.vis.dispose()
      scene.remove(world.root)
      scene.fogNode = null
      world.dispose()
      worldRef.current = null
      devCamera.focus = null
    }
  }, [scene, eff, gl])

  useFrame((st, dt) => {
    const world = worldRef.current
    if (!world) return
    src.current.push(state.current, performance.now())
    world.update(Math.min(dt, 0.1), st.camera as THREE.PerspectiveCamera, st.size.width / Math.max(1, st.size.height))
    const now = performance.now() / 1000
    for (const p of props.current) {
      if (p.t0 > 0) p.vis.riseFromGround((now - p.t0) / 0.55)
      if (spin) p.vis.object3d.rotation.y += dt * 0.35
      p.vis.update(dt)
    }
  })
  return null
}

function Sheet() {
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <GpuCanvas quality={q} style={{ position: 'absolute', inset: 0 }}>
        <SheetScene />
        <RenderLoop quality={q} fx={1} inspect={false} />
      </GpuCanvas>
      <Perf />
    </div>
  )
}

// ------------------------------------------------------------------ game

function useSwapIntoWorld() {
  useEffect(() => {
    let raf = 0
    let props: PropObstacles | null = null
    let world: { root: THREE.Group; ctx: ConstructorParameters<typeof PropObstacles>[0]; obstacles: { group: THREE.Group } } | null = null
    let first = true
    const loop = () => {
      raf = requestAnimationFrame(loop)
      const w = (window as unknown as Win).__brawlockWorld as typeof world
      if (w && w !== world) {
        props?.dispose()
        world = w
        props = new PropObstacles(w.ctx)
        w.root.add(props.group)
        first = true
      }
      if (!world || !props) return
      world.obstacles.group.visible = false
      const curr = frame.curr
      if (!curr) return
      props.setTheme(curr.arena.theme)
      props.update(curr.obstacles, world.ctx.uTime.value, !first)
      first = false
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      props?.dispose()
    }
  }, [])
}

function Game() {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  useEffect(() => startSimDriver({ bots: Number(params.get('bots') ?? 3), difficulty: 'medium' }), [])
  useEffect(() => {
    if (!host) return
    return input.attach(host, { recenter: recenterCamera })
  }, [host])
  useSwapIntoWorld()
  return (
    <div ref={setHost} style={{ position: 'fixed', inset: 0 }} onContextMenu={(e) => e.preventDefault()}>
      <MatchView />
      <Perf />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode>{mode === 'game' ? <Game /> : <Sheet />}</StrictMode>)
