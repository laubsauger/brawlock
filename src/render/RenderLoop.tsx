import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three/webgpu'
import {
  clamp,
  float,
  hash,
  max,
  min,
  length,
  mix,
  mrt,
  output,
  pass,
  renderOutput,
  screenCoordinate,
  select,
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
import { warlockParams } from './character'
import { tierConfig } from './quality'
import { postState } from './scene/MatchWorld'
import { getNoiseTexture } from './scene/noiseTexture'
import { perfMark, perfProbe, renderStats } from './stats'

/** HDR ceilings (linear, max channel). Scene: before bloom/composite (bloom
 * still gets bright cores). Final: before tone mapping. Low: no bloom, so
 * keep values where ACES still shows hue instead of flat white. */
const SCENE_MAX = 16
const BLOOM_MAX = 1.5
const FINAL_MAX = 6
const LOW_TIER_MAX = 2.2

/** NaN / +-Inf / negative -> 0 per channel (comparisons are false for NaN). */
function finite(x: Node<'float'>): Node<'float'> {
  return select(x.greaterThanEqual(0).and(x.lessThan(65000)), x, float(0))
}

/**
 * Sanitize, then scale a colour down so its brightest channel is <= `limit`
 * (hue preserved). One bad pixel (NaN / Inf from any shader) can no longer be
 * smeared over the whole frame by bloom.
 */
function clampHdr(c: Node<'vec3'>, limit: number): Node<'vec3'> {
  const sc = vec3(finite(c.r), finite(c.g), finite(c.b))
  const m = max(max(sc.r, sc.g), max(sc.b, 1e-4))
  return sc.mul(min(float(1), float(limit).div(m)))
}

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
 * vignette -> tone map (ACES) -> film grain. Low: scene pass -> hue-preserving
 * HDR clamp -> tone map (no bloom). Every tier clamps HDR so no effect can
 * white out the screen.
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
    if (!tier.post) {
      // Low: no bloom, so one overbright effect would clip to a flat white
      // blob (the Shield-dome whiteout). A minimal pass clamps every pixel by
      // its max channel (hue kept: orange stays orange) before tone mapping.
      const lowPass = pass(scene, camera, { samples: 0 })
      const c = lowPass.getTextureNode('output').rgb
      const rp = new THREE.RenderPipeline(gl)
      rp.outputNode = vec4(clampHdr(c, LOW_TIER_MAX), 1)
      return rp
    }
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
    // global whiteout guard: scene HDR is clamped (max channel, hue kept)
    // before bloom and compositing, the bloom add is capped, and the final
    // pre-tone-map colour is clamped again
    const clampedScene = clampHdr(colorTex.rgb, SCENE_MAX)
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
    // subtle, edge-weighted split: at most ~0.4 % of the screen at the corners
    const ca = dir.mul(min(u.hurt, 0.8).mul(0.006))
    const base = uvN.add(off)
    col = clampHdr(vec3(colorTex.sample(base.sub(ca)).r, colorTex.sample(base).g, colorTex.sample(base.add(ca)).b), SCENE_MAX)

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
      const b = bloom(vec4(clampedScene, 1), 1, 0.4, 1.0)
      b.strength = u.bloomStrength
      b.smoothWidth.value = 0.6
      col = col.add(min(b.rgb, vec3(BLOOM_MAX, BLOOM_MAX, BLOOM_MAX)))
    }
    const r = length(dir.mul(vec2(u.aspect, 1)).mul(vec2(0.82, 1)))
    const vig = smoothstep(0.42, 1.05, r).mul(0.5)
    col = col.mul(float(1).sub(vig))
    col = mix(col, col.mul(vec3(1.25, 0.55, 0.5)), smoothstep(0.25, 0.9, r).mul(u.hurt).mul(0.8))

    let toned: Node<'vec4'> = renderOutput(vec4(clampHdr(col, FINAL_MAX), 1))
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

  useEffect(() => () => pipeline.dispose(), [pipeline])

  // real GPU cost: render N frames back to back, wait for the queue to drain
  useEffect(() => {
    const device = (gl as unknown as { backend?: { device?: GPUDevice } }).backend?.device
    if (!device) return
    perfProbe.bench = async (frames = 60) => {
      await device.queue.onSubmittedWorkDone()
      const t0 = performance.now()
      // pass nodes re-render once per node frame; the frame id normally
      // advances in the renderer's own rAF loop, so advance it per iteration
      const nodeFrame = (gl as unknown as { _nodes?: { nodeFrame?: { update(): void } } })._nodes?.nodeFrame
      for (let i = 0; i < frames; i++) {
        nodeFrame?.update()
        pipeline.render()
      }
      await device.queue.onSubmittedWorkDone()
      return (performance.now() - t0) / frames
    }
    return () => {
      perfProbe.bench = null
    }
  }, [gl, pipeline, scene, camera])

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
      // character style (cc0 default, the render placeholder as 'procedural'), staff, cast origin
      const ch = ins.createParameters('Character')
      ch.add(warlockParams, 'style', ['cc0', 'procedural'] as const)
      ch.add(warlockParams, 'staff')
      ch.add(warlockParams, 'staffVariant', ['gnarled', 'iron', 'bone'] as const)
      ch.add(warlockParams, 'castFrom', ['palm', 'staff'] as const)
      ch.add(tweakParams, 'showCollision')
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
    u.hurt.value = Math.min(0.8, postState.hurt) * Math.max(0.3, fx)
    const size = state.size
    u.aspect.value = size.width / Math.max(1, size.height)
    pipeline.render()

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
          if (typeof ms !== 'number' || ms <= 0) return
          renderStats.gpuMsRaw = ms
          // a GPU frame cannot take longer than the frame interval unless the
          // per-pass timestamps overlap (tile-based GPUs): reject those
          renderStats.gpuMs = ms <= renderStats.frameMs * 1.1 ? ms : -1
        })
        .catch(() => {})
        .finally(() => {
          p.pending = false
        })
    }
  }, 1)

  return null
}
