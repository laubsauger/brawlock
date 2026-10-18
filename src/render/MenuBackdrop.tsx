import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef, type CSSProperties } from 'react'
import * as THREE from 'three/webgpu'

let updateErrorLogged = false
import { useGame } from '../game/store'
import { DT } from '../sim/types'
import { S, TILE_TOP_H } from './coords'
import { GpuCanvas, useEffectiveQuality } from './GpuCanvas'
import { createMenuStage, type MenuStage } from './menuStage'
import { menuCameraAt } from './menuCamera'
import { useMedia } from '../ui/lib/media'
import { tierConfig } from './quality'
import { RenderLoop } from './RenderLoop'
import { MatchWorld } from './scene/MatchWorld'
import { createPrivateSource } from './source'

/**
 * Animated backdrop for menu and lobby screens: a slow cinematic drift over a
 * quiet sparring scene, looking out across the lava to the caldera rim,
 * while two warlocks exchange attacks, returns and escapes (menuStage.ts,
 * menuStage.ts, private frame buffer: never touches match state).
 *
 * The menu panels sit on the left: the camera aims left of the action so the
 * warlocks land in the right half of the frame at every aspect.
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
  const scene = useThree((s) => s.scene)
  const gl = useThree((s) => s.gl)
  const eff = useEffectiveQuality(quality)
  const worldRef = useRef<MatchWorld | null>(null)
  const driveRef = useRef<{ stage: MenuStage; source: ReturnType<typeof createPrivateSource>; acc: number; t0: number; ticks: number; t: number } | null>(null)
  const tmp = useRef({ pos: new THREE.Vector3(), aim: new THREE.Vector3() })

  useEffect(() => {
    const source = createPrivateSource()
    const stage = createMenuStage()
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
  }, [scene, eff, gl])

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
    const shot = menuCameraAt(drive.t, f, u, aspect, reducedMotion)
    const { pos, aim } = tmp.current
    pos.set(shot.x * S, (TILE_TOP_H + shot.height) * S, -shot.y * S)
    aim.set(shot.aimX * S, TILE_TOP_H * S, -shot.aimY * S)
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
