/**
 * Boomerang (column 1, Knockout; identity red-copper). spells.md §8.5.
 *
 * A physical weapon, not a fire bolt: it must read apart from Fireball by
 * shape and motion alone (grayscale test).
 * - signature windup: the steel glaive itself forms in the hand, spinning up
 * - flight: a solid three-pronged steel glaive (extruded mesh, lit metal that
 *   catches the moonlight, red-copper glowing cutting edges) spinning fast and
 *   flat, tips exactly on the collision radius (38); a faint spin-blur disc
 *   and thin cutting-arc streaks behind each tip; metallic glints flashing
 *   off the tips; a crisp flat red-copper ribbon tracing the curved path
 *   (no flame, no glow ball); floor light + shadow
 * - return mode: the predicted path back to the thrower as a dashed guide
 * - hit: kb-scaled steel-on-flesh burst + slash streaks across the cut;
 *   'projectileBounce' (pawn / pillar): clang (white-hot sparks, star glint,
 *   ring) as it flips into return mode
 * - catch: the glaive snaps into the hand, implode ring
 */
import * as THREE from 'three/webgpu'
import { float, length, positionGeometry, pow, smoothstep, varying, vec3 } from 'three/tsl'
import type { SimEvent, SimState } from '../../../sim/types'
import { S } from '../../coords'
import { RING_IMPLODE } from '../../scene/GroundFx'
import { registerSpellVfx, type PawnRenderInfo, type SpellVfx, type VfxCtx } from '../registry'
import { G_BLADE, G_SHOCK, PH, acquireKit, kflash, kring, palFor, pspawn, releaseKit, windupProgress, type KitA, type TrailStyle } from './kitA'
import { spellDeath } from './deathsA'

const P = palFor('boomerang')
let K: KitA | null = null
const o = { x: 0, y: 0, h: 0 }
const dir = { x: 0, y: 0 }
const last = new Map<number, { x: number; y: number }>()

/** crisp flat ribbon: thin translucent copper band with brighter copper edges (no flame) */
const RIBBON: TrailStyle = {
  life: 0.6,
  width: 46,
  widthTail: 0.3,
  head: [P.body[0] * 1.2, P.body[1] * 1.2, P.body[2] * 1.2],
  mid: [P.body[0] * 0.6, P.body[1] * 0.6, P.body[2] * 0.6],
  tail: P.edge,
  intensity: 0.75,
  falloff: 0.35,
  noise: 0,
  spacing: 8,
  rim: 0.9,
  flat: true,
  rimRGB: [P.body[0] * 3, P.body[1] * 3, P.body[2] * 3],
}

// ---------------------------------------------------------------- glaive mesh

const CAP = 24
let glaive: THREE.InstancedMesh | null = null
let nG = 0
const mtx = new THREE.Matrix4()
const pos = new THREE.Vector3()
const quat = new THREE.Quaternion()
const scl = new THREE.Vector3()
const euler = new THREE.Euler()
/** reused upload range of the glaive instance matrices */
const glaiveRange = { start: 0, count: 0 }

/** three hooked prongs around a hub ring, unit radius, flat on XZ */
function glaiveGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape()
  const N = 3
  const SEG = 44
  for (let k = 0; k < N * SEG; k++) {
    const th = (k / (N * SEG)) * Math.PI * 2
    const ph = (((th / ((Math.PI * 2) / N)) % 1) + 1) % 1
    // long curved leading edge out to a hooked tip, then a sharp concave cut back
    const f = ph < 0.8 ? Math.pow(ph / 0.8, 1.9) : Math.pow(1 - (ph - 0.8) / 0.2, 0.55)
    const r = 0.3 + 0.7 * f
    const x = Math.cos(th) * r
    const y = Math.sin(th) * r
    if (k === 0) shape.moveTo(x, y)
    else shape.lineTo(x, y)
  }
  shape.closePath()
  const hole = new THREE.Path()
  hole.absarc(0, 0, 0.12, 0, Math.PI * 2, true)
  shape.holes.push(hole)
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.06, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.02, bevelSegments: 2, curveSegments: 8 })
  g.translate(0, 0, -0.03)
  g.rotateX(-Math.PI / 2)
  g.computeVertexNormals()
  return g
}

function buildGlaive(ctx: VfxCtx): THREE.InstancedMesh {
  const m = new THREE.MeshStandardNodeMaterial()
  // brushed steel: metal enough to catch the moonlight, not a black mirror (no env map)
  m.color = new THREE.Color(0x5a5e68)
  m.metalness = 0.7
  m.roughness = 0.3
  // copper-hot cutting edges from the palette, a faint hub ring
  const rg = varying(length(positionGeometry.xz))
  const edge = smoothstep(0.8, 0.995, rg)
  const hub = smoothstep(0.2, 0.12, rg)
  m.emissiveNode = vec3(P.body[0], P.body[1], P.body[2]).mul(edge.mul(2.6)).add(vec3(P.hot[0], P.hot[1], P.hot[2]).mul(pow(edge, float(4)).mul(1.4))).add(vec3(P.edge[0], P.edge[1], P.edge[2]).mul(hub))
  m.name = 'Boomerang-Glaive'
  const mesh = new THREE.InstancedMesh(glaiveGeometry(), m, CAP)
  mesh.count = 0
  mesh.frustumCulled = false
  // static + ranged uploads (a dynamic attribute is re-uploaded in full every frame on WebGPU)
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
  mesh.name = 'vfxA-boomerang-glaive'
  ctx.scene.add(mesh)
  return mesh
}

function addGlaive(x: number, y: number, h: number, radius: number, spin: number, tilt: number): void {
  if (!glaive || nG >= CAP) return
  pos.set(x * S, h * S, -y * S)
  euler.set(tilt, spin, 0, 'YXZ')
  quat.setFromEuler(euler)
  scl.setScalar(radius * S)
  mtx.compose(pos, quat, scl)
  glaive.setMatrixAt(nG++, mtx)
  glaive.count = nG
  const im = glaive.instanceMatrix
  im.updateRanges.length = 0
  im.updateRanges.push(glaiveRange)
  glaiveRange.count = nG * 16
  im.needsUpdate = true
}

/** signature charge-up: the steel glaive forms in the hand, spinning up */
function signature(k: KitA, ctx: VfxCtx, _info: PawnRenderInfo, _id: number, _tx: number, _ty: number, w: number): void {
  const now = ctx.now
  const r = 38 * (0.3 + 0.7 * w)
  const spin = now * (6 + 24 * w)
  addGlaive(o.x, o.y, o.h + 10, r, spin, 0.25)
  k.air.add(G_BLADE, o.x, o.y, o.h + 9, r * 1.04, spin, P.body[0], P.body[1], P.body[2], 0.25 * w, 1, 3)
}

/** spin sweep: a bright motion-blur arc behind each tip on the tip circle, rim, glints */
function spinFx(k: KitA, x: number, y: number, h: number, r: number, spin: number, fl: number): void {
  // motion-blur rim on the tip circle + a ground glint ring under the blade
  k.air.add(G_SHOCK, x, y, h - 1, r, 0, P.body[0], P.body[1], P.body[2], 0.75, 0.97, 0.03)
  k.ground.add(G_SHOCK, x, y, fl + 1.5, r * 0.95, 0, P.body[0], P.body[1], P.body[2], 0.45, 0.9, 0.06)
  for (let t = 0; t < 3; t++) {
    // tips sit at the prong peaks (ph 0.8 of each third); a +y rotation by `spin` turns the mesh CCW in game space
    const tip = (t / 3) * Math.PI * 2 + 0.8 * ((Math.PI * 2) / 3) + spin
    // sweep: bright at the tip, fading over ~100 degrees behind it (a third of a turn = one blade gap)
    k.stripBegin(true, 1.6, 0, 0)
    for (let i = 0; i <= 10; i++) {
      const a = tip - (i / 10) * 1.75
      const f = 1 - i / 10
      k.stripPoint(x + Math.cos(a) * r * 0.93, y + Math.sin(a) * r * 0.93, h + 1, 4 + 9 * f, P.hot[0] * 0.5 + P.body[0] * 0.8, P.hot[1] * 0.5 + P.body[1] * 0.8, P.hot[2] * 0.5 + P.body[2] * 0.8, 1.5 * f * f)
    }
    k.stripEnd()
    // specular: a thin highlight sliding along the edge while a tip passes the key light
    // (moon from the camera's left-back), plus a tiny short star at the exact alignment
    const d = Math.atan2(Math.sin(tip - 2.4), Math.cos(tip - 2.4))
    if (Math.abs(d) < 0.5) {
      const a = 1 - Math.abs(d) / 0.5
      k.stripBegin(true, 2.6, 0, 0)
      for (let i = 0; i <= 4; i++) {
        const ang = tip - 0.05 - (i / 4) * 0.35
        const f = Math.sin((i / 4) * Math.PI)
        k.stripPoint(x + Math.cos(ang) * r * 0.97, y + Math.sin(ang) * r * 0.97, h + 2, 3, 2.2, 2.1, 2.0, 0.9 * a * f)
      }
      k.stripEnd()
      if (Math.abs(d) < 0.08) {
        const gx = x + Math.cos(tip) * r
        const gy = y + Math.sin(tip) * r
        const st = 1 - Math.abs(d) / 0.08
        k.bbStreak(gx * S, (h + 3) * S, -gy * S, 12 * S, 2.2, 0.3, 1.2 * st, 1.15 * st, 1.1 * st, 3)
      }
    }
  }
}

function clang(k: KitA, ctx: VfxCtx, x: number, y: number, h: number): void {
  const ps = ctx.particles
  const n = ps.budget(22)
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2
    const sp = 500 + Math.random() * 800
    pspawn(ps, x, y, h, Math.cos(a) * sp, Math.sin(a) * sp, 80 + Math.random() * 300, 0.12 + Math.random() * 0.16, 5, 1, 4.2, 3.9, 3.4, -1500, 3, -0.16)
  }
  const nc = ps.budget(10)
  for (let i = 0; i < nc; i++) {
    const a = Math.random() * Math.PI * 2
    const sp = 200 + Math.random() * 400
    pspawn(ps, x, y, h, Math.cos(a) * sp, Math.sin(a) * sp, 150 + Math.random() * 200, 0.3 + Math.random() * 0.2, 7, 2, P.spark[0], P.spark[1], P.spark[2], -1500, 1.5, -0.06)
  }
  // star glint
  k.pulse(G_SHOCK, true, x, y, h, 50, 70, 0.18, 0, 0, P.hot, 1.2, 0.3, 0.95, 0.08)
  kflash(ctx, x, y, h, 0.08, 130, 70, 2.2, 2.1, 2.0)
  k.pulse(G_SHOCK, false, x, y, k.floor(x, y) + 1.5, 60, 60, 0.25, 0, 0, P.body, 0.8, 0.15, 0.95, 0.12)
  ctx.shakeNear(x, y, 0.08)
}

const mod: SpellVfx = {
  spell: 'boomerang',
  init(ctx) {
    K = acquireKit(ctx)
    glaive = buildGlaive(ctx)
  },
  // our signature occupies the palm: keep render's arm rings + ground ring, drop its palm orb
  windupStyle: () => ({ hide: ['orb'] }),
  dispose() {
    if (glaive) {
      glaive.parent?.remove(glaive)
      glaive.geometry.dispose()
      ;(glaive.material as THREE.Material).dispose()
      glaive.dispose()
      glaive = null
    }
    releaseKit(K)
    K = null
    last.clear()
  },

  onEvent(e: SimEvent, ctx) {
    const k = K
    if (!k) return
    switch (e.type) {
      case 'castStart':
        if (e.spell === 'boomerang') k.windupTotal.set(e.pawn, e.ticks)
        return
      case 'cast': {
        if (e.spell !== 'boomerang') return
        const info = ctx.pawn(e.pawn)
        if (!info) return
        k.origin(info, o)
        const dx = e.x - info.x
        const dy = e.y - info.y
        const l = Math.hypot(dx, dy) || 1
        // a whip-crack release: thin sparks and a quick flash, no fireball muzzle
        const ps = ctx.particles
        const n = ps.budget(10)
        for (let i = 0; i < n; i++) {
          const a = Math.atan2(dy, dx) + (Math.random() - 0.5) * 1.4
          const sp = 400 + Math.random() * 500
          pspawn(ps, o.x, o.y, o.h, Math.cos(a) * sp, Math.sin(a) * sp, (Math.random() - 0.3) * 150, 0.12, 5, 1, P.spark[0], P.spark[1], P.spark[2], -900, 4, -0.14)
        }
        kflash(ctx, o.x, o.y, o.h, 0.08, 110, 50, P.body[0] * 0.8, P.body[1] * 0.8, P.body[2] * 0.8)
        void l
        k.levelFlash(o.x, o.y, o.h, k.tierOf(e), P, e.pawn)
        return
      }
      case 'damage': {
        const a = k.attributeDamage(e)
        if (!a || a.spell !== 'boomerang') return
        const v = ctx.pawn(e.target)
        const from = last.get(a.data)
        k.hitDir(ctx.state, e.target, from ? from.x : e.x - 1, from ? from.y : e.y, e.x, e.y, dir)
        const h = (v?.h ?? 30) + 55
        k.impact(e.x, e.y, h, e.kb, dir.x, dir.y, P, 0.85, a.tier)
        // slash: bright streaks across the cut, perpendicular to the push
        const ps = ctx.particles
        const n = ps.budget(12)
        for (let i = 0; i < n; i++) {
          const s = (Math.random() - 0.5) * 2
          const sp = 700 + Math.random() * 700
          pspawn(ps, e.x + dir.x * 10, e.y + dir.y * 10, h + (Math.random() - 0.5) * 30, -dir.y * sp * s, dir.x * sp * s, (Math.random() - 0.5) * 120, 0.12 + Math.random() * 0.08, 8, 1, 4.0, 3.8, 3.5, 0, 6, -0.16)
        }
        return true
      }
      case 'projectileBounce':
        if (e.spell !== 'boomerang') return
        clang(k, ctx, e.x, e.y, PH)
        return
      case 'projectileHit': {
        if (e.spell !== 'boomerang') return
        // caught by the thrower (or removed): snaps into the hand
        const pw = e.target === null ? nearestOwnerPawn(ctx.state, e.x, e.y) : null
        const info = pw !== null ? ctx.pawn(pw) : null
        if (info) {
          k.origin(info, o)
          const ps = ctx.particles
          const n = ps.budget(12)
          for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2
            const rr = 45 + Math.random() * 25
            const life = 0.12 + Math.random() * 0.05
            pspawn(ps, o.x + Math.cos(a) * rr, o.y + Math.sin(a) * rr, o.h, (-Math.cos(a) * rr) / life, (-Math.sin(a) * rr) / life, 0, life, 6, 2, P.spark[0], P.spark[1], P.spark[2], 0, 0, -0.05)
          }
          kflash(ctx, o.x, o.y, o.h, 0.1, 110, 60, P.body[0], P.body[1], P.body[2])
          k.teamRGB(info.owner)
          kring(ctx, RING_IMPLODE, info.x, info.y, k.floor(info.x, info.y), 10, 70, 0.22, 6, k.team[0] * 1.6, k.team[1] * 1.6, k.team[2] * 1.6)
        } else {
          clang(k, ctx, e.x, e.y, PH)
        }
        return
      }
      case 'death':
        if (e.cause !== 'boomerang') return
        return spellDeath(k, ctx, e)
      default:
        return
    }
  },

  frame(ctx) {
    const k = K
    const s = ctx.state
    // the glaive instances are immediate-mode too: rebuilt every update
    nG = 0
    if (glaive) glaive.count = 0
    if (!k || !s) return
    for (const p of s.pawns) {
      if (!p.alive || !p.cast || p.cast.spell !== 'boomerang' || p.cast.started === false) continue
      const info = ctx.pawn(p.id)
      if (!info) continue
      k.begin()
      k.origin(info, o)
      const w = windupProgress(k, ctx, p.id, p.cast.ticksLeft)
      k.windupAt(o.x, o.y, o.h, w, P, ctx.now, ctx.dt, p.id)
      signature(k, ctx, info, p.id, p.cast.x, p.cast.y, w)
    }
    // forget positions of blades that are gone
    if (last.size > 0) {
      for (const id of last.keys()) {
        let alive = false
        for (const q of s.projectiles) {
          if (q.id === id) {
            alive = true
            break
          }
        }
        if (!alive) last.delete(id)
      }
    }
  },

  drawProjectile(p, x, y, ctx) {
    const k = K
    if (!k) return
    k.begin()
    k.track(p, x, y)
    let l = last.get(p.id)
    if (!l) {
      l = { x, y }
      last.set(p.id, l)
    }
    l.x = x
    l.y = y
    const now = ctx.now
    const r = p.radius
    const spin = now * 30 + p.id * 1.3
    const returning = p.data.returning === 1
    // the steel glaive: tips on the collision radius, a slight bank so the top reads in 3D
    addGlaive(x, y, PH, r, spin, 0.12)
    spinFx(k, x, y, PH, r, spin, k.floor(x, y))
    ctx.glow.add(x, y, 150, 0.6, P.light[0], P.light[1], P.light[2])
    ctx.projectileShadow(x, y, PH, r)
    k.trailPoint(p.id * 16, x, y, PH - 4, RIBBON)
    {
      const sp = Math.hypot(p.vx, p.vy) || 1
      k.powerLayers(p.id * 16 + 15, x, y, PH - 4, P, k.tierOf(p), p.vx / sp, p.vy / sp, r)
    }
    // a few sparks thrown off the cutting edges
    const ps = ctx.particles
    const n = ps.budget(ctx.dt * 30)
    for (let i = 0; i < n; i++) {
      const a = spin + Math.floor(Math.random() * 3) * ((Math.PI * 2) / 3) + 0.8 * ((Math.PI * 2) / 3)
      const tx = Math.cos(a)
      const ty = Math.sin(a)
      const tv = 300 + Math.random() * 250
      pspawn(ps, x + tx * r, y + ty * r, PH, -ty * tv + p.vx * 0.3, tx * tv + p.vy * 0.3, 40 + Math.random() * 120, 0.14 + Math.random() * 0.12, 4, 1, 3.6, 3.2, 2.8, -900, 2.5, -0.1)
    }
    // return mode: dashed guide along the predicted homing path to the thrower
    if (returning) {
      const info = ctx.pawnOf(p.owner)
      if (info && info.alive) {
        k.teamRGB(p.owner)
        k.stripBegin(true, 1.8, 0.85, now * 4)
        let px = x
        let py = y
        let vx = p.vx
        let vy = p.vy
        const fl = k.floor(x, y) + 3
        const step = 1 / 30
        for (let i = 0; i < 26; i++) {
          const f = i / 25
          k.stripPoint(px, py, fl, 12 * (1 - f * 0.6), P.body[0], P.body[1], P.body[2], 0.42 * (1 - f) * Math.min(1, i / 2 + 0.3), k.team[0], k.team[1], k.team[2], 0.5)
          const tx = info.x - px
          const ty = info.y - py
          const d = Math.hypot(tx, ty)
          if (d < 75) break
          const ddx = (1000 * tx) / d - vx
          const ddy = (1000 * ty) / d - vy
          const dl = Math.hypot(ddx, ddy)
          if (dl > 0) {
            vx += (1000 * step * ddx) / dl
            vy += (1000 * step * ddy) / dl
          }
          px += vx * step
          py += vy * step
        }
        k.stripEnd()
      }
    }
  },
}

function nearestOwnerPawn(s: SimState | null, x: number, y: number): number | null {
  if (!s) return null
  let best: number | null = null
  let bd = 160
  for (const p of s.pawns) {
    const d = Math.hypot(p.x - x, p.y - y)
    if (p.alive && d < bd) {
      bd = d
      best = p.id
    }
  }
  return best
}

registerSpellVfx(mod)
