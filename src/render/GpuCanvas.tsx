import { advance, Canvas, extend, useFrame, useThree, type ThreeToJSXElements } from '@react-three/fiber'
import * as THREE from 'three/webgpu'
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import type { Quality } from '../game/store'
import { useRenderPref } from './prefs'
import { tierDpr } from './quality'
import { renderStats } from './stats'

declare module '@react-three/fiber' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

extend(THREE as unknown as Parameters<typeof extend>[0])

/**
 * The r3f `dpr` prop gets lost during the async WebGPU renderer init (the
 * canvas comes up at pixelRatio 1 until the first resize). Apply it
 * deterministically after mount, capped at the device ratio.
 */
/** standard display frame intervals (ms): 144, 120, 90, 75, 60, 30 Hz */
const REFRESH_MS = [6.94, 8.33, 11.1, 13.3, 16.67, 33.3]

function DprSync({ quality }: { quality: Quality }) {
  const setDpr = useThree((s) => s.setDpr)
  const eff = useEffectiveQuality(quality)
  const resScale = useRenderPref('resolutionScale')
  // a new fps cap changes the frame interval: re-learn it (else a lower cap reads as overload)
  const fpsCap = useRenderPref('fpsCap')
  const dyn = useRef({ cap: 1, dpr: 1, refresh: 1e9, acc: 0, n: 0, since: 0, bad: 0 })
  useEffect(() => {
    // the player's resolution scale caps the tier ratio (and so dynamic res)
    const d = Math.min(tierDpr(eff), window.devicePixelRatio || 1) * resScale
    setDpr(d)
    renderStats.dpr = d
    const st = dyn.current
    st.cap = d
    st.dpr = d
    st.refresh = 1e9
    st.acc = 0
    st.n = 0
    st.since = 0
    st.bad = 0
  }, [eff, setDpr, resScale, fpsCap])

  // Dynamic resolution (plan 5.5): the display refresh interval is the
  // shortest frame interval seen; when frames run >15 % slower than that for
  // two seconds the GPU/CPU is over budget, so step the pixel ratio down;
  // step back up when there is clear headroom. Never below 60 % of the tier cap.
  useFrame((_, dt) => {
    const st = dyn.current
    const ms = dt * 1000
    if (ms <= 0 || ms > 100) return
    st.acc += ms
    st.n++
    st.since += dt
    if (st.since < 2) return
    const avg = st.acc / st.n
    st.acc = 0
    st.n = 0
    st.since = 0
    // refresh interval: snap the best window average to a standard display rate
    let rate = REFRESH_MS[REFRESH_MS.length - 1]
    for (const r of REFRESH_MS) if (avg <= r * 1.06) { rate = r; break }
    st.refresh = Math.min(st.refresh, rate)
    const floor = Math.min(st.cap, Math.max(1, st.cap * 0.65))
    let next = st.dpr
    const slow = avg > st.refresh * 1.3
    st.bad = slow ? st.bad + 1 : 0
    if (st.bad >= 2 && st.dpr > floor) {
      next = Math.max(floor, st.dpr - 0.15)
      st.bad = 0
    } else if (avg < st.refresh * 1.05 && st.dpr < st.cap) next = Math.min(st.cap, st.dpr + 0.1)
    if (Math.abs(next - st.dpr) > 0.01) {
      st.dpr = next
      setDpr(next)
      renderStats.dpr = next
    }
  })
  return null
}

/**
 * Frame rate cap (settings): with a cap the canvas runs frameloop="never"
 * and this drives r3f's advance() from its own rAF on a fixed schedule, so
 * skipped display frames cost nothing (no update, no submit) and every
 * useFrame still gets the real elapsed dt.
 */
function FpsCap({ cap }: { cap: number }) {
  const get = useThree((s) => s.get)
  useEffect(() => {
    if (cap <= 0) return
    const interval = 1000 / cap
    let next = 0
    let raf = 0
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const st = get()
      if (st.frameloop !== 'never') return
      if (next === 0) {
        // setFrameloop('never') zeroed the clock: start it one interval back
        st.clock.elapsedTime = (now - interval) / 1000
        next = now
      }
      // schedule on an accumulator so caps below the display rate average
      // out exactly (60 on 144 Hz alternates 2- and 3-frame gaps)
      if (now < next - 1.5) return
      next = now - next > interval ? now + interval : next + interval
      advance(now / 1000, true, st)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [cap, get])
  return null
}

export function isWebGLBackend(renderer: unknown): boolean {
  const b = (renderer as { backend?: { isWebGLBackend?: boolean } }).backend
  return !!b?.isWebGLBackend
}

/** The WebGL2 fallback is forced to the Low tier (plan §4.1). Use inside the canvas. */
export function useEffectiveQuality(quality: Quality): Quality {
  const gl = useThree((s) => s.gl)
  return isWebGLBackend(gl) ? 'low' : quality
}

/**
 * WebGPU canvas (three/webgpu WebGPURenderer). Falls back to the WebGL2
 * backend automatically where WebGPU is missing. Timestamp queries are on so
 * the perf HUD gets real GPU ms. MSAA lives on the post scene pass, so the
 * canvas itself is not antialiased.
 */
export function GpuCanvas({
  children,
  quality,
  className,
  style,
}: {
  children: ReactNode
  quality: Quality
  className?: string
  style?: CSSProperties
}) {
  const fpsCap = useRenderPref('fpsCap')
  return (
    <Canvas
      className={className}
      style={style}
      flat={false}
      frameloop={fpsCap > 0 ? 'never' : 'always'}
      camera={{ fov: 55, near: 0.5, far: 400, position: [0, 12, 8] }}
      gl={async (props) => {
        const renderer = new THREE.WebGPURenderer({
          ...(props as ConstructorParameters<typeof THREE.WebGPURenderer>[0]),
          antialias: false,
          forceWebGL: false,
          alpha: false,
          powerPreference: 'high-performance',
          trackTimestamp: true,
        })
        await renderer.init()
        renderer.toneMapping = THREE.ACESFilmicToneMapping
        renderer.toneMappingExposure = 1.05
        renderStats.backend = isWebGLBackend(renderer) ? 'webgl2' : 'webgpu'
        return renderer
      }}
    >
      <DprSync quality={quality} />
      <FpsCap cap={fpsCap} />
      {children}
    </Canvas>
  )
}
