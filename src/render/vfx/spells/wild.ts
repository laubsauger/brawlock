/**
 * Wild (docs/moonshot/specs/wild.md): each omen's ambient layer and the reactions' flourish.
 * Scene effects only: the approved arena lighting is untouched (no sky, fog or light changes).
 * - Blood Moon: crimson motes drift down over the arena; every push throws red streaks
 * - Slick Stone: wet glints wink on the tiles; a sliding warlock throws a pale spray
 * - Overcharge: violet sparks crackle at every warlock's hands
 * - Sudden Collapse: grit and dust shake loose at the crumbling rim
 * - Meteor Shower: embers fall from the sky between the meteors
 * - Pillar Storm: dust motes rise from the floor (its warned spots: rockpillar.ts)
 * - Cursed Bomb: an iron bomb hovers over its holder, its cracks and fuse burning faster as the
 *   fuse runs; the blast's reach rings the floor in the last seconds; a pass throws a streak
 * - Gale: wind streaks and dust race across the arena with the wind
 * - Shuffle: the warlocks glow gold before they trade places (the exchange is Swap's look)
 * - Vengeful Spirits: pale wisps in their player's colour drift over the lava; their bolts are
 *   spectral (kind 'spiritBolt', a 'fireball' to the sim)
 * - Shatter / Nova / Fork / Clash: a flash and a ring where the spells met
 * Not a spell: the id 'wild' never appears on an event or projectile, so it claims nothing.
 */
import * as THREE from 'three/webgpu'
import { float, mix, normalView, positionView, pow, saturate, uniform, vec3 } from 'three/tsl'
import { layerRadius } from '../../../sim/arena'
import { BOMB_RADIUS, SHUFFLE_WARN, bombHolder, galeOf, type OmenId } from '../../../sim/wild'
import { TICK_HZ, type ProjectileState, type SimEvent, type SimState } from '../../../sim/types'
import { S, TILE_TOP_H } from '../../coords'
import { RING_EXPAND, RING_IMPLODE } from '../../scene/GroundFx'
import { registerSpellVfx, type VfxCtx } from '../registry'
import { TAU, floorH, hexRgb, rand } from './kitB'

type RGB = readonly [number, number, number]
const CRIMSON: RGB = [2.4, 0.22, 0.12]
const GLINT: RGB = [1.8, 2.4, 3.0]
const VIOLET: RGB = [1.5, 0.8, 2.8]
const GRIT: RGB = [0.16, 0.12, 0.09]
const EMBER: RGB = [2.6, 0.9, 0.2]
const DUST: RGB = [0.22, 0.18, 0.14]
const CURSE: RGB = [2.8, 0.35, 0.75]
const WIND: RGB = [0.9, 1.5, 1.35]
const GOLD: RGB = [2.6, 1.9, 0.6]
const SPECTRE: RGB = [0.75, 1.15, 2.6]
const REACTION: Record<string, RGB> = { shatter: [1.2, 2.0, 2.8], nova: [2.8, 1.1, 0.3], fork: [1.6, 1.5, 2.9], clash: [2.9, 1.5, 0.5] }
/** the bomb's centre over its holder's floor, above the name plate (game units) */
const BOMB_H = 330
const BOMB_R = 34
/** a spirit floats this high over the lava, bobbing */
const SPIRIT_H = 95

/** whole spawns this frame for a rate per second, scaled by the effects setting and tier budget */
function count(ctx: VfxCtx, perSecond: number, pool = ctx.particles): number {
  return pool.budget(perSecond * ctx.dt * ctx.fx)
}

/** a random point on the arena floor (or inside its rim band when `rim` is set) */
function spot(radius: number, rim = 0): { x: number; y: number } {
  const a = Math.random() * TAU
  const r = rim > 0 ? radius - Math.random() * rim : Math.sqrt(Math.random()) * radius
  return { x: Math.cos(a) * r, y: Math.sin(a) * r }
}

function ambient(ctx: VfxCtx, omen: OmenId, radius: number): void {
  const st = ctx.state!
  switch (omen) {
    case 'bloodMoon':
      for (let i = count(ctx, 70); i > 0; i--) {
        const p = spot(radius)
        ctx.particles.spawn(p.x, p.y, TILE_TOP_H + rand(250, 650), rand(-25, 25), rand(-25, 25), rand(-110, -60), rand(2.5, 4), rand(14, 22), 4, CRIMSON[0], CRIMSON[1], CRIMSON[2], 0, 0.1, 30)
      }
      break
    case 'slickStone':
      for (let i = count(ctx, 150); i > 0; i--) {
        const p = spot(radius)
        ctx.particles.spawn(p.x, p.y, TILE_TOP_H + 16, 0, 0, 12, rand(0.35, 0.7), rand(24, 36), 6, GLINT[0], GLINT[1], GLINT[2], 0, 0.5, 0)
      }
      for (const pw of st.pawns) {
        if (!pw.alive) continue
        const sx = pw.vx - pw.walkVx
        const sy = pw.vy - pw.walkVy
        const sp = Math.hypot(sx, sy)
        if (sp < 260) continue
        for (let i = count(ctx, 50 + sp / 12); i > 0; i--) {
          ctx.particles.spawn(pw.x + rand(-20, 20), pw.y + rand(-20, 20), TILE_TOP_H + 4, -sx * 0.25 + rand(-60, 60), -sy * 0.25 + rand(-60, 60), rand(60, 160), rand(0.3, 0.5), rand(12, 18), 4, GLINT[0] * 0.7, GLINT[1] * 0.7, GLINT[2] * 0.7, -900, 1.5, -0.02)
        }
      }
      break
    case 'overcharge':
      for (const pw of st.pawns) {
        if (!pw.alive) continue
        const info = ctx.pawn(pw.id)
        if (!info) continue
        for (let i = count(ctx, 45); i > 0; i--) {
          const a = Math.random() * TAU
          ctx.particles.spawn(info.x + Math.cos(a) * 28, info.y + Math.sin(a) * 28, info.h + rand(50, 130), Math.cos(a) * rand(80, 200), Math.sin(a) * rand(80, 200), rand(40, 200), rand(0.18, 0.32), rand(10, 15), 3, VIOLET[0], VIOLET[1], VIOLET[2], -400, 3, -0.03)
        }
      }
      break
    case 'suddenCollapse':
      for (let i = count(ctx, 70, ctx.debris); i > 0; i--) {
        const p = spot(radius, 90)
        ctx.debris.spawn(p.x, p.y, TILE_TOP_H + rand(2, 12), 0, 0, rand(120, 280), rand(0.5, 0.8), rand(9, 15), 5, GRIT[0], GRIT[1], GRIT[2], -1500, 0, 0)
      }
      for (let i = count(ctx, 14, ctx.smoke); i > 0; i--) {
        const p = spot(radius, 60)
        ctx.smoke.spawn(p.x, p.y, TILE_TOP_H + 8, 0, 0, rand(20, 50), rand(1, 1.6), 30, 70, DUST[0], DUST[1], DUST[2], -5, 1.5, 0)
      }
      break
    case 'meteorShower':
      for (let i = count(ctx, 45); i > 0; i--) {
        const p = spot(radius * 1.1)
        ctx.particles.spawn(p.x, p.y, TILE_TOP_H + rand(700, 1100), rand(-140, -60), rand(-60, 60), rand(-800, -550), rand(1.2, 1.8), rand(14, 20), 6, EMBER[0], EMBER[1], EMBER[2], -300, 0, -0.04)
      }
      break
    case 'pillarStorm':
      for (let i = count(ctx, 22, ctx.smoke); i > 0; i--) {
        const p = spot(radius)
        ctx.smoke.spawn(p.x, p.y, TILE_TOP_H + 6, rand(-10, 10), rand(-10, 10), rand(25, 60), rand(1.4, 2.2), 30, 80, DUST[0], DUST[1], DUST[2], 0, 1, 20)
      }
      break
    case 'gale':
      gale(ctx, st, radius)
      break
    case 'shuffle':
      shuffleGlow(ctx, st)
      break
    // the bomb and the spirits draw every frame of the fight, below
    default:
      break
  }
}

/** Gale: long streaks racing downwind at warlock height, and dust skimming the floor. */
function gale(ctx: VfxCtx, st: SimState, radius: number): void {
  const w = galeOf(st)
  if (!w) return
  const speed = 520 + 260 * w.strength
  for (let i = count(ctx, 140 * w.strength); i > 0; i--) {
    const p = spot(radius * 1.15)
    // start upwind of the spot so the streak crosses it
    const x = p.x - w.x * rand(100, 400)
    const y = p.y - w.y * rand(100, 400)
    ctx.particles.spawn(x, y, TILE_TOP_H + rand(30, 260), w.x * speed + rand(-30, 30), w.y * speed + rand(-30, 30), rand(-10, 10), rand(0.6, 1.1), rand(10, 16), 6, WIND[0], WIND[1], WIND[2], 0, 0, -0.45)
  }
  for (let i = count(ctx, 26 * w.strength, ctx.smoke); i > 0; i--) {
    const p = spot(radius)
    ctx.smoke.spawn(p.x, p.y, TILE_TOP_H + 6, w.x * speed * 0.45, w.y * speed * 0.45, rand(5, 25), rand(0.9, 1.4), 20, 60, DUST[0], DUST[1], DUST[2], 0, 0.6, 0)
  }
}

/** Shuffle: in the warning, every warlock glows gold and sparkles rise off them. */
function shuffleGlow(ctx: VfxCtx, st: SimState): void {
  const left = st.omenClock?.shuffleNext
  if (left === undefined || left > SHUFFLE_WARN * TICK_HZ || st.phase !== 'fight') return
  const k = 1 - left / (SHUFFLE_WARN * TICK_HZ)
  for (const pw of st.pawns) {
    if (!pw.alive) continue
    const info = ctx.pawn(pw.id)
    if (!info) continue
    const pulse = 0.6 + 0.4 * Math.sin(ctx.now * 18)
    ctx.billboards.add(info.x * S, (info.h + 70) * S, -info.y * S, (0.9 + 0.6 * k) * pulse, GOLD[0] * 0.5, GOLD[1] * 0.5, GOLD[2] * 0.5, 2.5)
    ctx.glow.add(info.x, info.y, 120 + 60 * k, 0.8 * k, GOLD[0], GOLD[1], GOLD[2])
    for (let i = count(ctx, 40 + 60 * k); i > 0; i--) {
      const a = Math.random() * TAU
      ctx.particles.spawn(info.x + Math.cos(a) * 32, info.y + Math.sin(a) * 32, info.h + rand(10, 60), 0, 0, rand(180, 360), rand(0.35, 0.6), rand(8, 12), 2, GOLD[0], GOLD[1], GOLD[2], -200, 1, -0.03)
    }
  }
}

// ---------------------------------------------------------------------------
// Cursed Bomb
// ---------------------------------------------------------------------------

let bomb: THREE.Group | null = null
const uHeat = uniform(0)
/** where the bomb is drawn (game units), eased toward its holder so a pass reads as a throw */
const bombAt = { x: 0, y: 0, h: 0, on: false, holder: -1, flying: 0 }
let ringClock = 0

function buildBomb(ctx: VfxCtx): THREE.Group {
  const g = new THREE.Group()
  g.name = 'wild-cursed-bomb'
  const iron = new THREE.MeshStandardNodeMaterial()
  iron.color = new THREE.Color(0x2a2226)
  iron.metalness = 0.6
  iron.roughness = 0.38
  // dark iron with a thin rim of cursed fire that brightens and pulses with the fuse (uHeat 0..1)
  const rim = pow(float(1).sub(saturate(normalView.dot(positionView.normalize().negate()))), float(3.5))
  iron.emissiveNode = mix(vec3(0.35, 0.03, 0.09), vec3(CURSE[0], CURSE[1], CURSE[2]), uHeat).mul(rim.mul(float(0.25).add(uHeat.mul(1.2))))
  iron.name = 'Wild-CursedBomb'
  const body = new THREE.Mesh(new THREE.SphereGeometry(BOMB_R * S, 28, 18), iron)
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(BOMB_R * 0.32 * S, BOMB_R * 0.38 * S, BOMB_R * 0.36 * S, 16), iron)
  cap.position.y = BOMB_R * 0.92 * S
  g.add(body, cap)
  g.visible = false
  ctx.scene.add(g)
  return g
}

function drawBomb(ctx: VfxCtx, st: SimState): void {
  const g = bomb
  if (!g) return
  const holder = st.phase === 'fight' ? bombHolder(st) : null
  const info = holder !== null ? ctx.pawnOf(holder) : null
  const clock = st.omenClock?.bomb
  if (holder === null || !info || !clock) {
    g.visible = false
    bombAt.on = false
    bombAt.holder = -1
    return
  }
  const share = clock.full > 0 ? clock.fuse / clock.full : 0
  const tx = info.x
  const ty = info.y
  const th = info.h + BOMB_H
  if (!bombAt.on) {
    bombAt.x = tx
    bombAt.y = ty
    bombAt.h = th
  } else if (bombAt.holder !== holder) {
    bombAt.flying = 0.18
  }
  bombAt.on = true
  bombAt.holder = holder
  // a pass flies the bomb over in an arc; otherwise it rides its holder
  if (bombAt.flying > 0 && ctx.dt > 0) {
    const k = Math.min(1, ctx.dt / bombAt.flying)
    bombAt.flying = Math.max(0, bombAt.flying - ctx.dt)
    bombAt.x += (tx - bombAt.x) * k
    bombAt.y += (ty - bombAt.y) * k
    bombAt.h += (th + 60 * (bombAt.flying / 0.18) - bombAt.h) * k
  } else {
    bombAt.x = tx
    bombAt.y = ty
    bombAt.h = th
  }
  const rate = 1.2 + 9 * (1 - share)
  const beat = 0.5 + 0.5 * Math.sin(ctx.now * rate * TAU)
  uHeat.value = Math.min(1, (1 - share) * 0.8 + beat * 0.35)
  const bob = Math.sin(ctx.now * 3.1) * 6
  g.visible = true
  g.position.set(bombAt.x * S, (bombAt.h + bob) * S, -bombAt.y * S)
  g.rotation.y += ctx.dt * (0.6 + 2 * (1 - share))
  g.scale.setScalar(1 + 0.08 * beat * (1 - share))
  // the fuse: a spark and its sparks, sputtering harder as it burns down
  const fh = bombAt.h + bob + BOMB_R * 1.15
  ctx.billboards.add(bombAt.x * S, fh * S, -bombAt.y * S, 0.22 + 0.18 * beat, CURSE[0], CURSE[1] * 1.6, CURSE[2], 1.6, 1)
  for (let i = count(ctx, 30 + 90 * (1 - share)); i > 0; i--) {
    ctx.particles.spawn(bombAt.x, bombAt.y, fh, rand(-90, 90), rand(-90, 90), rand(60, 220), rand(0.2, 0.4), rand(5, 8), 1.5, 2.8, 1.4, 0.4, -700, 1, -0.04)
  }
  ctx.glow.add(info.x, info.y, 110, 0.5 + 0.8 * (1 - share), CURSE[0], CURSE[1], CURSE[2])
  // the blast's reach on the floor in the last seconds, quicker as it nears
  const left = clock.fuse / TICK_HZ
  if (left < 3.5 && ctx.dt > 0) {
    ringClock -= ctx.dt
    if (ringClock <= 0) {
      ringClock = 0.25 + 0.35 * (left / 3.5)
      const fh0 = floorH(ctx, info.x, info.y)
      ctx.ground.spawn(RING_IMPLODE, info.x, info.y, fh0, BOMB_RADIUS, 40, 0.45, 8, CURSE[0], CURSE[1], CURSE[2])
    }
  }
}

function bombEvent(e: SimEvent & { type: 'bomb' }, ctx: VfxCtx): void {
  const fh = floorH(ctx, e.x, e.y)
  if (e.action === 'arm') {
    ctx.flash(e.x, e.y, fh + BOMB_H, 0.3, 140, 160, CURSE[0], CURSE[1], CURSE[2])
    ctx.ground.spawn(RING_IMPLODE, e.x, e.y, fh, 160, 30, 0.4, 8, CURSE[0], CURSE[1], CURSE[2])
    bombAt.on = false
    return
  }
  if (e.action === 'pass') {
    const from = e.from !== null ? ctx.pawnOf(e.from) : null
    if (from) {
      // a streak of cursed sparks along the throw
      const dx = e.x - from.x
      const dy = e.y - from.y
      for (let i = ctx.particles.budget(18 * ctx.fx); i > 0; i--) {
        const t = Math.random()
        ctx.particles.spawn(from.x + dx * t, from.y + dy * t, from.h + BOMB_H + Math.sin(t * Math.PI) * 60, rand(-40, 40), rand(-40, 40), rand(0, 80), rand(0.25, 0.45), rand(8, 12), 2, CURSE[0], CURSE[1], CURSE[2], -300, 2, -0.03)
      }
    }
    ctx.flash(e.x, e.y, fh + BOMB_H, 0.18, 110, 120, CURSE[0], CURSE[1], CURSE[2])
    return
  }
  // the blast itself is its explosion event (a Meteor's impact at the bomb's reach)
  ctx.aoeRing(e.x, e.y, BOMB_RADIUS, CURSE[0], CURSE[1], CURSE[2], 0.7)
  ctx.shakeNear(e.x, e.y, 0.55)
  bombAt.on = false
}

// ---------------------------------------------------------------------------
// Vengeful Spirits
// ---------------------------------------------------------------------------

const tint: [number, number, number] = [0, 0, 0]

function drawSpirits(ctx: VfxCtx, st: SimState): void {
  if (st.phase !== 'fight' && st.phase !== 'roundEnd') return
  for (const pw of st.pawns) {
    const sp = pw.spirit
    if (!sp || pw.alive) continue
    const prev = ctx.prev?.pawns.find((q) => q.id === pw.id)?.spirit
    const x = prev ? prev.x + (sp.x - prev.x) * ctx.alpha : sp.x
    const y = prev ? prev.y + (sp.y - prev.y) * ctx.alpha : sp.y
    const lava = floorH(ctx, x, y)
    hexRgb(ctx.colorOf(pw.owner), tint)
    // spectral blue with a share of the player's colour, so you can tell whose spirit it is
    const r = SPECTRE[0] * 0.6 + tint[0] * 0.9
    const g = SPECTRE[1] * 0.6 + tint[1] * 0.9
    const b = SPECTRE[2] * 0.6 + tint[2] * 0.9
    if (sp.rise > 0) {
      // rising: a column of pale wisps out of the lava where they fell
      for (let i = count(ctx, 90); i > 0; i--) {
        ctx.smoke.spawn(x + rand(-25, 25), y + rand(-25, 25), lava + 5, 0, 0, rand(80, 180), rand(0.6, 1), 20, 50, r * 0.25, g * 0.25, b * 0.25, 0, 1, 10)
      }
      continue
    }
    const h = lava + SPIRIT_H + Math.sin(ctx.now * 2.4 + pw.id) * 14
    const ready = sp.cd <= 0
    // a hooded shape out of glow: halo, head, a body that thins into a tail, two eyes
    ctx.billboards.add(x * S, h * S, -y * S, ready ? 1.25 : 1, r * 0.45, g * 0.45, b * 0.45, 2.6)
    ctx.billboards.add(x * S, (h + 22) * S, -y * S, 0.5, r * 1.3 + 0.5, g * 1.3 + 0.5, b * 1.3 + 0.5, 1.6, 1)
    ctx.billboards.add(x * S, (h - 18) * S, -y * S, 0.55, r * 0.9, g * 0.9, b * 0.9, 1.8)
    ctx.billboards.add(x * S, (h - 52) * S, -y * S, 0.36, r * 0.6, g * 0.6, b * 0.6, 2)
    const ex = Math.cos(sp.facing)
    const ey = Math.sin(sp.facing)
    for (const side of [-1, 1]) {
      const ox = x + ex * 8 - ey * side * 7
      const oy = y + ey * 8 + ex * side * 7
      ctx.billboards.add(ox * S, (h + 24) * S, -oy * S, 0.07, 3.2, 3.4, 3.8, 1.2, 1)
    }
    ctx.glow.add(x, y, 90, ready ? 0.7 : 0.4, r, g, b)
    ctx.projectileShadow(x, y, SPIRIT_H, 26)
    for (let i = count(ctx, 34); i > 0; i--) {
      ctx.particles.spawn(x + rand(-18, 18), y + rand(-18, 18), h - rand(0, 30), rand(-25, 25), rand(-25, 25), rand(-60, -20), rand(0.5, 0.9), rand(10, 16), 2, r * 0.8, g * 0.8, b * 0.8, 0, 1.2, 12)
    }
  }
}

function drawSpiritBolt(p: ProjectileState, x: number, y: number, ctx: VfxCtx): void {
  const h = floorH(ctx, x, y) + 70
  hexRgb(ctx.colorOf(p.owner), tint)
  const r = SPECTRE[0] + tint[0] * 0.4
  const g = SPECTRE[1] + tint[1] * 0.4
  const b = SPECTRE[2] + tint[2] * 0.4
  ctx.billboards.add(x * S, h * S, -y * S, 0.55, r, g, b, 1.8, 1)
  ctx.billboards.add(x * S, h * S, -y * S, 0.95, r * 0.35, g * 0.35, b * 0.35, 2.4)
  ctx.glow.add(x, y, 80, 0.6, r, g, b)
  for (let i = count(ctx, 80); i > 0; i--) {
    ctx.particles.spawn(x + rand(-8, 8), y + rand(-8, 8), h + rand(-8, 8), -p.vx * 0.12 + rand(-30, 30), -p.vy * 0.12 + rand(-30, 30), rand(-20, 20), rand(0.25, 0.45), rand(9, 13), 2, r * 0.7, g * 0.7, b * 0.7, 0, 2, 6)
  }
}

registerSpellVfx({
  spell: 'wild',
  kinds: ['spiritBolt'],
  init(ctx: VfxCtx): void {
    bomb = buildBomb(ctx)
  },
  dispose(): void {
    if (bomb) {
      bomb.parent?.remove(bomb)
      bomb.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose()
          ;(o.material as THREE.Material).dispose()
        }
      })
      bomb = null
    }
    bombAt.on = false
  },
  onEvent(e: SimEvent, ctx: VfxCtx): void {
    if (e.type === 'reaction') {
      const c = REACTION[e.reaction]
      const fh = floorH(ctx, e.x, e.y)
      // inside the smallest blast a reaction makes (Clash's is 150 at the lowest)
      ctx.flash(e.x, e.y, fh + 70, 0.22, 150, 220, c[0], c[1], c[2])
      ctx.ground.spawn(RING_EXPAND, e.x, e.y, fh, 30, 150, 0.35, 10, c[0], c[1], c[2])
      return
    }
    if (e.type === 'bomb') {
      bombEvent(e, ctx)
      return
    }
    if (e.type === 'spirit') {
      const fh = floorH(ctx, e.x, e.y)
      ctx.flash(e.x, e.y, fh + SPIRIT_H, 0.35, 120, 150, SPECTRE[0], SPECTRE[1], SPECTRE[2])
      ctx.ground.spawn(RING_EXPAND, e.x, e.y, fh, 20, 120, 0.5, 8, SPECTRE[0], SPECTRE[1], SPECTRE[2])
      return
    }
    if (e.type === 'omenWarning' && e.omen === 'shuffle') {
      const st = ctx.state
      for (const pw of st?.pawns ?? []) {
        if (!pw.alive) continue
        const info = ctx.pawn(pw.id)
        if (info) ctx.ground.spawn(RING_IMPLODE, info.x, info.y, floorH(ctx, info.x, info.y), 140, 30, SHUFFLE_WARN, 8, GOLD[0], GOLD[1], GOLD[2])
      }
      return
    }
    // Blood Moon: a push throws red streaks off the victim
    if (e.type === 'damage' && e.kb > 200 && ctx.state?.omens?.includes('bloodMoon')) {
      const pw = ctx.state.pawns.find((p) => p.id === e.target)
      if (!pw) return
      const sp = Math.hypot(pw.vx, pw.vy) || 1
      const dx = pw.vx / sp
      const dy = pw.vy / sp
      for (let i = ctx.particles.budget(10 * ctx.fx); i > 0; i--) {
        const s = rand(300, 700)
        ctx.particles.spawn(e.x, e.y, TILE_TOP_H + rand(40, 110), dx * s + rand(-80, 80), dy * s + rand(-80, 80), rand(0, 120), rand(0.25, 0.45), rand(8, 13), 2, CRIMSON[0], CRIMSON[1], CRIMSON[2], -600, 2, -0.05)
      }
    }
  },
  drawProjectile(p: ProjectileState, x: number, y: number, ctx: VfxCtx): void {
    if (p.kind === 'spiritBolt') drawSpiritBolt(p, x, y, ctx)
  },
  frame(ctx: VfxCtx): void {
    const st = ctx.state
    if (!st?.omens) {
      if (bomb) bomb.visible = false
      return
    }
    drawBomb(ctx, st)
    drawSpirits(ctx, st)
    if (ctx.dt <= 0 || (st.phase !== 'shop' && st.phase !== 'fight')) return
    const radius = layerRadius(st.arena.layer)
    for (const omen of st.omens) ambient(ctx, omen, radius)
  },
})
