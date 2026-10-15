import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three/webgpu'
import {
  clamp,
  float,
  hash,
  length,
  mix,
  mrt,
  output,
  pass,
  renderOutput,
  screenCoordinate,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { ao } from 'three/addons/tsl/display/GTAONode.js'
import { fxaa } from 'three/addons/tsl/display/FXAANode.js'
import type { Node } from 'three/webgpu'
import type { Quality } from '../game/store'
import { ZOOM_MAX, ZOOM_MIN, cameraParams, cameraZoomParam } from './cameraRig'
import { useEffectiveQuality } from './GpuCanvas'
import { tweakParams } from './tweaks'
import { tierConfig } from './quality'
import { postState } from './scene/MatchWorld'
import { getNoiseTexture } from './scene/noiseTexture'
import { perfMark, renderStats } from './stats'

/** Name of the MRT attachment materials write heat distortion strength into. */
export const HEAT_MRT = 'heat'

type GpuInfo = { render: { drawCalls?: number; triangles?: number } }
type TsRenderer = THREE.WebGPURenderer & { resolveTimestampsAsync?: (type?: string) => Promise<number | undefined> }

/**
 * Owns rendering for a canvas: r3f stops auto-rendering because this
 * useFrame has priority 1. Builds the post pipeline for the tier, renders,
 * and publishes perf numbers. Attaches the three.js Inspector on demand.
 *
 * Post (medium+): scene pass (MSAA on high/ultra) -> heat haze (MRT 'heat'
 * written by lava and hot sprites, high+) -> bloom -> hurt chroma flash ->
 * vignette -> tone map (ACES) -> film grain. Low renders directly with tone
 * mapping only.
 */
export function RenderLoop({ quality, fx, inspect }: { quality: Quality; fx: number; inspect: boolean }) {
  const gl = useThree((s) => s.gl) as unknown as TsRenderer
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  const eff = useEffectiveQuality(quality)
  const tier = tierConfig(eff)
  const dpr = useThree((s) => s.viewport.dpr)

  const u = useMemo(
    () => ({
      bloomStrength: uniform(tier.bloomStrength * fx),
      fx: uniform(fx),
      hurt: uniform(0),
      time: uniform(0),
      aspect: uniform(1),
      frame: uniform(0),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  u.bloomStrength.value = tier.bloomStrength * Math.max(0.35, fx)
  u.fx.value = fx

  const pipeline = useMemo(() => {
    if (!tier.post) return null
    // GTAO needs a single-sampled depth buffer: with AO the scene pass drops
    // MSAA (retina DPR supersamples anyway; FXAA covers low DPR on Ultra)
    const lowDpr = gl.getPixelRatio() < 1.5
    const useAo = tier.ao && (!lowDpr || eff === 'ultra')
    const samples = useAo ? 0 : lowDpr ? tier.msaa : 0
    const useFxaa = useAo && lowDpr
    const scenePass = pass(scene, camera, { samples })
    if (tier.heatHaze) {
      const outs: Record<string, Node> = { output }
      if (tier.heatHaze) outs[HEAT_MRT] = vec4(0, 0, 0, 0)
      scenePass.setMRT(mrt(outs))
      if (tier.heatHaze) scenePass.getTexture(HEAT_MRT).type = THREE.UnsignedByteType
    }
    const colorTex = scenePass.getTextureNode('output')
    const uvN = uv()
    let col: Node<'vec3'> = colorTex.rgb

    // heat haze: refract the scene by scrolling noise where materials wrote heat
    let off: Node<'vec2'> = vec2(0, 0)
    if (tier.heatHaze) {
      const heat = scenePass.getTextureNode(HEAT_MRT).r
      const nUv = uvN.mul(vec2(u.aspect.mul(2.2), 2.2)).add(vec2(u.time.mul(0.02), u.time.mul(-0.11)))
      const n = texture(getNoiseTexture(), nUv).rg.sub(0.5)
      off = n.mul(heat.mul(0.011).mul(u.fx))
    }
    // hurt flash: chromatic split + red edge when the local pawn is hit
    const dir = uvN.sub(0.5)
    const ca = dir.mul(u.hurt.mul(0.016))
    const base = uvN.add(off)
    col = vec3(colorTex.sample(base.sub(ca)).r, colorTex.sample(base).g, colorTex.sample(base.add(ca)).b)

    if (useAo) {
      // GTAO at half resolution from the scene pass depth;
      // applied softly so lava glow in crevices keeps its punch
      // normals are reconstructed from depth: an MRT normal target would be
      // overwritten by additive sprites across their whole quad (alpha is
      // not shape-masked) and turn into square AO patches around VFX
      const aoPass = ao(scenePass.getTextureNode('depth'), null as unknown as Node, camera)
      aoPass.resolutionScale = 0.5
      aoPass.radius.value = 0.6
      aoPass.thickness.value = 1
      aoPass.distanceExponent.value = 1.5
      const aoVal = aoPass.getTextureNode().sample(uvN).r
      col = col.mul(mix(float(1), aoVal, 0.75))
    }
    if (tier.bloom) {
      const b = bloom(colorTex, 1, 0.4, 1.0)
      b.strength = u.bloomStrength
      b.smoothWidth.value = 0.6
      col = col.add(b.rgb)
    }
    const r = length(dir.mul(vec2(u.aspect, 1)).mul(vec2(0.82, 1)))
    const vig = smoothstep(0.42, 1.05, r).mul(0.5)
    col = col.mul(float(1).sub(vig))
    col = mix(col, col.mul(vec3(1.25, 0.55, 0.5)), smoothstep(0.25, 0.9, r).mul(u.hurt).mul(0.8))

    let toned: Node<'vec4'> = renderOutput(vec4(col, 1))
    if (useFxaa) toned = fxaa(toned) as unknown as Node<'vec4'>
    // integer pixel seed (hash() truncates to uint, so fractional seeds band)
    const px = screenCoordinate.xy.floor()
    const seed = px.x.add(px.y.mul(1999)).add(u.frame.mul(7919))
    const grain = hash(seed).sub(0.5).mul(0.03).mul(u.fx)
    const outC = clamp(toned.rgb.add(grain), 0, 1)
    const rp = new THREE.RenderPipeline(gl)
    rp.outputColorTransform = false
    rp.outputNode = vec4(outC, 1)
    return rp
  }, [gl, scene, camera, tier, u, eff, dpr])

  useEffect(() => () => pipeline?.dispose(), [pipeline])

  // Inspector: three.js addon, loaded on demand
  useEffect(() => {
    if (!inspect) return
    let disposed = false
    let attached = false
    void import('three/addons/inspector/Inspector.js').then(({ Inspector }) => {
      if (disposed) return
      const ins = new Inspector()
      gl.inspector = ins
      attached = true
      // live camera tuning (match camera only; the menu orbit is separate)
      const g = ins.createParameters('Camera')
      g.add(cameraParams, 'pitch', 30, 85, 0.5)
      g.add(cameraParams, 'hfov', 40, 100, 0.5)
      g.add(cameraParams, 'centerOffset', -0.3, 0.4, 0.01)
      g.add(cameraZoomParam, 'distance', ZOOM_MIN, ZOOM_MAX, 10)
      const a = ins.createParameters('Arena')
      a.add(tweakParams, 'tileMaterial', ['auto', 'procedural', 'textured'] as const)
      a.add(tweakParams, 'edgeGlow', 0, 3, 0.05)
      a.add(tweakParams, 'edgeWidth', 5, 200, 1)
      a.add(tweakParams, 'debugFaces', 0, 2, 1)
      a.add(tweakParams, 'sigils')
    })
    return () => {
      disposed = true
      if (attached) gl.inspector = new THREE.InspectorBase()
    }
  }, [gl, inspect])

  const perf = useRef({ frame: 0, last: 0, cpu: 0, pending: false })
  useEffect(() => {
    renderStats.tier = eff
  }, [eff])

  useFrame((state, dt) => {
    const t0 = performance.now()
    u.time.value += dt
    u.frame.value = (u.frame.value + 1) % 61
    u.hurt.value = postState.hurt * Math.max(0.3, fx)
    const size = state.size
    u.aspect.value = size.width / Math.max(1, size.height)
    if (pipeline) pipeline.render()
    else gl.render(scene, camera)

    const p = perf.current
    const now = performance.now()
    if (p.last > 0) {
      const dtm = now - p.last
      renderStats.frameMs += (dtm - renderStats.frameMs) * 0.1
      renderStats.fps = renderStats.frameMs > 0 ? 1000 / renderStats.frameMs : 0
    }
    p.last = now
    // main-thread time: scene update (stamped by the world) + render submit
    const start = perfMark.start > 0 && perfMark.start <= t0 ? perfMark.start : t0
    renderStats.cpuMs += (now - start - renderStats.cpuMs) * 0.1
    perfMark.start = 0
    const info = (gl.info as unknown as GpuInfo).render
    renderStats.drawCalls = info.drawCalls ?? 0
    renderStats.triangles = info.triangles ?? 0
    p.frame++
    if (p.frame % 15 === 0 && !p.pending && gl.resolveTimestampsAsync) {
      p.pending = true
      gl.resolveTimestampsAsync('render')
        .then((ms) => {
          if (typeof ms === 'number' && ms > 0) renderStats.gpuMs = ms
        })
        .catch(() => {})
        .finally(() => {
          p.pending = false
        })
    }
  }, 1)

  return null
}
