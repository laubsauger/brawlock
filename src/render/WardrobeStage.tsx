import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { registerRenderCapture } from './capture'
import * as THREE from 'three/webgpu'
import { useGame } from '../game/store'
import type { CosmeticSlot } from '../game/progressionCatalog'
import type { PawnState, SimEvent, SpellId } from '../sim/types'
import { createWarlock, preloadWarlock, type WarlockHandle } from './character'
import type { VictoryStyle } from './character/victoryPose'
import type { Outfit } from './character/wardrobe'
import { S } from './coords'
import { GpuCanvas } from './GpuCanvas'

/**
 * The wardrobe's warlock: one live, animated warlock on a pedestal wearing the try-on outfit,
 * turned by dragging or the turn buttons, zoomed by the wheel, posed (idle, walking or running in
 * place, a cast loop, the victory pose) so it doubles as a character inspector. `view` frames the slot being browsed (the hat from the front, the cape
 * print from behind) or `game`: the real gameplay camera height and angle, the read that
 * matters. `onThumbs` gets a picture of every outfit in `thumbs`, rendered once, offscreen.
 */
export type WardrobeView = 'full' | 'head' | 'back' | 'game'
export interface ThumbRequest {
  key: string
  outfit: Outfit
  view: 'head' | 'back' | 'full'
}

const FACE_CAMERA = -Math.PI / 2

/** What the stage warlock does: stand, walk or run in place, cast in a loop, or celebrate. */
export type StagePose = 'idle' | 'walk' | 'run' | 'cast' | 'victory'
/** Turn and zoom from outside the canvas (the wardrobe's buttons). */
export interface StageControls {
  turn(radians: number): void
  zoom(factor: number): void
}
/** walk / run speeds in game units/s (the locomotion layer switches at 25 and 140) */
const POSE_SPEED: Partial<Record<StagePose, number>> = { walk: 90, run: 260 }
/** the cast loop: one spell per cast category the stage can show without a target */
const CAST_LOOP: readonly SpellId[] = ['fireball', 'lightning', 'meteor']
const NO_EVENTS: readonly SimEvent[] = []

function standingPawn(): PawnState {
  return {
    id: 0, owner: 0, x: 0, y: 0, vx: 0, vy: 0, walkVx: 0, walkVy: 0, facing: FACE_CAMERA, hp: 1000, maxHp: 1000, hpRegen: 0,
    moveSpeed: 210, kbPoints: 0, kbFactor: 1, alive: true, invulnerable: false, moveTarget: null, cast: null,
    cooldowns: [0, 0], slots: ['fireball', 'scourge'], levels: [1, 1], modifiers: [], lastHitter: null, lavaTicks: 0,
  } as unknown as PawnState
}

/**
 * Camera for a view, looking at a warlock standing at the origin facing the camera; `h` = its
 * height, `top` = the highest point of what it carries (a staff head), world metres.
 */
function frame(cam: THREE.PerspectiveCamera, view: WardrobeView | 'thumbHead' | 'thumbBack' | 'thumbFull', h: number, top = h): void {
  cam.fov = view === 'head' ? 28 : view === 'thumbHead' ? 22 : view === 'game' ? 43 : 34
  switch (view) {
    case 'head':
      // head and shoulders with room above the hood for tall hats, horns and antlers
      cam.position.set(0, h * 1.1, h * 1.95)
      cam.lookAt(0, h * 0.9, 0)
      break
    case 'thumbHead':
      cam.position.set(0, h * 1.15, h * 1.25)
      cam.lookAt(0, h * 0.86, 0)
      break
    case 'back':
      // the whole back, hood to hem, so capes, wings and emblems read in full
      cam.position.set(0, h * 1.05, -h * 2.6)
      cam.lookAt(0, h * 0.62, 0)
      break
    case 'thumbBack':
      cam.position.set(0, h * 1.1, -h * 1.9)
      cam.lookAt(0, h * 0.62, 0)
      break
    case 'game':
      // the match camera: ~11 m up and back at its default zoom, steep look-down
      cam.position.set(0, 1100 * S * 0.82, 1100 * S * 0.57)
      cam.lookAt(0, h * 0.4, 0)
      break
    default: {
      // full body, pulled back to fit a staff head above the hood
      const f = Math.max(h, top * 1.05)
      cam.position.set(0, f * 1.0, f * 2.5)
      cam.lookAt(0, f * 0.5, 0)
    }
  }
  cam.updateProjectionMatrix()
}

/** Wear `outfit`, pose a frame and return the highest point (a staff head reaches above the hood). */
function measureTop(warlock: WarlockHandle, outfit: Outfit, p: PawnState): number {
  warlock.setOutfit(outfit)
  for (let i = 0; i < 3; i++) warlock.update(p, p, 1, 1 / 60, [])
  warlock.object3d.updateMatrixWorld(true)
  const box = new THREE.Box3()
  warlock.object3d.traverse((o) => { if (o.name === 'WarlockStaff') box.expandByObject(o) })
  return box.isEmpty() ? 0 : box.max.y
}

function Scene({ color, outfit, view, pose, victory, controls, onThumbs, thumbs }: { color: number; outfit: Outfit; view: WardrobeView; pose: StagePose; victory: VictoryStyle | null; controls?: MutableRefObject<StageControls | null>; onThumbs?: (pics: Record<string, string>) => void; thumbs?: ThumbRequest[] }) {
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const gl = useThree((s) => s.gl) as unknown as THREE.WebGPURenderer
  useEffect(() => registerRenderCapture(gl.domElement, () => {
    gl.render(scene, camera)
    const copy = document.createElement('canvas')
    copy.width = gl.domElement.width
    copy.height = gl.domElement.height
    const context = copy.getContext('2d')
    if (!context) throw new Error('Could not create the wardrobe screenshot.')
    context.drawImage(gl.domElement, 0, 0)
    return copy
  }), [gl, scene, camera])
  const [warlock, setWarlock] = useState<WarlockHandle | null>(null)
  const pawn = useRef(standingPawn())
  // yaw eases to `target` (the turn buttons); dragging sets both. zoom scales the framing.
  const spin = useRef({ yaw: 0, target: 0, drag: false, lastX: 0, zoom: 1 })
  const cast = useRef({ t: 0, winding: false, i: 0 })
  const ring = useRef<THREE.Mesh>(null)
  // measured once the warlock exists (the model's scale, not a guess)
  const height = useRef(129 * S)
  // top of the worn outfit incl. a staff (re-measured on change)
  const top = useRef(129 * S)

  useEffect(() => {
    let live = true
    let made: WarlockHandle | null = null
    void preloadWarlock().then(() => {
      if (!live) return
      made = createWarlock({ color, style: 'cc0' })
      scene.add(made.object3d)
      made.update(pawn.current, pawn.current, 1, 1 / 60, [])
      made.object3d.updateMatrixWorld(true)
      const box = new THREE.Box3().setFromObject(made.object3d)
      if (Number.isFinite(box.max.y) && box.max.y > 0.1) height.current = box.max.y
      setWarlock(made)
    })
    return () => {
      live = false
      if (made) {
        scene.remove(made.object3d)
        made.dispose()
      }
    }
  }, [scene])

  useEffect(() => {
    warlock?.setColor(color)
    if (ring.current) (ring.current.material as THREE.MeshBasicMaterial).color.setHex(color)
  }, [warlock, color])
  useEffect(() => {
    if (!warlock) return
    top.current = measureTop(warlock, outfit, pawn.current)
  }, [warlock, outfit])
  useEffect(() => {
    if (!warlock) return
    if (pose === 'victory') warlock.celebrate(FACE_CAMERA - spin.current.yaw, victory ?? 'summon')
    // any other pose: a new round's fight phase ends the celebration, as in a match
    else warlock.update(pawn.current, pawn.current, 1, 1 / 60, [{ type: 'phase', phase: 'fight', round: 0 }])
  }, [warlock, pose, victory])
  // a new framing starts from the front, unzoomed
  useEffect(() => {
    const s = spin.current
    s.yaw = s.target = 0
    s.zoom = 1
  }, [view])

  // drag to turn, wheel to zoom; buttons outside the canvas use the same state
  useEffect(() => {
    const el = gl.domElement
    const s = spin.current
    const down = (e: PointerEvent) => { s.drag = true; s.lastX = e.clientX; el.setPointerCapture(e.pointerId) }
    const move = (e: PointerEvent) => {
      if (!s.drag) return
      s.yaw += (e.clientX - s.lastX) * 0.012
      s.target = s.yaw
      s.lastX = e.clientX
    }
    const up = () => { s.drag = false }
    const zoomBy = (k: number) => { s.zoom = Math.min(2.6, Math.max(0.6, s.zoom * k)) }
    const wheel = (e: WheelEvent) => { e.preventDefault(); zoomBy(Math.exp(-e.deltaY * 0.0015)) }
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    el.addEventListener('wheel', wheel, { passive: false })
    if (controls) controls.current = { turn: (r) => { s.target += r }, zoom: zoomBy }
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      el.removeEventListener('wheel', wheel)
      if (controls) controls.current = null
    }
  }, [gl, controls])

  // offscreen thumbnails: each requested outfit, posed and framed, read back once
  const thumbsDone = useRef('')
  useEffect(() => {
    if (!warlock || !thumbs || !onThumbs) return
    const key = thumbs.map((t) => t.key).join('|')
    if (thumbsDone.current === key) return
    thumbsDone.current = key
    let live = true
    void (async () => {
      // 192 px x 4 bytes = 768: a multiple of WebGPU's 256-byte readback row alignment
      const size = 192
      const target = new THREE.RenderTarget(size, size, { samples: 4 })
      const cam = new THREE.PerspectiveCamera(32, 1, 0.05, 50)
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = size
      const c2 = canvas.getContext('2d')!
      const pics: Record<string, string> = {}
      const p = standingPawn()
      for (const t of thumbs) {
        if (!live) break
        p.facing = FACE_CAMERA
        // wears the outfit and poses it
        const tTop = measureTop(warlock, t.outfit, p)
        frame(cam, t.view === 'head' ? 'thumbHead' : t.view === 'back' ? 'thumbBack' : 'thumbFull', height.current, tTop)
        gl.setRenderTarget(target)
        gl.render(scene, cam)
        gl.setRenderTarget(null)
        const px = (await gl.readRenderTargetPixelsAsync(target, 0, 0, size, size)) as Uint8Array
        const img = c2.createImageData(size, size)
        // WebGPU reads rows top-down; the target is linear: encode to sRGB
        for (let y = 0; y < size; y++)
          for (let x = 0; x < size; x++) {
            const si = (y * size + x) * 4
            const di = (y * size + x) * 4
            for (let k = 0; k < 3; k++) img.data[di + k] = Math.round(255 * Math.pow(px[si + k] / 255, 1 / 2.2))
            img.data[di + 3] = 255
          }
        c2.putImageData(img, 0, 0)
        pics[t.key] = canvas.toDataURL('image/png')
      }
      target.dispose()
      top.current = measureTop(warlock, outfit, pawn.current)
      if (live) onThumbs(pics)
    })()
    return () => { live = false }
  }, [warlock, thumbs, onThumbs, gl, scene, outfit])

  useFrame((_, dt) => {
    if (!warlock) return
    const s = spin.current
    if (!s.drag) s.yaw += (s.target - s.yaw) * Math.min(1, dt * 10)
    // the back view moves the camera behind; the warlock keeps facing front
    const p = pawn.current
    p.facing = FACE_CAMERA - s.yaw
    // walking / running in place: the sim velocity drives legs, lean and cloth
    const speed = POSE_SPEED[pose] ?? 0
    p.walkVx = p.vx = Math.cos(p.facing) * speed
    p.walkVy = p.vy = Math.sin(p.facing) * speed
    let events = NO_EVENTS
    if (pose === 'cast') {
      // a windup, the release, a breath; then the next spell of the loop
      const c = cast.current
      c.t += dt
      const spell = CAST_LOOP[c.i]
      if (!c.winding && c.t > 1.1) {
        c.winding = true
        c.t = 0
        events = [{ type: 'castStart', pawn: p.id, spell, ticks: 30 }]
      } else if (c.winding && c.t > 0.5) {
        c.winding = false
        c.t = 0
        c.i = (c.i + 1) % CAST_LOOP.length
        events = [{ type: 'cast', pawn: p.id, spell, x: p.x + Math.cos(p.facing) * 400, y: p.y + Math.sin(p.facing) * 400 }]
      }
    } else if (cast.current.winding) {
      cast.current.winding = false
      events = [{ type: 'castCancel', pawn: p.id, spell: CAST_LOOP[cast.current.i], slot: 0, started: true }]
    }
    warlock.update(p, p, 1, dt, events)
    camera.zoom = s.zoom
    frame(camera, view, height.current, top.current)
  })

  return <>
    <hemisphereLight args={[0xd8c8ff, 0x2a1408, 1.1]} />
    <directionalLight position={[2, 4, 3]} intensity={2.4} color={0xffe2c0} />
    <directionalLight position={[-3, 2.5, -3]} intensity={1.6} color={0x88a0ff} />
    <mesh rotation-x={-Math.PI / 2} position={[0, -0.004, 0]}>
      <planeGeometry args={[40, 40]} />
      <meshStandardMaterial color={0x120e0d} roughness={0.95} />
    </mesh>
    {/* arena-sized tiles, so the in-game view reads at the real scale */}
    <gridHelper args={[40, 40, 0x3a2418, 0x2a1a12]} position={[0, -0.002, 0]} />
    <mesh rotation-x={-Math.PI / 2} position={[0, -0.001, 0]}>
      <circleGeometry args={[0.95, 48]} />
      <meshStandardMaterial color={0x1a1412} roughness={0.9} />
    </mesh>
    <mesh ref={ring} rotation-x={-Math.PI / 2} position={[0, 0.002, 0]}>
      <ringGeometry args={[0.4, 0.43, 64]} />
      <meshBasicMaterial color={color} toneMapped={false} />
    </mesh>
  </>
}

export function WardrobeStage(props: { color: number; outfit: Outfit; view: WardrobeView; pose?: StagePose; victory?: VictoryStyle | null; controls?: MutableRefObject<StageControls | null>; className?: string; onThumbs?: (pics: Record<string, string>) => void; thumbs?: ThumbRequest[] }) {
  const quality = useGame((s) => s.settings.quality)
  return <GpuCanvas quality={quality} className={props.className} style={{ touchAction: 'none', cursor: 'grab' }}>
    <color attach="background" args={[0x0d0a0a]} />
    <Scene color={props.color} outfit={props.outfit} view={props.view} pose={props.pose ?? 'idle'} victory={props.victory ?? null} controls={props.controls} onThumbs={props.onThumbs} thumbs={props.thumbs} />
  </GpuCanvas>
}

export type { CosmeticSlot }
