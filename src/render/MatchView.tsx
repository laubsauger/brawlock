import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import * as THREE from 'three/webgpu'

let updateErrorLogged = false
import { useGame } from '../game/store'
import { cameraRig } from './cameraRig'
import { startMockDriver, globalSink } from './dev/mockDriver'
import { GpuCanvas, useEffectiveQuality } from './GpuCanvas'
import { tierConfig } from './quality'
import { RenderLoop } from './RenderLoop'
import { MatchWorld } from './scene/MatchWorld'
import { globalSource } from './source'
import { devTime, perfMark, perfProbe } from './stats'

export interface MatchViewProps {
  /** Drive the global frame buffer with the dev mock match (no sim needed). */
  mock?: boolean
  className?: string
  style?: CSSProperties
  /** HUD / overlays rendered above the canvas and world overlay. */
  children?: ReactNode
  /**
   * Hidden warm-up (lobby / behind a loading overlay): the view stays mounted
   * but invisible and non-interactive, compiles every material, uploads its
   * textures and warms both warlock styles. Flip to false on match start with
   * the SAME mounted instance: a remount creates a new renderer and loses
   * the warm-up.
   */
  prewarm?: boolean
  /** Called once when materials are built, textures uploaded and frames are steady. */
  onReady?: () => void
}

/** Readiness of the mounted match view (see MatchViewProps.onReady). */
const readiness = { ready: false }

/** true once the mounted MatchView has compiled, uploaded and settled. */
export function isMatchRenderReady(): boolean {
  return readiness.ready
}

function inspectRequested(showPerf: boolean): boolean {
  // the inspector / tuning panel is a dev tool: never in production builds
  if (!import.meta.env.DEV) return false
  if (showPerf) return true
  if (typeof location === 'undefined') return false
  return new URLSearchParams(location.search).has('inspect')
}

/**
 * Full-screen match scene. Reads game/frame.ts every animation frame
 * (interpolated snapshots, event log), writes frame.cursor, renders arena,
 * lava, warlocks, projectiles and VFX, plus a DOM overlay for name tags and
 * combat numbers. Mouse wheel zooms; recenterCamera() snaps the camera.
 */
export function MatchView({ mock = false, className, style, children, prewarm = false, onReady }: MatchViewProps) {
  const quality = useGame((s) => s.settings.quality)
  const fx = useGame((s) => s.settings.fxIntensity)
  const showPerf = useGame((s) => s.settings.showPerf)
  const [overlayEl, setOverlayEl] = useState<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  // a hidden view that finished warming stops rendering until it is shown
  const idle = useRef(false)

  useEffect(() => {
    if (!mock) return
    return startMockDriver(globalSink, { global: true })
  }, [mock])

  // mouse wheel zoom: 200 game units per notch (pixel deltas accumulate)
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    let acc = 0
    const onWheel = (e: WheelEvent) => {
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1
      acc += e.deltaY * unit
      const notches = Math.trunc(acc / 100)
      if (notches !== 0) {
        acc -= notches * 100
        cameraRig.zoom(notches)
      } else if (Math.abs(e.deltaY * unit) < 40) {
        // trackpads: fractional notches, continuous zoom
        cameraRig.zoom((e.deltaY * unit) / 100)
        acc = 0
      }
      e.preventDefault()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <div
      ref={rootRef}
      className={className}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        background: '#0b0604',
        ...style,
        // keep layout size (camera aspect, render target sizes) while hidden
        ...(prewarm ? { opacity: 0, pointerEvents: 'none' } : null),
      }}
      aria-hidden={prewarm || undefined}
    >
      <GpuCanvas quality={quality} style={{ position: 'absolute', inset: 0 }}>
        <MatchScene fx={fx} quality={quality} overlayEl={overlayEl} prewarm={prewarm} onReady={onReady} idle={idle} />
        <RenderLoop quality={quality} fx={fx} inspect={inspectRequested(showPerf)} idle={idle} />
      </GpuCanvas>
      <div ref={setOverlayEl} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
      {children}
    </div>
  )
}

/** frames a world must have run, and steady frames in a row, before it reports ready */
const READY_MIN_FRAMES = 12
const READY_STEADY_FRAMES = 4
const READY_STEADY_MS = 50

function MatchScene({
  fx,
  quality,
  overlayEl,
  prewarm,
  onReady,
  idle,
}: {
  fx: number
  quality: Parameters<typeof tierConfig>[0]
  overlayEl: HTMLDivElement | null
  prewarm: boolean
  onReady?: () => void
  idle: { current: boolean }
}) {
  const scene = useThree((s) => s.scene)
  const gl = useThree((s) => s.gl)
  const eff = useEffectiveQuality(quality)
  const worldRef = useRef<MatchWorld | null>(null)
  const state0 = useRef<{ camera: THREE.Camera; size: { width: number; height: number } } | null>(null)
  const prewarmRef = useRef(prewarm)
  prewarmRef.current = prewarm
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const ready = useRef({ frames: 0, steady: 0, last: 0, done: false })

  useEffect(() => {
    if (!overlayEl) return
    const tierCfg = tierConfig(eff)
    const r = gl as unknown as THREE.WebGPURenderer
    r.shadowMap.enabled = tierCfg.shadowMap > 0
    r.shadowMap.type = THREE.PCFShadowMap
    const world = new MatchWorld({ source: globalSource, tier: tierConfig(eff), fx, overlayParent: overlayEl, mode: 'match', quality: eff, renderer: r })
    world.setPrewarm(prewarmRef.current)
    ready.current = { frames: 0, steady: 0, last: 0, done: false }
    readiness.ready = false
    scene.add(world.root)
    scene.background = new THREE.Color(0x0b0604)
    scene.fogNode = world.fogNode
    worldRef.current = world
    perfProbe.worldStep = (dt) => {
      const st = state0.current
      if (st) world.update(dt, st.camera as THREE.PerspectiveCamera, st.size.width / Math.max(1, st.size.height))
    }
    if (import.meta.env.DEV) {
      ;(window as unknown as Record<string, unknown>).__brawlockWorld = world
      ;(window as unknown as Record<string, unknown>).__brawlockRenderer = gl
    }
    return () => {
      scene.remove(world.root)
      scene.fogNode = null
      world.dispose()
      worldRef.current = null
      readiness.ready = false
      perfProbe.worldStep = null
    }
    // fx changes are applied live below; recreate only for tier/overlay changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, eff, overlayEl, gl])

  useEffect(() => {
    worldRef.current?.setFx(fx)
  }, [fx])

  useEffect(() => {
    worldRef.current?.setPrewarm(prewarm)
  }, [prewarm])

  // pointer -> NDC for the cursor raycast; window-level so HUD layers on top don't block it
  useEffect(() => {
    const canvas = gl.domElement as HTMLCanvasElement
    const onMove = (e: PointerEvent) => {
      const w = worldRef.current
      if (!w) return
      const r = canvas.getBoundingClientRect()
      const x = (e.clientX - r.left) / r.width
      const y = (e.clientY - r.top) / r.height
      w.pointer.x = x * 2 - 1
      w.pointer.y = -(y * 2 - 1)
      w.pointer.inside = x >= 0 && x <= 1 && y >= 0 && y <= 1
    }
    const onLeave = () => {
      if (worldRef.current) worldRef.current.pointer.inside = false
    }
    window.addEventListener('pointermove', onMove)
    document.addEventListener('pointerleave', onLeave)
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerleave', onLeave)
    }
  }, [gl])

  useFrame((state, dt) => {
    state0.current = state
    const w = worldRef.current
    // warmed and still hidden: hold (no update, no render) until shown
    idle.current = prewarmRef.current && ready.current.done && !!w
    if (idle.current) return
    perfMark.start = performance.now()
    if (!w) return
    try {
      w.update(Math.min(dt, 0.1) * devTime.scale, state.camera as THREE.PerspectiveCamera, state.size.width / Math.max(1, state.size.height))
    } catch (err) {
      // last resort: keep rendering (the render loop still draws this frame)
      if (!updateErrorLogged) console.error('[render] world update threw', err)
      updateErrorLogged = true
    }
    // readiness: built (min frames), uploads drained, then a few steady frames
    const rd = ready.current
    if (rd.done) return
    const now = performance.now()
    rd.frames++
    rd.steady = rd.last > 0 && now - rd.last < READY_STEADY_MS && w.uploadsDone ? rd.steady + 1 : 0
    rd.last = now
    if (rd.frames >= READY_MIN_FRAMES && rd.steady >= READY_STEADY_FRAMES) {
      rd.done = true
      readiness.ready = true
      try {
        onReadyRef.current?.()
      } catch (err) {
        console.error('[render] onReady threw', err)
      }
    }
  })

  return null
}
