import * as THREE from 'three/webgpu'
import { exp, float, length, max, min, mix, mrt, saturate, sin, smoothstep, step, texture, vec2, vec3, vec4 } from 'three/tsl'
import { S } from '../coords'
import type { Node } from 'three/webgpu'
import { loadSurface, type SurfaceMaps } from './textures'
import { gamePos, type WorldCtx } from './world'

/**
 * Hero visual: a lava sea under the platform. Flowing domain-warped crust
 * plates (worley edges from the shared noise texture) split by hot cracks
 * that feed bloom; the shore along the platform runs hotter, with a molten
 * rim right at the tile edge. Unlit (emissive only), so cost is a handful of
 * texture taps per pixel.
 */
export class Lava {
  readonly mesh: THREE.Mesh
  private material: THREE.MeshBasicNodeMaterial

  private disposed = false

  constructor(
    private ctx: WorldCtx,
    size = 16000,
  ) {
    this.material = this.buildMaterial(null)
    const geo = new THREE.PlaneGeometry(size * S, size * S, 1, 1)
    geo.rotateX(-Math.PI / 2)
    this.mesh = new THREE.Mesh(geo, this.material)
    this.mesh.name = 'Lava'
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = -10
    // authored cooled-crust texture (shared/lava_crust) replaces the flat crust tint
    void loadSurface('shared', 'lava_crust', ctx.tier.anisotropy).then((m) => {
      if (!m || this.disposed) return
      const old = this.material
      this.material = this.buildMaterial(m)
      this.mesh.material = this.material
      old.dispose()
    })
  }

  private buildMaterial(crustMaps: SurfaceMaps | null): THREE.MeshBasicNodeMaterial {
    const { uTime: t, noise, field, tier } = this.ctx
    const p = gamePos()

    // slow large-scale flow field and warp
    const n0 = texture(noise, p.mul(1 / 5200).add(vec2(t.mul(0.0035), t.mul(-0.0025))))
    const n1 = texture(noise, p.mul(1 / 2300).add(vec2(t.mul(-0.006), t.mul(0.004))))
    const warp = n0.rg.sub(0.5).mul(0.55).add(n1.gr.sub(0.5).mul(0.25))
    const heat = saturate(n0.r.mul(0.6).add(n1.g.mul(0.6)).sub(0.25))

    // crust plates and cracks
    const uvA = p.mul(1 / 1250).add(warp).add(vec2(t.mul(0.009), t.mul(0.005)))
    const cA = texture(noise, uvA)
    const sd = field.sample(p)
    const shore = exp(max(sd, 0).div(-170))
    const crackW = float(0.028).add(heat.mul(0.045)).add(shore.mul(0.05))
    const crackA = float(1).sub(smoothstep(0, crackW, cA.b))
    let cracks = crackA
    if (tier.lavaDetail) {
      const uvB = p.mul(1 / 520).add(warp.mul(0.7)).add(vec2(t.mul(-0.015), t.mul(0.011)))
      const cB = texture(noise, uvB)
      const crackB = float(1).sub(smoothstep(0, crackW.mul(0.6), cB.b)).mul(0.45)
      cracks = max(crackA, crackB.mul(heat.add(0.35)))
    }

    // plates glow toward their rims, core stays cool and dark
    const plateEdge = smoothstep(0.15, 0.85, cA.a)
    const molten = saturate(heat.mul(heat).mul(heat).mul(1.3).add(shore.mul(0.3)))
    let crust: Node<'vec3'> = mix(vec3(0.014, 0.004, 0.003), vec3(0.11, 0.02, 0.007), saturate(plateEdge.mul(0.45).add(molten.mul(0.6))))
    if (crustMaps) {
      // cooled basalt plates drifting with the flow, lit from within near their rims
      const uvC = p.mul(1 / 640).add(warp.mul(0.35)).add(vec2(t.mul(0.007), t.mul(0.004)))
      const alb = texture(crustMaps.albedo, uvC).rgb
      const glowRim = saturate(plateEdge.mul(0.45).add(molten.mul(0.6)))
      crust = alb.mul(vec3(0.16, 0.1, 0.085)).add(vec3(0.11, 0.02, 0.007).mul(glowRim))
    }
    const hot = mix(vec3(1.25, 0.24, 0.035), vec3(3.4, 1.35, 0.32), saturate(cracks.mul(molten).mul(1.4).add(shore.mul(0.25))))
    const k = saturate(cracks.mul(0.95).add(molten.mul(0.28)))
    let col = mix(crust, hot, k)

    // slow breathing, out of phase across the sea
    col = col.mul(sin(t.mul(1.1).add(heat.mul(9))).mul(0.12).add(0.9))

    // molten rim against the platform, and hot seams under the tiles
    const rim = exp(max(sd, 0).div(-26)).mul(step(-12, sd))
    col = col.add(vec3(1.9, 0.5, 0.07).mul(rim.mul(0.75)))
    // under the platform only thin seams show: keep them a dull ember red
    const under = smoothstep(-20, -70, sd)
    col = mix(col, vec3(0.14, 0.028, 0.006), under)

    // frame the arena: crust thickens far from the centre
    const far = smoothstep(2600, 6200, length(p))
    col = mix(col, col.mul(0.28), far)
    col = min(col, vec3(12))

    const m = new THREE.MeshBasicNodeMaterial()
    m.colorNode = col
    m.name = 'Lava'
    if (tier.heatHaze) {
      // heat haze strength for the post pass: strongest along the shore
      const heatAmt = saturate(float(0.3).add(exp(max(sd, 0).div(-260)).mul(0.7))).mul(float(1).sub(far.mul(0.7)))
      m.mrtNode = mrt({ heat: vec4(heatAmt, 0, 0, 1) })
    }
    return m
  }

  dispose(): void {
    this.disposed = true
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
