import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import * as THREE from 'three/webgpu'

let updateErrorLogged = false
import { useGame } from '../game/store'
import { DT, type Vec2 } from '../sim/types'
import { S, TILE_TOP_H } from './coords'
import { GpuCanvas, useEffectiveQuality } from './GpuCanvas'
import { createMenuStage, createMenuTableau, type MenuStage } from './menuStage'
import { menuCameraAt } from './menuCamera'
import { useMedia } from '../ui/lib/media'
import { tierConfig } from './quality'
import { RenderLoop } from './RenderLoop'
import { MatchWorld } from './scene/MatchWorld'
import { createPrivateSource } from './source'

/**
 * Animated backdrop for menu and lobby screens: a slow cinematic drift over a
 * ten-warlock coven, looking out across the lava to the caldera rim.
 * The prior sparring scene remains available with ?menuScene=sparring.
 * Both use a private frame buffer and never touch match state.
 *
 * The menu panels sit on the left: the camera aims left of the action so the
 * warlocks land beside them on desktop and above them in portrait.
 */
export function MenuBackdrop({ className, style }: { className?: string; style?: CSSProperties }) {
  const quality = useGame((s) => s.settings.quality)
  const fx = useGame((s) => s.settings.fxIntensity)
  return (
    <div className={className} style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#0b0604', ...style }}>
      <GpuCanvas quality={quality} style={{ position: 'absolute', inset: 0 }}>
        <MenuScene quality={quality} fx={fx} />
        <RenderLoop quality={quality} fx={fx} inspect={false} />
      </GpuCanvas>
    </div>
  )
}

function MenuScene({ quality, fx }: { quality: Parameters<typeof tierConfig>[0]; fx: number }) {
  const reducedMotion = useMedia('(prefers-reduced-motion: reduce)')
  const [sparring] = useState(() => new URLSearchParams(window.location.search).get('menuScene') === 'sparring')
  const scene = useThree((s) => s.scene)
  const gl = useThree((s) => s.gl)
  const eff = useEffectiveQuality(quality)
  const worldRef = useRef<MatchWorld | null>(null)
  const driveRef = useRef<{ stage: MenuStage; source: ReturnType<typeof createPrivateSource>; acc: number; t0: number; ticks: number; t: number } | null>(null)
  const tmp = useRef({
    pos: new THREE.Vector3(), aim: new THREE.Vector3(),
    shot: { x: 0, y: 0, height: 0, aimX: 0, aimY: 0, aimHeight: 0, fov: 35 },
  })

  useEffect(() => {
    const source = createPrivateSource()
    const stage = sparring ? createMenuStage() : createMenuTableau()
    // two ticks up front so the first rendered frame already has prev + curr
    const t0 = performance.now()
    for (let i = 1; i <= 2; i++) {
      const { state, events } = stage.step()
      source.pushEvents(state.tick, events)
      source.push(state, t0 + i * DT * 1000)
    }
    driveRef.current = { stage, source, acc: 0, t0, ticks: 2, t: 0 }
    const tierCfg = tierConfig(eff)
    const r = gl as unknown as THREE.WebGPURenderer
    r.shadowMap.enabled = tierCfg.shadowMap > 0
    r.shadowMap.type = THREE.PCFShadowMap
    const world = new MatchWorld({ source, tier: tierConfig(eff), fx, overlayParent: null, mode: 'menu', externalCamera: true, renderer: r })
    scene.add(world.root)
    scene.background = new THREE.Color(0x0b0604)
    scene.fogNode = world.fogNode
    worldRef.current = world
    return () => {
      scene.remove(world.root)
      scene.fogNode = null
      world.dispose()
      worldRef.current = null
      driveRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, eff, gl, sparring])

  useEffect(() => {
    worldRef.current?.setFx(fx)
  }, [fx])

  useFrame((state, dtRaw) => {
    const world = worldRef.current
    const drive = driveRef.current
    if (!world || !drive) return
    const dt = Math.min(dtRaw, 0.1)
    drive.t += dt
    // stage on a virtual 60 Hz timeline that trails real time by < 1 tick, so
    // the world interpolates smoothly at any display rate (and pauses with the tab)
    drive.acc += dt
    let n = 0
    while (drive.acc >= DT && n++ < 6) {
      drive.acc -= DT
      const { state: st, events } = drive.stage.step()
      drive.ticks++
      drive.source.pushEvents(st.tick, events)
      drive.source.push(st, performance.now() - drive.acc * 1000)
    }
    if (drive.acc > DT) drive.acc = 0
    const cam = state.camera as THREE.PerspectiveCamera
    const { focus: f, out: u } = drive.stage
    const aspect = state.size.width / Math.max(1, state.size.height)
    const { pos, aim, shot } = tmp.current
    if (sparring) {
      Object.assign(shot, menuCameraAt(drive.t, f, u, aspect, reducedMotion))
      shot.aimHeight = 0
    } else tableauCameraAt(drive.t, f, u, aspect, reducedMotion, shot)
    pos.set(shot.x * S, (TILE_TOP_H + shot.height) * S, -shot.y * S)
    aim.set(shot.aimX * S, (TILE_TOP_H + shot.aimHeight) * S, -shot.aimY * S)
    cam.position.copy(pos)
    cam.lookAt(aim)
    if (cam.fov !== shot.fov) {
      cam.fov = shot.fov
      cam.updateProjectionMatrix()
    }
    // Culling, shadows and VFX use the same camera that will render this frame.
    try {
      world.update(dt, cam, aspect)
    } catch (err) {
      if (!updateErrorLogged) console.error('[render] menu world update threw', err)
      updateErrorLogged = true
    }
  })
  return null
}

type TableauShot = ReturnType<typeof menuCameraAt> & { aimHeight: number }

/** One slow, shallow portrait shot. Narrow phones pull back rather than cropping
 * the witnesses; the group sits above the central menu in portrait and beside
 * the menu on desktop. Reuses the caller's shot object every frame. */
function tableauCameraAt(seconds: number, focus: Vec2, out: Vec2, aspect: number, reducedMotion: boolean, shot: TableauShot): void {
  const t = reducedMotion ? 0 : seconds
  const arc = Math.sin(t * Math.PI * 2 / 96) * 0.035
  const ca = Math.cos(arc)
  const sa = Math.sin(arc)
  const ux = out.x * ca - out.y * sa
  const uy = out.x * sa + out.y * ca
  const portrait = aspect < 1
  const fit = Math.max(1, 0.95 / aspect)
  const breath = (1 - Math.cos(t * Math.PI * 2 / 96)) * 15
  const back = (2200 - breath) * fit
  const height = (1080 - breath * 0.35) * fit
  const screenX = portrait ? 0.52 : 0.70
  const reach = Math.hypot(back, height)
  const shift = reach * (2 * screenX - 1) * Math.tan(35 * Math.PI / 360) * aspect
  shot.x = focus.x - ux * back
  shot.y = focus.y - uy * back
  shot.height = height
  shot.aimX = focus.x - uy * shift
  shot.aimY = focus.y + ux * shift
  shot.aimHeight = portrait ? -560 : 70
  shot.fov = 35
}
