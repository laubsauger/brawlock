import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef, type CSSProperties } from 'react'
import * as THREE from 'three/webgpu'

let updateErrorLogged = false
import { useGame } from '../game/store'
import { DT } from '../sim/types'
import { S, TILE_TOP_H } from './coords'
import { GpuCanvas, useEffectiveQuality } from './GpuCanvas'
import { createMenuStage, type MenuStage } from './menuStage'
import { tierConfig } from './quality'
import { RenderLoop } from './RenderLoop'
import { MatchWorld } from './scene/MatchWorld'
import { createPrivateSource } from './source'

/**
 * Animated backdrop for menu and lobby screens: a slow cinematic drift over a
 * corner of the platform, looking out across the lava to the caldera rim,
 * while three warlocks loiter and trade the odd Fireball (scripted calm stage,
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

/** camera shape (game units / degrees) */
const CAM = {
  /** back from the action toward the platform centre */
  back: 1300,
  height: 860,
  /** aim this far past the action, out over the lava */
  ahead: 170,
  aimH: 0,
  /** where the action sits on screen (0 = left edge): right of the menu panels at any aspect */
  screenX: 0.66,
  fov: 34,
  /** slow drift: lateral sway (units) and its period (s) */
  sway: 150,
  swayT: 84,
  dolly: 0.06,
  dollyT: 61,
}

function MenuScene({ quality, fx }: { quality: Parameters<typeof tierConfig>[0]; fx: number }) {
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
    const world = new MatchWorld({ source, tier: tierConfig(eff), fx, overlayParent: null, mode: 'menu', renderer: r })
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
    try {
      world.update(dt, cam, state.size.width / Math.max(1, state.size.height))
    } catch (err) {
      if (!updateErrorLogged) console.error('[render] menu world update threw', err)
      updateErrorLogged = true
    }
    // cinematic camera (after the world's own menu orbit, which it overrides)
    const { focus: f, out: u } = drive.stage
    const t = drive.t
    const rx = u.y
    const ry = -u.x
    const sway = Math.sin((t / CAM.swayT) * Math.PI * 2) * CAM.sway
    const back = CAM.back * (1 + Math.sin((t / CAM.dollyT) * Math.PI * 2) * CAM.dolly)
    const cx = f.x - u.x * back + rx * sway
    const cy = f.y - u.y * back + ry * sway
    // aim left of the action by the angle that puts it at screenX (Hor+ aware)
    const aspect = state.size.width / Math.max(1, state.size.height)
    const lx = f.x + u.x * CAM.ahead + rx * sway * 0.35
    const ly = f.y + u.y * CAM.ahead + ry * sway * 0.35
    // depth of the aim point along the view (camera height counts: 3D distance)
    const reach = Math.hypot(lx - cx, ly - cy, CAM.height - CAM.aimH)
    const aimLeft = reach * (2 * CAM.screenX - 1) * Math.tan(((CAM.fov / 2) * Math.PI) / 180) * aspect
    const ax = lx - rx * aimLeft
    const ay = ly - ry * aimLeft
    const { pos, aim } = tmp.current
    pos.set(cx * S, (TILE_TOP_H + CAM.height) * S, -cy * S)
    aim.set(ax * S, (TILE_TOP_H + CAM.aimH) * S, -ay * S)
    cam.position.copy(pos)
    cam.lookAt(aim)
    if (cam.fov !== CAM.fov) {
      cam.fov = CAM.fov
      cam.updateProjectionMatrix()
    }
  })
  return null
}
