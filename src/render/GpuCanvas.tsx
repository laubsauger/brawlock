import { Canvas, extend, useThree, type ThreeToJSXElements } from '@react-three/fiber'
import * as THREE from 'three/webgpu'
import { useEffect, type CSSProperties, type ReactNode } from 'react'
import type { Quality } from '../game/store'
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
function DprSync({ quality }: { quality: Quality }) {
  const setDpr = useThree((s) => s.setDpr)
  const eff = useEffectiveQuality(quality)
  useEffect(() => {
    const d = Math.min(tierDpr(eff), window.devicePixelRatio || 1)
    setDpr(d)
    renderStats.dpr = d
  }, [eff, setDpr])
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
  return (
    <Canvas
      className={className}
      style={style}
      flat={false}
      frameloop="always"
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
      {children}
    </Canvas>
  )
}
