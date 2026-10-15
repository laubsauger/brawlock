import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import * as THREE from 'three/webgpu'
import { useGame } from '../game/store'
import { cameraRig } from './cameraRig'
import { startMockDriver, globalSink } from './dev/mockDriver'
import { GpuCanvas, useEffectiveQuality } from './GpuCanvas'
import { tierConfig } from './quality'
import { RenderLoop } from './RenderLoop'
import { MatchWorld } from './scene/MatchWorld'
import { globalSource } from './source'
import { devTime, perfMark } from './stats'

export interface MatchViewProps {
  /** Drive the global frame buffer with the dev mock match (no sim needed). */
  mock?: boolean
  className?: string
  style?: CSSProperties
  /** HUD / overlays rendered above the canvas and world overlay. */
  children?: ReactNode
}

function inspectRequested(showPerf: boolean): boolean {
  if (showPerf) return true
  if (!import.meta.env.DEV || typeof location === 'undefined') return false
  return new URLSearchParams(location.search).has('inspect')
}

/**
 * Full-screen match scene. Reads game/frame.ts every animation frame
 * (interpolated snapshots, event log), writes frame.cursor, renders arena,
 * lava, warlocks, projectiles and VFX, plus a DOM overlay for name tags and
 * combat numbers. Mouse wheel zooms; recenterCamera() snaps the camera.
 */
export function MatchView({ mock = false, className, style, children }: MatchViewProps) {
  const quality = useGame((s) => s.settings.quality)
  const fx = useGame((s) => s.settings.fxIntensity)
  const showPerf = useGame((s) => s.settings.showPerf)
  const [overlayEl, setOverlayEl] = useState<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

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
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: '#0b0604', ...style }}
    >
      <GpuCanvas quality={quality} style={{ position: 'absolute', inset: 0 }}>
        <MatchScene fx={fx} quality={quality} overlayEl={overlayEl} />
        <RenderLoop quality={quality} fx={fx} inspect={inspectRequested(showPerf)} />
      </GpuCanvas>
      <div ref={setOverlayEl} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
      {children}
    </div>
  )
}

function MatchScene({ fx, quality, overlayEl }: { fx: number; quality: Parameters<typeof tierConfig>[0]; overlayEl: HTMLDivElement | null }) {
  const scene = useThree((s) => s.scene)
  const gl = useThree((s) => s.gl)
  const eff = useEffectiveQuality(quality)
  const worldRef = useRef<MatchWorld | null>(null)

  useEffect(() => {
    if (!overlayEl) return
    const tierCfg = tierConfig(eff)
    const r = gl as unknown as THREE.WebGPURenderer
    r.shadowMap.enabled = tierCfg.shadowMap > 0
    r.shadowMap.type = THREE.PCFShadowMap
    const world = new MatchWorld({ source: globalSource, tier: tierConfig(eff), fx, overlayParent: overlayEl, mode: 'match', quality: eff })
    scene.add(world.root)
    scene.background = new THREE.Color(0x0b0604)
    scene.fogNode = world.fogNode
    worldRef.current = world
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__brawlockWorld = world
    return () => {
      scene.remove(world.root)
      scene.fogNode = null
      world.dispose()
      worldRef.current = null
    }
    // fx changes are applied live below; recreate only for tier/overlay changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, eff, overlayEl, gl])

  useEffect(() => {
    worldRef.current?.setFx(fx)
  }, [fx])

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
    perfMark.start = performance.now()
    const w = worldRef.current
    if (!w) return
    w.update(Math.min(dt, 0.1) * devTime.scale, state.camera as THREE.PerspectiveCamera, state.size.width / Math.max(1, state.size.height))
  })

  return null
}
