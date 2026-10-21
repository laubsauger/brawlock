import * as THREE from 'three/webgpu'
import { Fn, If, Loop, abs, atan, dot, exp, float, floor, fwidth, int, length, max, min, mix, mrt, saturate, sign, sin, smoothstep, step, texture, uniform, uniformArray, vec2, vec3, vec4 } from 'three/tsl'
import { S } from '../coords'
import type { Node } from 'three/webgpu'
import { TILE_SIZE } from '../arenaGeom'
import { TILE_HALF } from '../scale'
import { SINK_DROP, SINK_SWALLOW, SINK_SWEEP } from './Arena'
import { loadSurface, type SurfaceMaps } from './textures'
import { asV4, gamePos, type WorldCtx } from './world'

/** concurrent point splashes (lava deaths); the oldest is replaced when full */
export const SPLASH_N = 8
/** seconds from a body hitting the lava until the lava closes over it (Pawns' sink) */
export const SPLASH_GULP = 2.1
/**
 * Lava death: how deep (game units) the corpse's feet sit under the lava
 * surface `age` seconds after death. The melt buoys it near the surface, then
 * pulls it under (the collapsed body is ~40 units thick) so the lava closes
 * over it at SPLASH_GULP; the character itself does not sink.
 */
export function lavaDeathDepth(age: number): number {
  const s = Math.min(1, Math.max(0, age) / SPLASH_GULP)
  return 4 + 46 * Math.pow(s, 1.8) + 40 * Math.max(0, age - SPLASH_GULP)
}
/** a splash's whole life: splash, burn, gulp, then the crust re-forms */
const SPLASH_LIFE = SPLASH_GULP + 3.6
/** a shrink ring's lava reaction: last tile under + the crust re-forming */
const RING_LIFE = SINK_DROP + SINK_SWEEP + SINK_SWALLOW + 3.6

/** TSL twin of Arena.sinkDelay: sweep delay at a game-space point for a sweep start angle. */
function sweepDelay(q: Node<'vec2'>, sweep: Node<'float'>): Node<'float'> {
  const a = atan(q.y, q.x.add(1e-5)).sub(sweep)
  const w = a.div(Math.PI * 2).add(0.5).fract().mul(Math.PI * 2)
  return abs(w.sub(Math.PI)).div(Math.PI).mul(SINK_SWEEP)
}

/**
 * Hero visual: a lava sea under the platform. Flowing domain-warped crust
 * plates (worley edges from the shared noise texture) split by hot cracks
 * that feed bloom; the shore along the platform runs hotter, with a molten
 * rim right at the tile edge. Unlit (emissive only), so cost is a handful of
 * texture taps per pixel. It reacts to what sinks into it (shrink rings,
 * lava deaths) through a few uniforms: arithmetic only, plus (Low only) one
 * fine crack tap behind a uniform branch while a reaction is live.
 */
export class Lava {
  readonly mesh: THREE.Mesh
  private material: THREE.MeshBasicNodeMaterial

  private disposed = false

  /** point splashes: game x, y, start time, strength (fixed slots, shared by every material build) */
  private splashes = Array.from({ length: SPLASH_N }, () => new THREE.Vector4(0, 0, -100, 0))
  private splashNode = uniformArray(this.splashes, 'vec4')
  /** live splashes: the shader loop stops there */
  private splashCount = uniform(0, 'int')
  /**
   * Shrink rings: start time, old layer radius, new layer radius, sweep start
   * angle. Two slots: the next ring (>= 6 s later) may start while the last
   * one's crust is still re-forming.
   */
  private rings = [uniform(new THREE.Vector4(-100, 0, 0, 0)), uniform(new THREE.Vector4(-100, 0, 0, 0))]
  private ringSlot = 0
  /** 1 while any splash or ring reaction is live: Low samples its fine crack layer only then */
  private reacting = uniform(0)

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

  /** Something sank into the lava at game (x, y): splash, burn, gulp, crust re-forms. */
  splash(x: number, y: number, now: number, strength = 1): void {
    let slot = this.splashCount.value
    if (slot >= SPLASH_N) {
      // full: replace the oldest
      slot = 0
      for (let i = 1; i < SPLASH_N; i++) if (this.splashes[i].z < this.splashes[slot].z) slot = i
    } else {
      this.splashCount.value = slot + 1
    }
    this.splashes[slot].set(x, y, now, strength)
  }

  /** A tile ring (old layer radius r0 > new r1) sinks, sweeping from angle `sweep` (Arena.sinkDelay). */
  shrink(r0: number, r1: number, now: number, sweep: number): void {
    this.ringSlot = 1 - this.ringSlot
    this.rings[this.ringSlot].value.set(now, r0, r1, sweep)
  }

  /** Drop finished splashes (in place, live ones first). Once per frame. */
  update(now: number): void {
    let n = this.splashCount.value
    for (let i = 0; i < n; ) {
      if (now - this.splashes[i].z > SPLASH_LIFE) {
        n--
        this.splashes[i].copy(this.splashes[n])
        this.splashes[n].set(0, 0, -100, 0)
      } else i++
    }
    this.splashCount.value = n
    let live = n > 0
    for (const R of this.rings) {
      const a = now - R.value.x
      if (a >= 0 && a <= RING_LIFE) live = true
    }
    this.reacting.value = live ? 1 : 0
  }

  /**
   * Lava disturbance at game position p: (warp x, warp y, crust, pool).
   * warp shifts the crust pattern (ripples visibly push the plates); crust > 0
   * breaks it up (wider, hotter cracks), < 0 is fresh dark crust re-forming;
   * pool is molten glow (splash crests, the hole a body or slab went down).
   * `shape` (0..1 noise) makes the holes ragged instead of round.
   */
  private reaction(p: Node<'vec2'>, t: Node<'float'>, shape: Node<'float'>): Node<'vec4'> {
    const splashNode = this.splashNode
    const count = this.splashCount
    const rings = this.rings
    return Fn(() => {
      const warp = vec2(0, 0).toVar()
      const crust = float(0).toVar()
      const pool = float(0).toVar()

      // ---- point splashes (lava deaths)
      Loop({ start: int(0), end: count, type: 'int', condition: '<' }, ({ i }) => {
        const E = asV4(splashNode.element(i))
        const a = t.sub(E.z)
        const k = E.w
        const dv = p.sub(E.xy)
        const d = length(dv)
        const dir = dv.div(max(d, 1))
        // splash crown: two rings racing out and slowing, crest hot, trough dark
        const f1 = a.mul(340).div(a.mul(0.9).add(1)).add(20)
        const x1 = d.sub(f1).div(26)
        const x1b = x1.add(1.4)
        const r1 = exp(x1.mul(x1).negate()).sub(exp(x1b.mul(x1b).negate()).mul(0.6)).mul(exp(a.mul(-1.5)))
        const a2 = max(a.sub(0.28), 0)
        const f2 = a2.mul(240).div(a2.mul(0.9).add(1)).add(10)
        const x2 = d.sub(f2).div(20)
        const r2 = exp(x2.mul(x2).negate()).mul(exp(a2.mul(-1.8))).mul(step(0.28, a)).mul(0.6)
        const ripple = r1.add(r2).mul(k).mul(smoothstep(0, 0.03, a))
        // the hole the body thrashes in: molten while it burns, then the gulp
        // (a small ring as the lava closes over it, a last flare) and fresh
        // crust that cools dark before the flow erases it
        const g = a.sub(SPLASH_GULP)
        const dn = d.div(85)
        const core = exp(dn.mul(dn).negate()).mul(shape.mul(0.5).add(0.75))
        const burn = smoothstep(0, 0.12, a).mul(float(1).sub(smoothstep(0.4, SPLASH_GULP + 0.2, a)))
        const xg = d.sub(g.mul(170).add(12)).div(16)
        const gulp = exp(xg.mul(xg).negate()).mul(step(0, g)).mul(exp(g.mul(-2.2)))
        const flare = exp(g.mul(g).mul(-40))
        const reform = smoothstep(0.3, 1.1, g).mul(float(1).sub(smoothstep(1.4, 3.5, g)))
        const dw = d.div(170)
        warp.addAssign(dir.mul(ripple.add(gulp.mul(0.6)).mul(16)))
        // (deathKit already burns a fire ring around the body: the hole itself
        // stays a churning crust so the sinking silhouette still reads)
        crust.addAssign(exp(dw.mul(dw).negate()).mul(burn).mul(k).mul(0.6).sub(core.mul(reform).mul(0.9)))
        pool.addAssign(max(ripple, 0).mul(0.45).add(core.mul(burn.mul(0.1).add(flare.mul(0.8))).mul(k)).add(gulp.mul(0.8)))
      })

      // ---- shrink rings: per removed tile cell, plus a swell out across the sea
      for (const R of rings) {
        const rv = R as unknown as Node<'vec4'>
        const age = t.sub(rv.x)
        const live = step(0, age).mul(step(age, RING_LIFE))
        // the cell this pixel lies in, and whether its tile was in the ring
        // (sim rule: centre strictly inside the layer radius)
        const cell = floor(p.div(TILE_SIZE).add(0.5)).mul(TILE_SIZE)
        const ringAt = (c: Node<'vec2'>) => {
          const d2 = dot(c, c)
          return step(rv.z.mul(rv.z), d2).mul(step(d2, rv.y.mul(rv.y).sub(1)))
        }
        const inRing = ringAt(cell)
        // tile clock: 0 when its slow phase starts, SINK_SWALLOW when it is under
        const u = age.sub(SINK_DROP).sub(sweepDelay(cell, rv.w))
        const lp = p.sub(cell)
        const ld = length(lp)
        // the slab's own footprint: a rounded square with ragged edges (a
        // radial falloff read as a round blob where the tile went down). It
        // fades out inside the cell: inRing is a hard per-cell step, so any
        // term left at the cell border drew a straight-edged square.
        const cheb = max(abs(lp.x), abs(lp.y))
        const cellFade = float(1).sub(smoothstep(TILE_HALF * 0.6, TILE_HALF * 0.98, cheb))
        const jag = shape.sub(0.5).mul(30)
        const sq = mix(ld, cheb, 0.85).add(jag)
        const foot = float(1).sub(smoothstep(TILE_HALF * 0.45, TILE_HALF * 0.85, sq)).mul(cellFade)
        // the seething melt around the slab: falls off from the middle toward
        // cell sides that border the platform or open lava (a flat fill up to
        // the cell border read as a hot square), but runs on into a neighbour
        // that sank too, so a ring seethes as one band without seams
        const nx = ringAt(cell.add(vec2(sign(lp.x).mul(TILE_SIZE), 0)))
        const ny = ringAt(cell.add(vec2(0, sign(lp.y).mul(TILE_SIZE))))
        const fx = max(nx, float(1).sub(smoothstep(TILE_HALF * 0.2, TILE_HALF * 0.8, abs(lp.x).add(jag))))
        const fy = max(ny, float(1).sub(smoothstep(TILE_HALF * 0.2, TILE_HALF * 0.8, abs(lp.y).add(jag))))
        const around = fx.mul(fy)
        // the melt seethes around the slab while it goes down, the hole glows
        // as it closes, then a dark raft of fresh crust re-forms over it
        const seethe = smoothstep(0, SINK_SWALLOW * 0.5, u).mul(float(1).sub(smoothstep(SINK_SWALLOW, SINK_SWALLOW + 1.2, u)))
        const hole = smoothstep(SINK_SWALLOW * 0.75, SINK_SWALLOW, u).mul(float(1).sub(smoothstep(SINK_SWALLOW + 0.3, SINK_SWALLOW + 1.8, u)))
        const g = u.sub(SINK_SWALLOW * 0.92)
        // the gulp: the melt closes in over the slab's footprint from its
        // ragged edge (any clean ring, round or square, read as a drawn outline)
        const gR = float(1).sub(saturate(g.div(0.5))).mul(TILE_HALF * 0.85)
        const gulp = float(1).sub(smoothstep(gR.sub(24), gR.add(8), sq)).mul(step(0, g)).mul(float(1).sub(smoothstep(0.3, 0.5, g))).mul(cellFade)
        const reform = smoothstep(SINK_SWALLOW + 0.8, SINK_SWALLOW + 1.6, u).mul(float(1).sub(smoothstep(SINK_SWALLOW + 2, SINK_SWALLOW + 3.6, u)))
        const tile = inRing.mul(live)
        crust.addAssign(tile.mul(seethe.mul(around).mul(0.6).sub(foot.mul(reform).mul(0.8))))
        pool.addAssign(tile.mul(foot.mul(hole).mul(0.55).add(gulp.mul(0.7))))
        warp.addAssign(lp.div(max(ld, 1)).mul(gulp.mul(10)).mul(tile))
        // the sea answers: a thump as the ring drops, then a swell rolling out
        // as each part of the ring is swallowed (delayed by this pixel's angle)
        const rr = length(p)
        const out = rr.sub(rv.y).sub(TILE_HALF)
        const v = age.sub(SINK_DROP).sub(sweepDelay(p, rv.w)).sub(SINK_SWALLOW * 0.85)
        const xs = out.sub(v.mul(300)).div(45)
        const xsb = xs.add(1.5)
        const swell = exp(xs.mul(xs).negate()).sub(exp(xsb.mul(xsb).negate()).mul(0.55)).mul(step(0, v)).mul(exp(v.mul(-1.1)))
        const xt = out.sub(age.mul(520)).div(40)
        const thump = exp(xt.mul(xt).negate()).mul(exp(age.mul(-2.4))).mul(0.4)
        // uneven along the front: a swell, not a drawn circle
        const sea = swell.add(thump).mul(exp(max(out, 0).div(-700))).mul(step(-40, out)).mul(live).mul(shape.mul(1.2).add(0.3))
        warp.addAssign(p.div(max(rr, 1)).mul(sea.mul(14)))
        pool.addAssign(max(sea, 0).mul(0.25))
        crust.addAssign(min(sea, 0).mul(0.5))
      }
      return vec4(warp, crust, pool)
    })() as unknown as Node<'vec4'>
  }

  private buildMaterial(crustMaps: SurfaceMaps | null): THREE.MeshBasicNodeMaterial {
    const { uTime: t, noise, field, tier } = this.ctx
    const p = gamePos()

    // slow large-scale flow field and warp
    const n0 = texture(noise, p.mul(1 / 5200).add(vec2(t.mul(0.0035), t.mul(-0.0025))))
    const n1 = texture(noise, p.mul(1 / 2300).add(vec2(t.mul(-0.006), t.mul(0.004))))
    const warp = n0.rg.sub(0.5).mul(0.55).add(n1.gr.sub(0.5).mul(0.25))
    // things sinking in (shrink rings, lava deaths): ripples push the plates,
    // the crust breaks up hot, the holes glow, fresh crust re-forms dark
    const rx = this.reaction(p, t, n1.b)
    const pW = p.add(rx.xy)
    const broken = max(rx.z, 0)
    const fresh = saturate(rx.z.negate())
    // (a hole runs the lava's own pattern hotter: wide glowing cracks and
    // plate rims, not a flat disc of colour)
    const hole = saturate(rx.w)
    const heat = saturate(n0.r.mul(0.6).add(n1.g.mul(0.6)).sub(0.25).add(broken.mul(0.5)).add(hole.mul(0.6)).sub(fresh.mul(0.4)))

    // crust plates and cracks
    const uvA = pW.mul(1 / 1250).add(warp).add(vec2(t.mul(0.009), t.mul(0.005)))
    const cA = texture(noise, uvA)
    const sd = field.sample(p)
    const shore = exp(max(sd, 0).div(-170))
    // thinner cracks, antialiased: a crack thinner than a pixel widens by its
    // screen footprint and dims to match, so it no longer pops on and off
    // (bright sub-pixel lines flickered through bloom as the plates drift)
    const crackW = float(0.02).add(heat.mul(0.032)).add(shore.mul(0.035)).add(broken.mul(0.025)).add(hole.mul(0.07))
    const aaA = fwidth(cA.b)
    const crackA = float(1).sub(smoothstep(0, crackW.add(aaA), cA.b)).mul(crackW.div(crackW.add(aaA)))
    let cracks: Node<'float'> = crackA
    if (tier.lavaDetail) {
      const uvB = pW.mul(1 / 520).add(warp.mul(0.7)).add(vec2(t.mul(-0.015), t.mul(0.011)))
      const cB = texture(noise, uvB)
      const wB = crackW.mul(0.6)
      const aaB = fwidth(cB.b)
      const crackB = float(1).sub(smoothstep(0, wB.add(aaB), cB.b)).mul(wB.div(wB.add(aaB))).mul(0.45)
      cracks = max(crackA, crackB.mul(heat.add(0.35)))
    } else {
      // Low: the fine crack layer only where something sinks, so a hole breaks
      // up into the crack network as on High instead of a soft blob. The tap
      // sits behind a uniform branch: no cost while nothing reacts.
      const reacting = this.reacting
      const cBb = Fn(() => {
        const v = float(1).toVar()
        If(reacting.greaterThan(0.5), () => {
          const uvB = pW.mul(1 / 520).add(warp.mul(0.7)).add(vec2(t.mul(-0.015), t.mul(0.011)))
          v.assign(texture(noise, uvB).level(float(0)).b)
        })
        return v
      })() as unknown as Node<'float'>
      const wB = crackW.mul(0.6)
      const aaB = fwidth(cBb)
      const crackB = float(1).sub(smoothstep(0, wB.add(aaB), cBb)).mul(wB.div(wB.add(aaB))).mul(0.45)
      cracks = max(crackA, crackB.mul(heat.add(0.35)).mul(saturate(hole.mul(3).add(broken.mul(2)))))
    }
    // fresh crust has not split yet
    cracks = cracks.mul(float(1).sub(fresh.mul(0.8)))

    // plates glow toward their rims, core stays cool and dark
    const plateEdge = smoothstep(0.15, 0.85, cA.a)
    const molten = saturate(heat.mul(heat).mul(heat).mul(1.3).add(shore.mul(0.3)))
    let crust: Node<'vec3'> = mix(vec3(0.014, 0.004, 0.003), vec3(0.11, 0.02, 0.007), saturate(plateEdge.mul(0.45).add(molten.mul(0.6))))
    if (crustMaps) {
      // cooled basalt plates drifting with the flow, lit from within near their rims
      const uvC = pW.mul(1 / 640).add(warp.mul(0.35)).add(vec2(t.mul(0.007), t.mul(0.004)))
      const alb = texture(crustMaps.albedo, uvC).rgb
      const glowRim = saturate(plateEdge.mul(0.45).add(molten.mul(0.6)))
      crust = alb.mul(vec3(0.16, 0.1, 0.085)).add(vec3(0.11, 0.02, 0.007).mul(glowRim))
    }
    // crack peak kept below the cream-white range (was 3.4, 1.35, 0.32)
    const hot = mix(vec3(1.05, 0.2, 0.03), vec3(2.3, 0.8, 0.17), saturate(cracks.mul(molten).mul(1.4).add(shore.mul(0.25))))
    const k = saturate(cracks.mul(0.85).add(molten.mul(0.28)))
    let col = mix(crust, hot, k)

    if (tier.lavaDetail && this.ctx.motion) {
      // Existing Worley distance already gives rounded pockets. Let hot pockets swell,
      // develop a thin molten lip and collapse out of phase: no additional texture fetch,
      // geometry, particle pool or render pass. Low / reduced motion keep the quiet flow.
      const cycle = t.mul(0.23).add(cA.r.mul(3.7)).add(cA.g.mul(2.1)).fract()
      const radius = cycle.mul(0.32).add(0.035)
      const width = fwidth(cA.a).add(0.012)
      const lip = float(1).sub(smoothstep(0.012, width.add(0.012), abs(cA.a.sub(radius))))
      const life = smoothstep(0.04, 0.18, cycle).mul(float(1).sub(smoothstep(0.68, 0.92, cycle)))
      const pockets = smoothstep(0.5, 0.7, cA.g).mul(smoothstep(0.15, 0.5, heat.add(shore.mul(0.3))))
      const bubble = life.mul(pockets).mul(this.ctx.uFx)
      const dome = float(1).sub(smoothstep(0, radius, cA.a)).mul(bubble)
      col = col.mul(float(1).sub(dome.mul(0.15))).add(vec3(0.8, 0.17, 0.025).mul(lip.mul(bubble)))
    }

    // sink reaction: a soft molten glow over holes and ripple crests (the
    // rim's orange, never cream), fresh crust over a closed hole cools dark
    // (shaped by the crack pattern: a flat add read as a round blob on Low, with no bloom to soften it)
    col = col.add(vec3(0.7, 0.15, 0.022).mul(hole.mul(this.ctx.uFx.mul(0.4).add(0.6))).mul(cracks.mul(1.6).add(plateEdge.mul(0.3)).add(0.15)))
    col = col.mul(float(1).sub(fresh.mul(0.6)))

    // slow breathing, out of phase across the sea
    col = col.mul(sin(t.mul(1.1).add(heat.mul(9))).mul(0.12).add(0.9))

    // molten rim against the platform, and hot seams under the tiles
    const rim = exp(max(sd, 0).div(-26)).mul(step(-12, sd))
    col = col.add(vec3(1.9, 0.5, 0.07).mul(rim.mul(0.75)))
    // under the platform only thin seams show: keep them a dull ember red. Hot
    // lava only at a seam's mouth (the last few units), not 70 units in: the
    // seams near the shore flared as bright sub-pixel lines
    const under = smoothstep(-4, -28, sd)
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
