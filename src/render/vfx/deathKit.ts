/**
 * Death kit: shared building blocks for warlock deaths (VFX workstream C).
 * Any spell module may call these so every death in the game reads as one
 * family. spells/deaths.ts composes them for lava, Fireball, Scourge,
 * pillars, disconnects and the generic fallback.
 *
 * Tint system: every death carries two colours.
 *   - tint.spell / tint.core: the killing spell's palette accent / core
 *     (death.cause -> getSpellColor). Dissolve edge, sparks, decal glow.
 *   - tint.victim: the victim's player colour. The escaping wisps, soul
 *     motes and runes that rise out of the body.
 * Build it once per death with deathTint(ctx, e) and pass it to the helpers.
 *
 * Claiming: deaths.ts claims EVERY 'death' event (built-in deathBurst off) and
 * draws it in its frame(), unless another module called claimDeath(e) in its
 * own onEvent. So a spell module that draws its own death:
 *
 *   onEvent(e, ctx) {
 *     if (e.type === 'death' && e.cause === 'snowball') {
 *       claimDeath(e)
 *       const tint = deathTint(ctx, e)
 *       freezeShatter(ctx, e.x ?? 0, e.y ?? 0, floor, 1, tint)
 *       disintegrate(ctx, e.pawn, x, y, floor, tint, { kind: 'freeze' })
 *       return true
 *     }
 *   }
 *
 * Helpers (all game units; h = height above the lava surface):
 *   disintegrate   the unified soul-release layer: spell-accent edge band
 *                  sweeping up the body in step with the character dissolve,
 *                  victim-colour wisps peeling off, runes rising, afterimage
 *   emberBurst     directional burning embers, sparks and robe scraps
 *   charHeap       charred robe heap decal with cooling ember cracks + smoulder
 *   ashPile        ash pile decal that blows away downwind + flakes
 *   crater         dusty crater decal with radial cracks (+ hot centre)
 *   freezeShatter  ice shards, frost patch, mist and glints
 *   xrayFlash      flickering skeletal silhouette flash (Lightning)
 *   sinkInLava     molten splash crown, burning ring on the lava, thrashing
 *                  flames on the sinking body, smoke plume
 *   shadowBurn     dark wisps eating the body from the edges + spell veins
 *   crumbleToDust  body crumbles into falling grit and a slumping dust cloud
 *   fadeToSmoke    quiet smoke column (disconnect)
 *   soulRunes      just the rising runes
 *   dissolvePawn   forces the character's death look + edge colour, when
 *                  render exposes ctx.pawnDeathFx (no-op until then)
 *
 * Performance: fixed pools (decals 48, runes 96, emitters 40), stateless GPU
 * ring buffers written once at spawn, no per-frame allocation. Particle counts
 * go through Particles.budget() (tier scaled) and per-frame emission scales by
 * tier.particles.
 */
import * as THREE from 'three/webgpu'
import {
  abs, atan, clamp, cos, dot, exp, float, floor, instancedBufferAttribute, length, max, min, mix, mod, mrt,
  positionGeometry, pow, saturate, sin, smoothstep, step, texture, uv, varying, vec2, vec3, vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { EntityId, SimEvent } from '../../sim/types'
import { LAVA_H, S, TILE_TOP_H } from '../coords'
import { RING_CHEVRON, RING_EXPAND, RING_IMPLODE } from '../scene/GroundFx'
import { asV4 } from '../scene/world'
import { baseSpellId, getSpellColor, SPELL_PALETTE, type RGB3 } from './palette'
import type { VfxCtx } from './registry'

export type { RGB3 }
export type DeathEvent = Extract<SimEvent, { type: 'death' }>

/** Warlock body height (game units; CC0 rig 1.29 m) and a rough body radius. */
export const BODY_H = 129
export const BODY_R = 30

const TAU = Math.PI * 2
const rnd = Math.random

/**
 * Character death looks (mirror of character/types DeathKind) and when each
 * one's material dissolve runs (seconds after death), mirrored from the
 * character's deathTimeline so the spark band rides the burning edge.
 */
export type DeathLook = 'ash' | 'lava' | 'fireball' | 'meteor' | 'lightning' | 'freeze' | 'gravity' | 'drain'
const DISSOLVE: Record<DeathLook, [number, number]> = {
  ash: [1.0, 1.9],
  lava: [1.2, 2.1],
  fireball: [0.9, 1.75],
  meteor: [0.9, 1.75],
  lightning: [0.8, 1.5],
  freeze: [0.95, 1.15],
  gravity: [0.85, 1.1],
  drain: [1.0, 1.8],
}

// ---------------------------------------------------------------- tint

export interface DeathTint {
  /** victim player colour, linear, luminance-normalised (wisps, motes, runes) */
  victim: RGB3
  /** killer spell accent, linear, luminance-normalised (edge, sparks, glow) */
  spell: RGB3
  /** killer spell core (hot centre), linear */
  core: RGB3
  /** palette id the spell colours came from ('' = neutral / not a spell) */
  spellId: string
}

const tmpC = new THREE.Color()

/** hex 0xRRGGBB (sRGB) -> linear triple scaled to luminance `lum`. */
export function hexLinear(hex: number, lum: number, out: RGB3): RGB3 {
  tmpC.setHex(hex, THREE.SRGBColorSpace)
  return normLum(tmpC.r, tmpC.g, tmpC.b, lum, out)
}

function normLum(r: number, g: number, b: number, lum: number, out: RGB3): RGB3 {
  // never fully grey-out dark colours: floor each channel a little before scaling
  const l = Math.max(1e-3, 0.2126 * r + 0.7152 * g + 0.0722 * b)
  const k = lum / l
  out[0] = Math.min(r * k, 6)
  out[1] = Math.min(g * k, 6)
  out[2] = Math.min(b * k, 6)
  return out
}

/** Neutral colours for causes that are not spells. */
const CAUSE_TINT: Record<string, { accent: number; core: number }> = {
  lava: { accent: 0xff5a10, core: 0xffd890 },
  obstacle: { accent: 0xb89a74, core: 0xf0e2c8 },
  disconnect: { accent: 0x8c96a8, core: 0xe8eef8 },
}

/**
 * Tint for a death: victim = the dead pawn's player colour, spell = the
 * cause's palette accent (lava / pillar / disconnect get neutral pairs).
 */
export function deathTint(ctx: VfxCtx, e: DeathEvent, out?: DeathTint): DeathTint {
  const t = out ?? { victim: [1, 1, 1], spell: [1, 1, 1], core: [1, 1, 1], spellId: '' }
  hexLinear(ctx.colorOf(e.owner), 1, t.victim)
  const cause = e.cause ?? ''
  const nt = CAUSE_TINT[cause]
  const id = baseSpellId(cause)
  if (nt) {
    hexLinear(nt.accent, 0.9, t.spell)
    hexLinear(nt.core, 2, t.core)
    t.spellId = ''
  } else if (SPELL_PALETTE[id]) {
    const c = getSpellColor(id)
    normLum(c.accent.r, c.accent.g, c.accent.b, 0.9, t.spell)
    normLum(c.core.r, c.core.g, c.core.b, 2, t.core)
    t.spellId = id
  } else {
    hexLinear(0xb08060, 0.9, t.spell)
    hexLinear(0xffe8c8, 2, t.core)
    t.spellId = ''
  }
  return t
}

// ---------------------------------------------------------------- claiming

const claimed = new WeakSet<object>()

/** Call from your module's onEvent when it draws this death itself (deaths.ts then skips it). */
export function claimDeath(e: SimEvent): void {
  claimed.add(e)
}

export function deathClaimed(e: SimEvent): boolean {
  return claimed.has(e)
}

/** Floor height under (x, y) for decals (tile top or lava surface), plus a small lift. */
export function decalFloor(ctx: VfxCtx, x: number, y: number): number {
  return ctx.isLava(x, y) ? LAVA_H + 2 : TILE_TOP_H + 0.8
}

// ---------------------------------------------------------------- render hook

/** Optional render hook (not in VfxCtx yet): drive the character's death look. */
interface DeathHooks {
  pawnDeathFx?: (pawnId: EntityId, kind: DeathLook, dx: number, dy: number, edge?: readonly number[]) => void
}

/**
 * Force the character's death look and dissolve-edge colour (spell accent).
 * Needs render to expose ctx.pawnDeathFx -> PawnView -> WarlockHandle.deathFx;
 * until then the character picks its look from the death cause itself.
 */
export function dissolvePawn(ctx: VfxCtx, pawnId: EntityId, kind: DeathLook, dx = 0, dy = 0, edge?: readonly number[]): boolean {
  const h = (ctx as VfxCtx & DeathHooks).pawnDeathFx
  if (!h) return false
  h(pawnId, kind, dx, dy, edge)
  return true
}

// ---------------------------------------------------------------- GPU pools

export const D_CHAR = 0
export const D_ASH = 1
export const D_BURNRING = 2
export const D_SIGIL = 3
export const D_CRATER = 4
export const D_FROST = 5

const DECALS = 48
const RUNES = 96

const ang01 = (q: Node<'vec2'>) => atan(q.y, q.x).div(TAU)

/**
 * Floor decals for death leftovers: a dark layer (normal blend: charcoal,
 * ash, slag, frost) and a glow layer (additive: ember cracks, burning ring,
 * spell veins) sharing one instance buffer. Stateless: written at spawn, the
 * shader animates cooling, growth, erosion and fade from the spawn time.
 */
class DeathDecals {
  readonly dark: THREE.Mesh
  readonly glow: THREE.Mesh
  private attrs: THREE.InstancedBufferAttribute[]
  private cursor = 0
  private dirty = false
  private mats: THREE.MeshBasicNodeMaterial[] = []
  private geo: THREE.BufferGeometry

  constructor(private ctx: VfxCtx) {
    const mk = () => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(DECALS * 4), 4)
      a.setUsage(THREE.DynamicDrawUsage)
      return a
    }
    this.attrs = [mk(), mk(), mk(), mk()]
    const a0 = this.attrs[0].array as Float32Array
    const a1 = this.attrs[1].array as Float32Array
    for (let i = 0; i < DECALS; i++) {
      a0[i * 4 + 3] = -1e4
      a1[i * 4 + 1] = 1
    }
    const A0 = asV4(instancedBufferAttribute(this.attrs[0])) // centre (three), born
    const A1 = asV4(instancedBufferAttribute(this.attrs[1])) // radius (game), life, seed, type
    const A2 = asV4(instancedBufferAttribute(this.attrs[2])) // tint rgb (linear HDR), param
    const A3 = asV4(instancedBufferAttribute(this.attrs[3])) // dir x/y (game), stretch, intensity
    const w = ctx.world
    // the clock is read in the vertex stage only and handed over as a varying
    // (a fragment-stage read of the same uniform does not track the frame clock)
    const ageVert = w.uTime.sub(A0.w)
    const tnVert = ageVert.div(A1.y)
    const aliveVert = step(0, tnVert).mul(step(tnVert, 1))
    const age = varying(ageVert)
    const tn = age.div(A1.y)
    const alive = step(0, tn).mul(step(tn, 1))
    const q = positionGeometry.xy
    const R = A1.x.mul(S)
    // local x = along dir (stretched), local y = perpendicular
    const along = vec3(A3.x, 0, A3.y.negate())
    const perp = vec3(A3.y.negate(), 0, A3.x.negate())
    const positionNode = A0.xyz.add(along.mul(q.x.mul(A3.z)).add(perp.mul(q.y)).mul(R).mul(aliveVert))
    const seed = A1.z
    const type = A1.w
    const isT = (k: number) => step(abs(type.sub(k)), 0.5)
    const r = length(q)
    const n1 = texture(w.noise, q.mul(0.42).add(seed)).r
    const n2 = texture(w.noise, q.mul(1.3).add(seed.mul(1.7))).g
    const cr = texture(w.noise, q.mul(0.3).add(seed.mul(2.3)))
    const crack = float(1).sub(smoothstep(0.02, 0.13, cr.b))
    const tint = A2.xyz
    const inten = A3.w
    const fadeOut = float(1).sub(smoothstep(0.62, 1, tn))
    const edgeCut = smoothstep(1.0, 0.9, r)

    // CHAR: ragged charcoal heap dusted with grey ash, soot halo, ember cracks
    // and a smouldering rim that cool from the spell colour to dull red
    const heap = smoothstep(0.82, 0.4, r.add(n1.sub(0.5).mul(0.55)))
    const soot = smoothstep(1.0, 0.45, r.add(n2.sub(0.5).mul(0.45))).mul(0.7)
    const cDarkA = max(heap.mul(0.97), soot)
    const ashDust = smoothstep(0.55, 0.8, n2).mul(heap)
    const cDark = mix(mix(vec3(0.05, 0.043, 0.04), vec3(0.008, 0.006, 0.005), heap).mul(n2.mul(0.6).add(0.7)), vec3(0.16, 0.15, 0.14), ashDust.mul(0.8))
    const heat = exp(age.mul(-0.6)).mul(sin(age.mul(9).add(n1.mul(30))).mul(0.25).add(0.75))
    const emb = crack.mul(heap).mul(heat).mul(smoothstep(0.3, 0.7, n2.add(0.25)))
    const crx = r.sub(0.62).sub(n1.sub(0.5).mul(0.3)).div(0.09)
    const charRim = exp(crx.mul(crx).negate()).mul(heat).mul(smoothstep(0.35, 0.65, n2.add(0.15)))
    const cGlow = mix(vec3(0.9, 0.07, 0.01), tint, saturate(emb.mul(1.6))).mul(emb.mul(2.6))
      .add(vec3(1.6, 0.25, 0.03).mul(charRim.mul(1.4)))
      .add(tint.mul(heap.mul(exp(age.mul(-4.5))).mul(0.7)))

    // ASH: grey pile, drifts and erodes downwind (local +x) from the upwind side
    const e = smoothstep(0.32, 1.0, tn)
    const qa = q.sub(vec2(e.mul(0.45), 0))
    const pile = smoothstep(0.8, 0.38, length(qa).add(n1.sub(0.5).mul(0.6)))
    const keep = smoothstep(e.mul(1.25).sub(0.18), e.mul(1.25), n2.mul(0.6).add(q.x.mul(0.25).add(0.25)).add(0.05))
    const aDarkA = pile.mul(keep).mul(0.93)
    const aDark = tint.mul(n2.mul(0.55).add(0.72)).mul(float(1).sub(crack.mul(0.35)))
    const spots = smoothstep(0.22, 0.08, cr.a).mul(pile).mul(keep).mul(exp(age.mul(-2.3)))
    const aGlow = vec3(3.0, 0.85, 0.14).mul(spots).mul(A2.w)

    // BURNRING: flame ring growing on the lava + dark slag raft with glowing cracks
    const grow = float(1).sub(pow(float(1).sub(saturate(tn.mul(1.7))), 3))
    const rr = r.div(grow.mul(0.62).add(0.38))
    const ua = ang01(q).mul(5)
    const fl = texture(w.noise, vec2(ua, rr.mul(1.4).sub(age.mul(1.3)))).r
    const fl2 = texture(w.noise, vec2(ua.mul(2).add(0.37), rr.mul(2.8).sub(age.mul(2.2)))).g
    const flame = saturate(fl.add(fl2).mul(1.5).sub(0.85))
    const bx = rr.sub(0.8).div(0.14)
    const band = exp(bx.mul(bx).negate())
    const tongue = smoothstep(1.12, 0.82, rr.sub(flame.mul(0.22))).mul(smoothstep(0.66, 0.8, rr))
    const ringI = band.mul(flame.mul(1.5).add(0.35)).add(tongue.mul(flame).mul(1.2)).mul(float(1).sub(smoothstep(0.55, 1, tn)))
    const slag = smoothstep(0.72, 0.25, rr.add(n1.sub(0.5).mul(0.4))).mul(0.88)
    const bDarkA = slag.mul(fadeOut)
    const bDark = vec3(0.03, 0.011, 0.008).mul(n2.add(0.6))
    const bGlow = mix(tint, vec3(4.2, 2.4, 0.8), flame.mul(band)).mul(ringI)
      .add(vec3(2.6, 0.55, 0.07).mul(crack.mul(slag).mul(exp(age.mul(-0.8))).mul(0.8)))

    // SIGIL: shadow burn, swirling veins in the spell colour, hot rim
    const sh = smoothstep(0.88, 0.32, r.add(n1.sub(0.5).mul(0.5)))
    const sDarkA = sh.mul(0.92)
    const sDark = vec3(0.016, 0.004, 0.008).mul(n2.mul(0.5).add(0.75))
    const vt = texture(w.noise, vec2(ang01(q).mul(3).add(age.mul(0.06)), r.mul(0.55).sub(age.mul(0.22)).add(seed))).b
    const vein = float(1).sub(smoothstep(0.03, 0.12, vt)).mul(smoothstep(0.95, 0.15, r))
    const rimx = r.sub(0.8).sub(n1.sub(0.5).mul(0.2)).div(0.07)
    const rim = exp(rimx.mul(rimx).negate()).mul(exp(age.mul(-1.4)))
    const pulse = sin(age.mul(7).sub(r.mul(12))).mul(0.4).add(0.6)
    const sGlow = tint.mul(vein.mul(pulse).mul(exp(age.mul(-0.75))).mul(1.6).add(rim.mul(1.3)))

    // CRATER: blown-out dust ring, darker bowl, radial cracks, optional hot core
    const bowl = smoothstep(0.92, 0.45, r.add(n1.sub(0.5).mul(0.3)))
    const lipx = r.sub(0.84).div(0.08)
    const lip = exp(lipx.mul(lipx).negate()).mul(n2.add(0.4))
    const rc = texture(w.noise, vec2(ang01(q).mul(4), r.mul(0.35).add(seed))).b
    const rcrack = float(1).sub(smoothstep(0.02, 0.09, rc)).mul(smoothstep(0.95, 0.3, r))
    const kDarkA = max(bowl.mul(0.55), rcrack.mul(0.85)).max(lip.mul(0.5))
    const kDark = mix(vec3(0.02, 0.018, 0.016), tint, saturate(lip.mul(0.9).sub(rcrack)))
    const kGlow = vec3(3.2, 0.95, 0.18).mul(A2.w).mul(exp(age.mul(-1.6))).mul(smoothstep(0.65, 0.0, r).add(rcrack.mul(0.8)))

    // FROST: crystalline ice patch, faceted edges glinting
    const fp = smoothstep(0.95, 0.45, r.add(n1.sub(0.5).mul(0.5)))
    const facet = float(1).sub(smoothstep(0.0, 0.07, cr.b))
    const fDarkA = fp.mul(0.58)
    const fDark = vec3(0.34, 0.5, 0.64).mul(n2.mul(0.4).add(0.8))
    const glint = step(0.9, sin(n2.mul(40).add(age.mul(3))).mul(0.5).add(0.5))
    const fGlow = tint.mul(facet.mul(fp).mul(glint.mul(1.4).add(0.35)))

    const darkA = cDarkA.mul(isT(D_CHAR)).add(aDarkA.mul(isT(D_ASH))).add(bDarkA.mul(isT(D_BURNRING)))
      .add(sDarkA.mul(isT(D_SIGIL))).add(kDarkA.mul(isT(D_CRATER))).add(fDarkA.mul(isT(D_FROST)))
    const darkC = cDark.mul(isT(D_CHAR)).add(aDark.mul(isT(D_ASH))).add(bDark.mul(isT(D_BURNRING)))
      .add(sDark.mul(isT(D_SIGIL))).add(kDark.mul(isT(D_CRATER))).add(fDark.mul(isT(D_FROST)))
    const glowC = cGlow.mul(isT(D_CHAR)).add(aGlow.mul(isT(D_ASH))).add(bGlow.mul(isT(D_BURNRING)))
      .add(sGlow.mul(isT(D_SIGIL))).add(kGlow.mul(isT(D_CRATER))).add(fGlow.mul(isT(D_FROST)))
    const fadeIn = smoothstep(0, 0.06, age)

    const dm = new THREE.MeshBasicNodeMaterial()
    dm.transparent = true
    dm.depthWrite = false
    dm.positionNode = positionNode
    dm.colorNode = darkC
    dm.opacityNode = saturate(darkA).mul(fadeOut).mul(alive).mul(edgeCut).mul(fadeIn)
    dm.name = 'DeathDecalDark'
    const gm = new THREE.MeshBasicNodeMaterial()
    gm.transparent = true
    gm.depthWrite = false
    gm.blending = THREE.AdditiveBlending
    gm.positionNode = positionNode
    const gcol = glowC.mul(inten).mul(fadeOut).mul(alive).mul(edgeCut)
    gm.colorNode = gcol
    gm.opacityNode = float(1)
    if (ctx.tier.heatHaze) gm.mrtNode = mrt({ heat: vec4(saturate(dot(gcol, vec3(0.15, 0.1, 0.05))), 0, 0, 1) })
    gm.name = 'DeathDecalGlow'
    this.mats.push(dm, gm)

    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3))
    g.setIndex([0, 1, 2, 2, 1, 3])
    this.geo = g
    this.dark = new THREE.Mesh(g, dm)
    this.glow = new THREE.Mesh(g, gm)
    for (const m of [this.dark, this.glow]) {
      m.count = DECALS
      m.frustumCulled = false
    }
    this.dark.renderOrder = 1
    this.glow.renderOrder = 3
    this.dark.name = 'death-decals'
    this.glow.name = 'death-decals-glow'
    // upload after every module of the frame had its chance to spawn
    this.dark.onBeforeRender = () => this.commit()
  }

  spawn(type: number, x: number, y: number, h: number, radius: number, life: number, tint: readonly number[], param: number, dx: number, dy: number, stretch: number, intensity: number): void {
    const i = this.cursor
    this.cursor = (this.cursor + 1) % DECALS
    const o = i * 4
    const a0 = this.attrs[0].array as Float32Array
    const a1 = this.attrs[1].array as Float32Array
    const a2 = this.attrs[2].array as Float32Array
    const a3 = this.attrs[3].array as Float32Array
    const dl = Math.hypot(dx, dy)
    a0[o] = x * S
    a0[o + 1] = h * S
    a0[o + 2] = -y * S
    a0[o + 3] = this.ctx.world.uTime.value
    a1[o] = radius
    a1[o + 1] = Math.max(0.1, life)
    a1[o + 2] = rnd() * 17
    a1[o + 3] = type
    a2[o] = tint[0]
    a2[o + 1] = tint[1]
    a2[o + 2] = tint[2]
    a2[o + 3] = param
    a3[o] = dl > 1e-4 ? dx / dl : 1
    a3[o + 1] = dl > 1e-4 ? dy / dl : 0
    a3[o + 2] = stretch
    a3[o + 3] = intensity
    this.dirty = true
  }

  commit(): void {
    if (!this.dirty) return
    this.dirty = false
    for (const a of this.attrs) a.needsUpdate = true
  }

  dispose(): void {
    for (const m of this.mats) m.dispose()
    this.geo.dispose()
  }
}

/**
 * Rising rune glyphs (soul release): camera-facing procedural sigils built
 * from three strokes on a 3x3 grid (+ optional ring), spiralling upward and
 * fading. Stateless ring buffer like Particles.
 */
class RuneSprites {
  readonly sprite: THREE.Sprite
  private attrs: THREE.InstancedBufferAttribute[]
  private cursor = 0
  private dirty = false
  private material: THREE.SpriteNodeMaterial

  constructor(private ctx: VfxCtx) {
    const mk = () => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(RUNES * 4), 4)
      a.setUsage(THREE.DynamicDrawUsage)
      return a
    }
    this.attrs = [mk(), mk(), mk(), mk()]
    const a0 = this.attrs[0].array as Float32Array
    const a1 = this.attrs[1].array as Float32Array
    for (let i = 0; i < RUNES; i++) {
      a0[i * 4 + 3] = -1e4
      a1[i * 4 + 3] = 1
    }
    const R0 = asV4(instancedBufferAttribute(this.attrs[0])) // pos (three), born
    const R1 = asV4(instancedBufferAttribute(this.attrs[1])) // vel (three/s), life
    const R2 = asV4(instancedBufferAttribute(this.attrs[2])) // rgb, size (three)
    const R3 = asV4(instancedBufferAttribute(this.attrs[3])) // glyph a, glyph b, spin, swirl radius (three)
    const ageV = ctx.world.uTime.sub(R0.w)
    const tnV = ageV.div(R1.w)
    const aliveV = step(0, tnV).mul(step(tnV, 1))
    const ph = R0.w.mul(13.7)
    const sw = R3.w.mul(min(ageV.mul(1.5), 1))
    const swirl = vec3(cos(ageV.mul(2.6).add(ph)), 0, sin(ageV.mul(2.6).add(ph))).mul(sw)
    // rise eases out (soul drifting away), velocity decays with drag 1.2
    const dragF = float(1).sub(exp(ageV.mul(-1.2))).div(1.2)
    const pos = R0.xyz.add(R1.xyz.mul(dragF)).add(swirl)
    const grow = smoothstep(0, 0.18, tnV).mul(float(1).add(tnV.mul(0.35)))
    const size = R2.w.mul(grow).mul(aliveV)
    // fragment-side clock via varying (see DeathDecals)
    const age = varying(ageV)
    const tn = age.div(R1.w)

    // glyph: decode 3 strokes (grid indices 0..8) + ring flag
    const gp = (i: Node<'float'>) => vec2(mod(i, 3).sub(1), floor(i.div(3)).sub(1)).mul(0.6)
    const seg = (p: Node<'vec2'>, a: Node<'vec2'>, b: Node<'vec2'>) => {
      const pa = p.sub(a)
      const ba = b.sub(a)
      const hh = clamp(dot(pa, ba).div(max(dot(ba, ba), 1e-4)), 0, 1)
      return length(pa.sub(ba.mul(hh)))
    }
    const gA = R3.x
    const gB = R3.y
    const s0 = mod(gA, 81)
    const s1 = floor(gA.div(81))
    const s2 = mod(gB, 81)
    const ringF = floor(gB.div(81))
    const p = uv().sub(0.5).mul(2.3)
    const d0 = seg(p, gp(mod(s0, 9)), gp(floor(s0.div(9))))
    const d1 = seg(p, gp(mod(s1, 9)), gp(floor(s1.div(9))))
    const d2 = seg(p, gp(mod(s2, 9)), gp(floor(s2.div(9))))
    const dr = abs(length(p).sub(0.86)).add(float(1).sub(ringF).mul(9))
    const d = min(min(d0, d1), min(d2, dr))
    const stroke = smoothstep(0.15, 0.05, d)
    const halo = exp(d.mul(-5.5)).mul(0.45)
    const flick = sin(age.mul(23).add(R0.w.mul(13.7))).mul(0.15).add(0.85)
    const fade = smoothstep(0, 0.12, tn).mul(float(1).sub(smoothstep(0.55, 1, tn)))
    const m = new THREE.SpriteNodeMaterial()
    m.transparent = true
    m.depthWrite = false
    m.blending = THREE.AdditiveBlending
    m.positionNode = pos
    m.scaleNode = vec2(size, size)
    m.rotationNode = R3.z.mul(ageV).add(ph)
    m.colorNode = R2.xyz.mul(stroke.mul(1.7).add(halo)).mul(fade).mul(flick).mul(smoothstep(1.15, 0.85, length(p)))
    m.opacityNode = float(1)
    m.name = 'DeathRunes'
    this.material = m
    this.sprite = new THREE.Sprite(m)
    this.sprite.count = RUNES
    this.sprite.frustumCulled = false
    this.sprite.renderOrder = 7
    this.sprite.name = 'death-runes'
    this.sprite.onBeforeRender = () => this.commit()
  }

  /** game units; size game units; colour linear HDR; swirl radius game units. */
  spawn(x: number, y: number, h: number, vx: number, vy: number, vh: number, life: number, size: number, r: number, g: number, b: number, swirl: number): void {
    const i = this.cursor
    this.cursor = (this.cursor + 1) % RUNES
    const o = i * 4
    const a0 = this.attrs[0].array as Float32Array
    const a1 = this.attrs[1].array as Float32Array
    const a2 = this.attrs[2].array as Float32Array
    const a3 = this.attrs[3].array as Float32Array
    a0[o] = x * S
    a0[o + 1] = h * S
    a0[o + 2] = -y * S
    a0[o + 3] = this.ctx.world.uTime.value
    a1[o] = vx * S
    a1[o + 1] = vh * S
    a1[o + 2] = -vy * S
    a1[o + 3] = Math.max(0.05, life)
    a2[o] = r
    a2[o + 1] = g
    a2[o + 2] = b
    a2[o + 3] = size * S
    // three strokes on the 3x3 grid: a spine through the centre + two branches
    const pick = () => Math.floor(rnd() * 9)
    const c = 4
    const s0 = c + 9 * (rnd() < 0.5 ? 1 : 7)
    let s1 = pick()
    let s2 = pick()
    s1 = s1 + 9 * ((s1 + 1 + Math.floor(rnd() * 7)) % 9)
    s2 = s2 + 9 * ((s2 + 2 + Math.floor(rnd() * 6)) % 9)
    a3[o] = s0 + 81 * s1
    a3[o + 1] = s2 + 81 * (rnd() < 0.45 ? 1 : 0)
    a3[o + 2] = (rnd() - 0.5) * 3
    a3[o + 3] = swirl * S
    this.dirty = true
  }

  commit(): void {
    if (!this.dirty) return
    this.dirty = false
    for (const a of this.attrs) a.needsUpdate = true
  }

  dispose(): void {
    this.material.dispose()
  }
}

// ---------------------------------------------------------------- timed emitters

const E_NONE = 0
const E_DISINT = 1
const E_SMOLDER = 2
const E_ASHWIND = 3
const E_LAVA = 4
const E_RINGFIRE = 5
const E_SHADOW = 6
const E_CRUMBLE = 7
const E_SMOKE = 8
const E_XRAY = 9
const E_MIST = 10
const E_GHOST = 11

interface Emitter {
  type: number
  pawn: EntityId
  x: number
  y: number
  h: number
  dx: number
  dy: number
  t0: number
  t1: number
  /** dissolve window start / end (s after t0), E_DISINT */
  d0: number
  d1: number
  k: number
  acc: number
  acc2: number
  acc3: number
  /** one-shot flags */
  flags: number
  victim: RGB3
  spell: RGB3
  core: RGB3
}

const EMITTERS = 40

class DeathKitPools {
  readonly decals: DeathDecals
  readonly runes: RuneSprites
  readonly em: Emitter[] = []

  constructor(readonly ctx: VfxCtx) {
    this.decals = new DeathDecals(ctx)
    this.runes = new RuneSprites(ctx)
    for (let i = 0; i < EMITTERS; i++) {
      this.em.push({ type: E_NONE, pawn: -1, x: 0, y: 0, h: 0, dx: 0, dy: 0, t0: 0, t1: 0, d0: 0, d1: 0, k: 1, acc: 0, acc2: 0, acc3: 0, flags: 0, victim: [1, 1, 1], spell: [1, 1, 1], core: [1, 1, 1] })
    }
    ctx.scene.add(this.decals.dark, this.decals.glow, this.runes.sprite)
  }

  emitter(type: number, x: number, y: number, h: number, dur: number): Emitter {
    const now = this.ctx.now
    // free slot, else the one closest to finishing
    let slot = this.em[0]
    let best = Infinity
    for (const e of this.em) {
      if (e.type === E_NONE || now > e.t1) {
        slot = e
        break
      }
      if (e.t1 < best) {
        best = e.t1
        slot = e
      }
    }
    slot.type = type
    slot.pawn = -1
    slot.x = x
    slot.y = y
    slot.h = h
    slot.dx = 0
    slot.dy = 0
    slot.t0 = now
    slot.t1 = now + Math.min(3, dur)
    slot.d0 = 0
    slot.d1 = 0
    slot.k = 1
    slot.acc = 0
    slot.acc2 = 0
    slot.acc3 = 0
    slot.flags = 0
    return slot
  }

  dispose(): void {
    this.ctx.scene.remove(this.decals.dark, this.decals.glow, this.runes.sprite)
    this.decals.dispose()
    this.runes.dispose()
  }
}

let pools: DeathKitPools | null = null

function kit(ctx: VfxCtx): DeathKitPools {
  if (!pools || pools.ctx !== ctx) {
    pools?.dispose()
    pools = new DeathKitPools(ctx)
  }
  return pools
}

/** Drop every GPU object (world teardown). deaths.ts calls this from dispose(). */
export function disposeDeathKit(): void {
  pools?.dispose()
  pools = null
}

const copy3 = (src: readonly number[], dst: RGB3) => {
  dst[0] = src[0]
  dst[1] = src[1]
  dst[2] = src[2]
}

function setTint(e: Emitter, tint: DeathTint): void {
  copy3(tint.victim, e.victim)
  copy3(tint.spell, e.spell)
  copy3(tint.core, e.core)
}

/** Continuous emission count this frame (tier scaled, fractional carry). */
function emitN(ctx: VfxCtx, e: Emitter, rate: number, which: 'acc' | 'acc2' | 'acc3' = 'acc'): number {
  const v = e[which] + rate * ctx.dt * ctx.tier.particles
  const n = Math.floor(v)
  e[which] = v - n
  return n
}

const lowQ = (ctx: VfxCtx) => ctx.quality === 'low'

// ---------------------------------------------------------------- helpers (public)

/**
 * The unified soul-release layer every death gets: a spell-accent spark band
 * that rides the character's dissolve edge from the feet up, victim-colour
 * wisps peeling off the body, runes rising out of it, an afterimage.
 * kind = the character death look (timing of its dissolve).
 */
export function disintegrate(
  ctx: VfxCtx,
  pawnId: EntityId,
  x: number,
  y: number,
  h: number,
  tint: DeathTint,
  o: { kind?: DeathLook; strength?: number; runes?: number; quiet?: boolean } = {},
): void {
  const K = kit(ctx)
  const kind = o.kind ?? 'ash'
  const [d0, d1] = DISSOLVE[kind]
  const e = K.emitter(E_DISINT, x, y, h, d1 + 1.4)
  e.pawn = pawnId
  e.d0 = d0
  e.d1 = d1
  e.k = o.strength ?? 1
  e.flags = (o.runes ?? (o.quiet ? 3 : 7)) | (o.quiet ? 256 : 0)
  setTint(e, tint)
  // a spell-coloured rune circle under the body as the unravelling starts (teleport-out echo)
  if (!o.quiet) {
    const f = decalFloor(ctx, x, y)
    const s = tint.spell
    ctx.ground.spawn(RING_CHEVRON, x, y, f + 1, 34, 58, 0.55, 4, s[0] * 1.6, s[1] * 1.6, s[2] * 1.6)
    ctx.ground.spawn(RING_IMPLODE, x, y, f + 1, 10, 95, 0.4, 7, s[0] * 1.2, s[1] * 1.2, s[2] * 1.2)
  }
}

function tickDisint(ctx: VfxCtx, K: DeathKitPools, e: Emitter, t: number): void {
  const p = e.pawn >= 0 ? ctx.pawn(e.pawn) : null
  if (p) {
    e.x = p.x
    e.y = p.y
    e.h = p.h
  }
  const ps = ctx.particles
  const quiet = (e.flags & 256) !== 0
  const lt = t - e.t0
  const span = Math.max(0.1, e.d1 - e.d0)
  const dz = (lt - e.d0) / span
  const v = e.victim
  const s = e.spell
  if (dz > -0.15 && dz < 1.05) {
    // the burning edge climbs feet -> head (character dissolve: edge reaches the top at ~75 %)
    const f = Math.max(0, Math.min(1, dz / 0.78))
    const bh = e.h + 4 + f * (BODY_H - 8)
    const n = emitN(ctx, e, (quiet ? 70 : 170) * e.k)
    for (let i = 0; i < n; i++) {
      const a = rnd() * TAU
      const rr = BODY_R * (0.75 + rnd() * 0.45) * (1 - f * 0.35)
      const sp = 40 + rnd() * 90
      // spell-accent sparks on the edge, flung outward and up
      ps.spawn(e.x + Math.cos(a) * rr, e.y + Math.sin(a) * rr, bh + (rnd() - 0.5) * 10, Math.cos(a) * sp, Math.sin(a) * sp, 60 + rnd() * 160, 0.28 + rnd() * 0.3, 7 + rnd() * 4, 1.5, s[0] * 3.2, s[1] * 3.2, s[2] * 3.2, -120, 1.2, -0.06)
      // victim-colour wisps peel off the edge and drift up
      if (rnd() < 0.55) {
        ps.spawn(e.x + Math.cos(a) * rr * 0.9, e.y + Math.sin(a) * rr * 0.9, bh, Math.cos(a) * sp * 0.35, Math.sin(a) * sp * 0.35, 90 + rnd() * 120, 0.7 + rnd() * 0.6, 9 + rnd() * 6, 3, v[0] * 2.1, v[1] * 2.1, v[2] * 2.1, 40, 1.4, 14)
      }
    }
    if (!lowQ(ctx)) ctx.glow.add(e.x, e.y, 120, 0.45 * e.k * (1 - Math.max(0, dz)), s[0] * 0.8, s[1] * 0.8, s[2] * 0.8)
  }
  // soul release: runes + afterimage once the head is gone
  if (dz >= 0.7 && (e.flags & 512) === 0) {
    e.flags |= 512
    const nr = e.flags & 255
    for (let i = 0; i < nr; i++) {
      const a = (i / Math.max(1, nr)) * TAU + rnd() * 0.6
      const rr = 8 + rnd() * 22
      K.runes.spawn(e.x + Math.cos(a) * rr, e.y + Math.sin(a) * rr, e.h + BODY_H * (0.45 + rnd() * 0.5), Math.cos(a) * 25, Math.sin(a) * 25, 120 + rnd() * 110, 1.0 + rnd() * 0.5, 15 + rnd() * 9, v[0] * 3, v[1] * 3, v[2] * 3, 14 + rnd() * 16)
    }
    const g = K.emitter(E_GHOST, e.x, e.y, e.h, quiet ? 0.6 : 0.45)
    copy3(v, g.victim)
    copy3(s, g.spell)
    g.flags = quiet ? 1 : 0
    // last puff of victim-colour motes rising out of the top
    const n = ps.budget(quiet ? 10 : 22)
    for (let i = 0; i < n; i++) {
      const a = rnd() * TAU
      const sp = 20 + rnd() * 60
      ps.spawn(e.x + Math.cos(a) * 12, e.y + Math.sin(a) * 12, e.h + BODY_H * 0.85, Math.cos(a) * sp, Math.sin(a) * sp, 140 + rnd() * 160, 0.9 + rnd() * 0.7, 6 + rnd() * 4, 2, v[0] * 2.6, v[1] * 2.6, v[2] * 2.6, 30, 1, 18)
    }
  }
}

function tickGhost(ctx: VfxCtx, e: Emitter, t: number): void {
  // tall fading afterimage where the soul left (teleport-out echo), victim colour
  const k = 1 - (t - e.t0) / Math.max(0.05, e.t1 - e.t0)
  if (k <= 0) return
  const v = e.victim
  const s = e.spell
  const q = e.flags === 1 ? 0.45 : 1
  const kk = k * k * q
  ctx.billboards.addStreak(e.x * S, (e.h + BODY_H * 0.55) * S, -e.y * S, 58 * S, 2.6 + (1 - k) * 1.2, Math.PI / 2, v[0] * 1.6 * kk, v[1] * 1.6 * kk, v[2] * 1.6 * kk, 1.5, 0)
  ctx.billboards.add(e.x * S, (e.h + BODY_H * 0.9 + (1 - k) * 60) * S, -e.y * S, (30 + (1 - k) * 50) * S, s[0] * 1.4 * kk, s[1] * 1.4 * kk, s[2] * 1.4 * kk, 2.2)
}

/**
 * Burning embers, sparks and robe scraps blown along (dx, dy) (0, 0 = all
 * around), size by strength (~kb / 900, 0.5..2). Fire tinted by tint.core /
 * tint.spell; scraps carry the victim's colour.
 */
export function emberBurst(ctx: VfxCtx, x: number, y: number, h: number, dx: number, dy: number, strength: number, tint: DeathTint): void {
  const ps = ctx.particles
  const k = Math.max(0.5, Math.min(2, strength))
  const dl = Math.hypot(dx, dy)
  const omni = dl < 1e-3
  const base = omni ? 0 : Math.atan2(dy, dx)
  const c = tint.core
  const s = tint.spell
  const v = tint.victim
  const n = ps.budget(70 * k)
  for (let i = 0; i < n; i++) {
    const a = omni ? rnd() * TAU : base + (rnd() - 0.5) * (rnd() < 0.7 ? 1.1 : 2.4)
    const sp = (220 + rnd() * 620) * (0.7 + k * 0.3)
    const hot = rnd()
    // cooling flag (size1 < 0): hot core -> crimson as it flies
    ps.spawn(x, y, h + (rnd() - 0.3) * 60, Math.cos(a) * sp, Math.sin(a) * sp, 80 + rnd() * 380, 0.5 + rnd() * 0.8, 10 + rnd() * 16, -3, c[0] * (1.2 + hot), c[1] * (1.0 + hot * 0.6), c[2] * (0.8 + hot * 0.3), -950, 1.6, rnd() < 0.5 ? -0.05 : 6)
  }
  // fast spark streaks in the spell accent
  const ns = ps.budget(34 * k)
  for (let i = 0; i < ns; i++) {
    const a = omni ? rnd() * TAU : base + (rnd() - 0.5) * 0.9
    const sp = 700 + rnd() * 900
    ps.spawn(x, y, h + (rnd() - 0.5) * 40, Math.cos(a) * sp, Math.sin(a) * sp, 50 + rnd() * 250, 0.16 + rnd() * 0.18, 6, 1, s[0] * 4, s[1] * 4, s[2] * 4, -600, 3.5, -0.16)
  }
  // charred robe scraps (debris) with a team-colour tinge, some trailing flame
  const nd = ctx.debris.budget(22 * k)
  for (let i = 0; i < nd; i++) {
    const a = omni ? rnd() * TAU : base + (rnd() - 0.5) * 1.5
    const sp = 160 + rnd() * 460
    const vh = 220 + rnd() * 320
    const life = 0.9 + rnd() * 0.6
    const g = 0.025 + rnd() * 0.02
    ctx.debris.spawn(x, y, h, Math.cos(a) * sp, Math.sin(a) * sp, vh, life, 6 + rnd() * 7, 4, g + v[0] * 0.05, g + v[1] * 0.05, g + v[2] * 0.05, -1500, 0.7, 0)
    if (i % 2 === 0) ps.spawn(x, y, h, Math.cos(a) * sp, Math.sin(a) * sp, vh, life * 0.6, 14, -4, c[0] * 1.4, c[1] * 0.9, c[2] * 0.5, -1500, 0.7, 4)
  }
  const ns2 = ctx.smoke.budget(10 * k)
  for (let i = 0; i < ns2; i++) {
    const a = omni ? rnd() * TAU : base + (rnd() - 0.5) * 1.2
    const sp = 120 + rnd() * 260
    ctx.smoke.spawn(x, y, h, Math.cos(a) * sp, Math.sin(a) * sp, 60 + rnd() * 80, 1.2 + rnd() * 0.8, 40, 140, 0.05, 0.035, 0.03, 30, 1.6, 16)
  }
}

/** Charred robe heap with cooling ember cracks + smoulder, elongated along (dx, dy). */
export function charHeap(ctx: VfxCtx, x: number, y: number, dx: number, dy: number, strength: number, tint: DeathTint, life = 3): void {
  const K = kit(ctx)
  const f = decalFloor(ctx, x, y)
  const k = Math.max(0.6, Math.min(1.6, strength))
  const c = tint.spell
  K.decals.spawn(D_CHAR, x, y, f, 62 * k, life, [c[0] * 3.2, c[1] * 3.2, c[2] * 3.2], 0, dx, dy, 1.35, 1)
  const e = K.emitter(E_SMOLDER, x, y, f + 6, life - 0.3)
  e.k = k
  setTint(e, tint)
}

function tickSmolder(ctx: VfxCtx, e: Emitter, t: number): void {
  const left = (e.t1 - t) / Math.max(0.1, e.t1 - e.t0)
  const n = emitN(ctx, e, 16 * e.k * left)
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU
    const rr = rnd() * 40 * e.k
    ctx.smoke.spawn(e.x + Math.cos(a) * rr, e.y + Math.sin(a) * rr, e.h, 0, 0, 50 + rnd() * 50, 1.3 + rnd() * 0.6, 18, 80, 0.045, 0.034, 0.03, 18, 0.6, 14)
    if (rnd() < 0.7) {
      const c = e.core
      ctx.particles.spawn(e.x + Math.cos(a) * rr, e.y + Math.sin(a) * rr, e.h, (rnd() - 0.5) * 30, (rnd() - 0.5) * 30, 60 + rnd() * 110, 0.7 + rnd() * 0.6, 5 + rnd() * 3, -1, c[0] * 1.4, c[1] * 0.75, c[2] * 0.3, 15, 0.4, 9)
    }
  }
}

/**
 * Ash pile that crumbles out of the body, then blows away downwind
 * (wind = unit direction, default from the camera's left). ash = linear ash
 * colour (stone dust for pillar deaths).
 */
export function ashPile(ctx: VfxCtx, x: number, y: number, o: { radius?: number; life?: number; windX?: number; windY?: number; ash?: readonly number[]; embers?: number } = {}): void {
  const K = kit(ctx)
  const f = decalFloor(ctx, x, y)
  const life = o.life ?? 3
  const wx = o.windX ?? 0.8
  const wy = o.windY ?? 0.35
  const ash = o.ash ?? [0.16, 0.15, 0.145]
  K.decals.spawn(D_ASH, x, y, f, o.radius ?? 54, life, ash, o.embers ?? 1, wx, wy, 1.15, 1)
  const e = K.emitter(E_ASHWIND, x, y, f + 4, life)
  e.dx = wx
  e.dy = wy
  e.victim[0] = ash[0]
  e.victim[1] = ash[1]
  e.victim[2] = ash[2]
}

function tickAshWind(ctx: VfxCtx, e: Emitter, t: number): void {
  const lt = (t - e.t0) / Math.max(0.1, e.t1 - e.t0)
  // the pile settles first, then the wind strips it (matches the decal erosion)
  const w = lt < 0.3 ? 0 : Math.sin(Math.min(1, (lt - 0.3) / 0.65) * Math.PI)
  const n = emitN(ctx, e, 46 * w)
  const a = e.victim
  for (let i = 0; i < n; i++) {
    const rr = rnd() * 40
    const aa = rnd() * TAU
    const sp = 90 + rnd() * 150
    const g = 0.7 + rnd() * 0.5
    ctx.smoke.spawn(e.x + Math.cos(aa) * rr, e.y + Math.sin(aa) * rr, e.h + rnd() * 10, e.dx * sp, e.dy * sp, 25 + rnd() * 45, 0.9 + rnd() * 0.7, 12, 46, a[0] * g, a[1] * g, a[2] * g, 10, 0.8, 10)
    if (rnd() < 0.5) ctx.debris.spawn(e.x + Math.cos(aa) * rr, e.y + Math.sin(aa) * rr, e.h + 2, e.dx * sp * 1.3, e.dy * sp * 1.3, 40 + rnd() * 60, 0.6 + rnd() * 0.5, 2.5 + rnd() * 2, 1, a[0] * 1.3, a[1] * 1.3, a[2] * 1.3, -200, 1.2, 0)
  }
}

/** Crater: dusty bowl with radial cracks; hot = 0..1 molten centre. */
export function crater(ctx: VfxCtx, x: number, y: number, radius: number, hot = 0, dust: readonly number[] = [0.2, 0.17, 0.14]): void {
  const K = kit(ctx)
  const f = decalFloor(ctx, x, y)
  K.decals.spawn(D_CRATER, x, y, f, radius, 3, dust, hot, 1, 0, 1, 1)
  const nd = ctx.debris.budget(18)
  for (let i = 0; i < nd; i++) {
    const a = rnd() * TAU
    const sp = 120 + rnd() * 260
    const g = 0.07 + rnd() * 0.05
    ctx.debris.spawn(x + Math.cos(a) * radius * 0.3, y + Math.sin(a) * radius * 0.3, f + 8, Math.cos(a) * sp, Math.sin(a) * sp, 200 + rnd() * 260, 0.7 + rnd() * 0.5, 5 + rnd() * 7, 3, g, g * 0.92, g * 0.85, -1600, 0.6, 0)
  }
  ctx.ground.spawn(RING_EXPAND, x, y, f + 1, radius * 0.3, radius * 1.05, 0.5, 10, dust[0] * 3, dust[1] * 3, dust[2] * 3)
}

/** Ice shards burst, frost patch, mist and glints. */
export function freezeShatter(ctx: VfxCtx, x: number, y: number, h: number, strength: number, tint: DeathTint): void {
  const K = kit(ctx)
  const f = decalFloor(ctx, x, y)
  const k = Math.max(0.5, Math.min(2, strength))
  const s = tint.spell
  K.decals.spawn(D_FROST, x, y, f, 70 * k, 2.8, [s[0] * 2.4, s[1] * 2.4, s[2] * 2.4], 0, 1, 0, 1, 1)
  const nd = ctx.debris.budget(30 * k)
  for (let i = 0; i < nd; i++) {
    const a = rnd() * TAU
    const sp = 150 + rnd() * 420
    ctx.debris.spawn(x, y, h + rnd() * BODY_H * 0.8, Math.cos(a) * sp, Math.sin(a) * sp, 120 + rnd() * 300, 0.7 + rnd() * 0.5, 5 + rnd() * 8, 3, 0.55, 0.75, 0.95, -1700, 0.5, 0)
  }
  const ns = ctx.particles.budget(40 * k)
  for (let i = 0; i < ns; i++) {
    const a = rnd() * TAU
    const sp = 300 + rnd() * 600
    ctx.particles.spawn(x, y, h + rnd() * BODY_H, Math.cos(a) * sp, Math.sin(a) * sp, rnd() * 300, 0.25 + rnd() * 0.25, 6, 1, s[0] * 3.5, s[1] * 3.5, s[2] * 3.5, -500, 2.5, -0.12)
  }
  const e = K.emitter(E_MIST, x, y, f + 6, 2.2)
  e.k = k
  setTint(e, tint)
}

function tickMist(ctx: VfxCtx, e: Emitter, t: number): void {
  const left = (e.t1 - t) / Math.max(0.1, e.t1 - e.t0)
  const n = emitN(ctx, e, 18 * e.k * left)
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU
    const rr = rnd() * 60 * e.k
    ctx.smoke.spawn(e.x + Math.cos(a) * rr, e.y + Math.sin(a) * rr, e.h, Math.cos(a) * 40, Math.sin(a) * 40, 25, 1.4, 24, 90, 0.42, 0.55, 0.66, 0, 1, 12)
    if (rnd() < 0.4) ctx.particles.spawn(e.x + Math.cos(a) * rr, e.y + Math.sin(a) * rr, e.h + rnd() * 40, 0, 0, 20, 0.35, 4, 1, 3, 3.6, 4.4, 0, 0, 0)
  }
}

/** Flickering skeletal silhouette flash (~0.35 s) in the spell colour, at the body. */
export function xrayFlash(ctx: VfxCtx, x: number, y: number, h: number, tint: DeathTint): void {
  const e = kit(ctx).emitter(E_XRAY, x, y, h, 0.38)
  setTint(e, tint)
}

function tickXray(ctx: VfxCtx, e: Emitter, t: number): void {
  const lt = t - e.t0
  const on = Math.sin(lt * 70) > -0.2 ? 1 : 0.15
  const k = (1 - lt / 0.38) * on
  if (k <= 0) return
  const s = e.spell
  const c = e.core
  const X = e.x * S
  const Z = -e.y * S
  // spine + skull + ribcage glow as stacked streaks (reads as a skeleton flash at game zoom)
  ctx.billboards.addStreak(X, (e.h + BODY_H * 0.5) * S, Z, 26 * S, 4.2, Math.PI / 2, c[0] * 2 * k, c[1] * 2 * k, c[2] * 2 * k, 1.4, 0)
  ctx.billboards.add(X, (e.h + BODY_H * 0.9) * S, Z, 34 * S, c[0] * 2.4 * k, c[1] * 2.4 * k, c[2] * 2.4 * k, 2.2)
  ctx.billboards.addStreak(X, (e.h + BODY_H * 0.62) * S, Z, 30 * S, 2.2, 0, s[0] * 2 * k, s[1] * 2 * k, s[2] * 2 * k, 1.6, 0)
  ctx.billboards.add(X, (e.h + BODY_H * 0.5) * S, Z, 120 * S, s[0] * 0.9 * k, s[1] * 0.9 * k, s[2] * 0.9 * k, 2)
  ctx.glow.add(e.x, e.y, 200, 0.9 * k, s[0], s[1], s[2])
}

/**
 * Full lava death: molten splash crown, burning ring on the lava, flames
 * on the thrashing, sinking body, smoke plume. Lava-coloured; the victim's
 * colour rises in the wisps (pair with disintegrate(kind 'lava')).
 */
export function sinkInLava(ctx: VfxCtx, pawnId: EntityId, x: number, y: number, strength: number, tint: DeathTint): void {
  const K = kit(ctx)
  const k = Math.max(0.6, Math.min(1.6, strength))
  const ps = ctx.particles
  const H = LAVA_H + 2
  // splash crown: molten droplets arc up and fall back (cooling to crimson)
  const n = ps.budget(64 * k)
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU
    const sp = 90 + rnd() * 260
    ps.spawn(x + Math.cos(a) * 18, y + Math.sin(a) * 18, H + 6, Math.cos(a) * sp, Math.sin(a) * sp, 380 + rnd() * 520, 0.65 + rnd() * 0.5, 9 + rnd() * 9, -3, 3.8, 1.5, 0.3, -1500, 0.4, -0.04)
  }
  // dark slag clots thrown with them
  const nd = ctx.debris.budget(16 * k)
  for (let i = 0; i < nd; i++) {
    const a = rnd() * TAU
    const sp = 70 + rnd() * 200
    ctx.debris.spawn(x, y, H + 10, Math.cos(a) * sp, Math.sin(a) * sp, 300 + rnd() * 380, 0.7 + rnd() * 0.4, 6 + rnd() * 6, 3, 0.06, 0.018, 0.01, -1600, 0.3, 0)
  }
  ctx.ground.spawn(RING_EXPAND, x, y, H, 20, 170, 0.8, 18, 3.4, 1.0, 0.14)
  ctx.ground.spawn(RING_EXPAND, x, y, H, 50, 260, 0.55, 8, 2.0, 0.5, 0.06)
  // burning ring + slag raft on the lava surface
  K.decals.spawn(D_BURNRING, x, y, H, 118 * k, 2.9, [2.6, 0.5, 0.06], 0, 1, 0, 1, 1)
  const rf = K.emitter(E_RINGFIRE, x, y, H, 2.6)
  rf.k = k
  // thrash + robe fire + plume follow the sinking body
  const e = K.emitter(E_LAVA, x, y, H, 2.8)
  e.pawn = pawnId
  e.k = k
  setTint(e, tint)
}

function tickRingFire(ctx: VfxCtx, e: Emitter, t: number): void {
  const lt = (t - e.t0) / Math.max(0.1, e.t1 - e.t0)
  const grow = 1 - Math.pow(1 - Math.min(1, lt * 1.7), 3)
  const R = 118 * e.k * 0.8 * (0.38 + 0.62 * grow)
  const n = emitN(ctx, e, 90 * e.k * (1 - lt))
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU
    const rr = R * (0.92 + rnd() * 0.16)
    ctx.particles.spawn(e.x + Math.cos(a) * rr, e.y + Math.sin(a) * rr, e.h + 2, Math.cos(a) * 20, Math.sin(a) * 20, 90 + rnd() * 130, 0.3 + rnd() * 0.3, 14 + rnd() * 10, -4, 3.4, 1.2, 0.18, 150, 1.4, 5)
  }
  if (!lowQ(ctx)) ctx.glow.add(e.x, e.y, R * 1.6, 0.55 * (1 - lt), 1.0, 0.32, 0.05)
}

function tickLava(ctx: VfxCtx, e: Emitter, t: number): void {
  const p = e.pawn >= 0 ? ctx.pawn(e.pawn) : null
  if (p) {
    e.x = p.x
    e.y = p.y
  }
  const lt = t - e.t0
  const ps = ctx.particles
  // how much of the body is still above the lava (sink ~ the character's own 1.9 s)
  const above = Math.max(0, 1 - Math.pow(Math.min(1, lt / 1.9), 1.6))
  const top = LAVA_H + BODY_H * above
  // robe on fire: flames lick up the remaining body
  if (above > 0.05) {
    const n = emitN(ctx, e, 120 * e.k * (0.4 + above))
    for (let i = 0; i < n; i++) {
      const a = rnd() * TAU
      const rr = BODY_R * (0.5 + rnd() * 0.6)
      const hh = LAVA_H + rnd() * (top - LAVA_H)
      ps.spawn(e.x + Math.cos(a) * rr, e.y + Math.sin(a) * rr, hh, Math.cos(a) * 25, Math.sin(a) * 25, 130 + rnd() * 170, 0.28 + rnd() * 0.28, 18 + rnd() * 16, -5, 3.6, 1.15, 0.2, 160, 1.5, 6)
    }
  }
  // thrashing: bursts of molten splash while it fights the pull
  e.acc2 += ctx.dt
  if (lt < 1.6 && e.acc2 > 0.16 + rnd() * 0.12) {
    e.acc2 = 0
    const a0 = rnd() * TAU
    const m = ps.budget(10)
    for (let i = 0; i < m; i++) {
      const a = a0 + (rnd() - 0.5) * 1.6
      const sp = 80 + rnd() * 200
      ps.spawn(e.x + Math.cos(a) * 22, e.y + Math.sin(a) * 22, LAVA_H + 6, Math.cos(a) * sp, Math.sin(a) * sp, 220 + rnd() * 300, 0.45 + rnd() * 0.3, 8 + rnd() * 6, -2, 3.6, 1.4, 0.25, -1500, 0.4, -0.04)
    }
    ctx.ground.spawn(RING_EXPAND, e.x, e.y, LAVA_H + 2, 15, 70, 0.4, 7, 2.6, 0.7, 0.1)
  }
  // smoke plume: thick dark column rising and leaning with the drift
  const sm = emitN(ctx, e, lt < 2.4 ? 26 * e.k : 0, 'acc3')
  for (let i = 0; i < sm; i++) {
    const g = 0.035 + rnd() * 0.03
    ctx.smoke.spawn(e.x + (rnd() - 0.5) * 40, e.y + (rnd() - 0.5) * 40, LAVA_H + 30 + rnd() * 40, 25 + (rnd() - 0.5) * 40, (rnd() - 0.5) * 30, 150 + rnd() * 120, 1.8 + rnd() * 0.8, 40, 170, g, g * 0.7, g * 0.6, 40, 0.5, 22)
  }
  // victim-colour wisps escaping the fire
  const v = e.victim
  if (lt < 2.2 && rnd() < ctx.dt * 22 * ctx.tier.particles) {
    ps.spawn(e.x + (rnd() - 0.5) * 30, e.y + (rnd() - 0.5) * 30, top + 10, (rnd() - 0.5) * 50, (rnd() - 0.5) * 50, 150 + rnd() * 120, 0.9 + rnd() * 0.6, 10, 3, v[0] * 2.2, v[1] * 2.2, v[2] * 2.2, 30, 1, 16)
  }
  if (!lowQ(ctx)) ctx.glow.add(e.x, e.y, 170, 0.8 * (0.3 + above), 1.0, 0.35, 0.06)
}

/** Shadow burn (Scourge): dark wisps eat the body from the edges, spell-colour veins on the floor. */
export function shadowBurn(ctx: VfxCtx, pawnId: EntityId, x: number, y: number, h: number, tint: DeathTint): void {
  const K = kit(ctx)
  const f = decalFloor(ctx, x, y)
  const s = tint.spell
  K.decals.spawn(D_SIGIL, x, y, f, 88, 2.9, [s[0] * 2.6, s[1] * 2.6, s[2] * 2.6], 0, 1, 0, 1, 1)
  const e = K.emitter(E_SHADOW, x, y, h, 2.2)
  e.pawn = pawnId
  setTint(e, tint)
  // collapse inward first: dark implosion ring + inward-sucked streaks
  ctx.ground.spawn(RING_IMPLODE, x, y, f + 1, 12, 150, 0.35, 12, s[0] * 1.8, s[1] * 1.8, s[2] * 1.8)
  const n = ctx.particles.budget(36)
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU
    const rr = 70 + rnd() * 60
    const hh = h + 20 + rnd() * 100
    const life = 0.22
    ctx.particles.spawn(x + Math.cos(a) * rr, y + Math.sin(a) * rr, hh, (-Math.cos(a) * rr) / life, (-Math.sin(a) * rr) / life, (h + 60 - hh) / life, life, 9, 2, s[0] * 2.6, s[1] * 2.6, s[2] * 2.6, 0, 0, -0.12)
  }
}

function tickShadow(ctx: VfxCtx, e: Emitter, t: number): void {
  const p = e.pawn >= 0 ? ctx.pawn(e.pawn) : null
  if (p) {
    e.x = p.x
    e.y = p.y
    e.h = p.h
  }
  const lt = (t - e.t0) / Math.max(0.1, e.t1 - e.t0)
  const peak = Math.sin(Math.min(1, lt * 1.3) * Math.PI)
  const n = emitN(ctx, e, 60 * peak)
  const s = e.spell
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU
    const rr = BODY_R * (0.8 + rnd() * 0.4)
    const hh = e.h + rnd() * BODY_H
    // near-black wisps with a blood-dark tint, curling up off the silhouette edge
    const g = 0.01 + rnd() * 0.012
    ctx.smoke.spawn(e.x + Math.cos(a) * rr, e.y + Math.sin(a) * rr, hh, Math.cos(a) * 30, Math.sin(a) * 30, 70 + rnd() * 80, 1.1 + rnd() * 0.6, 22, 70, g + s[0] * 0.02, g, g + s[2] * 0.015, 30, 0.8, 14)
    // spell-colour burning edge sparks
    if (rnd() < 0.6) ctx.particles.spawn(e.x + Math.cos(a) * rr, e.y + Math.sin(a) * rr, hh, Math.cos(a) * 50, Math.sin(a) * 50, 60 + rnd() * 100, 0.35 + rnd() * 0.3, 6 + rnd() * 4, 1, s[0] * 3.4, s[1] * 3.4, s[2] * 3.4, 40, 1.2, -0.05)
  }
  if (!lowQ(ctx)) ctx.glow.add(e.x, e.y, 130, 0.5 * peak, s[0] * 0.6, s[1] * 0.6, s[2] * 0.6)
}

/**
 * Crumble to dust (pillar deaths): the thrown body comes apart into falling
 * grit and a slumping dust cloud, leaving a dust pile.
 */
export function crumbleToDust(ctx: VfxCtx, pawnId: EntityId, x: number, y: number, h: number, dx: number, dy: number, strength: number, dust: readonly number[]): void {
  const K = kit(ctx)
  const e = K.emitter(E_CRUMBLE, x, y, h, 1.3)
  e.pawn = pawnId
  e.dx = dx
  e.dy = dy
  e.k = Math.max(0.6, Math.min(1.8, strength))
  e.victim[0] = dust[0]
  e.victim[1] = dust[1]
  e.victim[2] = dust[2]
  // impact: stone burst + shock of dust along the throw
  const base = Math.atan2(dy, dx)
  const omni = Math.hypot(dx, dy) < 1e-3
  const nd = ctx.debris.budget(30 * e.k)
  for (let i = 0; i < nd; i++) {
    const a = omni ? rnd() * TAU : base + (rnd() - 0.5) * 2
    const sp = 120 + rnd() * 380
    const g = dust[0] * (0.5 + rnd() * 0.6)
    ctx.debris.spawn(x, y, h + rnd() * BODY_H * 0.7, Math.cos(a) * sp, Math.sin(a) * sp, 150 + rnd() * 260, 0.7 + rnd() * 0.6, 6 + rnd() * 9, 3, g, g * 0.92, g * 0.82, -1600, 0.7, 0)
  }
  const ns = ctx.smoke.budget(18)
  for (let i = 0; i < ns; i++) {
    const a = omni ? rnd() * TAU : base + (rnd() - 0.5) * 2.4
    const sp = 120 + rnd() * 200
    ctx.smoke.spawn(x, y, h + 20 + rnd() * 60, Math.cos(a) * sp, Math.sin(a) * sp, 30, 1.5 + rnd() * 0.8, 46, 170, dust[0], dust[1] * 0.95, dust[2] * 0.9, 0, 1.5, 16)
  }
}

function tickCrumble(ctx: VfxCtx, e: Emitter, t: number): void {
  const p = e.pawn >= 0 ? ctx.pawn(e.pawn) : null
  if (p) {
    e.x = p.x
    e.y = p.y
    e.h = p.h
  }
  const lt = (t - e.t0) / Math.max(0.1, e.t1 - e.t0)
  // body sheds grit from the top down
  const top = e.h + BODY_H * (1 - lt * 0.9)
  const n = emitN(ctx, e, 70 * e.k * (1 - lt))
  const d = e.victim
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU
    const rr = BODY_R * rnd()
    const g = 0.6 + rnd() * 0.6
    ctx.debris.spawn(e.x + Math.cos(a) * rr, e.y + Math.sin(a) * rr, e.h + rnd() * (top - e.h), Math.cos(a) * 40, Math.sin(a) * 40, 20 + rnd() * 50, 0.5 + rnd() * 0.4, 3 + rnd() * 3.5, 1.5, d[0] * g, d[1] * g, d[2] * g, -1100, 0.5, 0)
    if (rnd() < 0.35) ctx.smoke.spawn(e.x + Math.cos(a) * rr * 1.5, e.y + Math.sin(a) * rr * 1.5, e.h + 6, Math.cos(a) * 70, Math.sin(a) * 70, 12, 1.2 + rnd() * 0.6, 24, 90, d[0] * 0.9, d[1] * 0.85, d[2] * 0.8, 0, 1.4, 8)
  }
}

/** Quiet fade to smoke (disconnect): soft column, faint victim-colour motes. No flash, no shake. */
export function fadeToSmoke(ctx: VfxCtx, pawnId: EntityId, x: number, y: number, h: number, tint: DeathTint): void {
  const e = kit(ctx).emitter(E_SMOKE, x, y, h, 2.4)
  e.pawn = pawnId
  setTint(e, tint)
}

function tickSmoke(ctx: VfxCtx, e: Emitter, t: number): void {
  const p = e.pawn >= 0 ? ctx.pawn(e.pawn) : null
  if (p) {
    e.x = p.x
    e.y = p.y
    e.h = p.h
  }
  const lt = (t - e.t0) / Math.max(0.1, e.t1 - e.t0)
  const w = Math.sin(Math.min(1, lt * 1.2) * Math.PI)
  const n = emitN(ctx, e, 26 * w)
  const v = e.victim
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU
    const rr = BODY_R * rnd()
    const g = 0.2 + rnd() * 0.08
    ctx.smoke.spawn(e.x + Math.cos(a) * rr, e.y + Math.sin(a) * rr, e.h + rnd() * BODY_H * 0.9, (rnd() - 0.5) * 20, (rnd() - 0.5) * 20, 50 + rnd() * 40, 1.6 + rnd() * 0.8, 30, 100, g, g * 1.02, g * 1.08, 15, 0.6, 18)
    if (rnd() < 0.45) ctx.particles.spawn(e.x + Math.cos(a) * rr, e.y + Math.sin(a) * rr, e.h + rnd() * BODY_H, 0, 0, 60 + rnd() * 60, 1.0 + rnd() * 0.5, 5, 2, v[0] * 1.1, v[1] * 1.1, v[2] * 1.1, 10, 0.5, 12)
  }
}

/** Just the rising runes (victim colour), e.g. for a spell's own death. */
export function soulRunes(ctx: VfxCtx, x: number, y: number, h: number, rgb: readonly number[], n = 6): void {
  const K = kit(ctx)
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rnd() * 0.6
    K.runes.spawn(x + Math.cos(a) * 18, y + Math.sin(a) * 18, h + BODY_H * (0.4 + rnd() * 0.5), Math.cos(a) * 25, Math.sin(a) * 25, 120 + rnd() * 110, 1.0 + rnd() * 0.5, 15 + rnd() * 9, rgb[0] * 3, rgb[1] * 3, rgb[2] * 3, 14 + rnd() * 16)
  }
}

/** Advance every timed death emitter. deaths.ts calls this once per frame. */
export function tickDeathKit(ctx: VfxCtx): void {
  if (!pools || pools.ctx !== ctx) return
  const K = pools
  const t = ctx.now
  for (const e of K.em) {
    if (e.type === E_NONE) continue
    if (t > e.t1) {
      e.type = E_NONE
      continue
    }
    switch (e.type) {
      case E_DISINT:
        tickDisint(ctx, K, e, t)
        break
      case E_SMOLDER:
        tickSmolder(ctx, e, t)
        break
      case E_ASHWIND:
        tickAshWind(ctx, e, t)
        break
      case E_LAVA:
        tickLava(ctx, e, t)
        break
      case E_RINGFIRE:
        tickRingFire(ctx, e, t)
        break
      case E_SHADOW:
        tickShadow(ctx, e, t)
        break
      case E_CRUMBLE:
        tickCrumble(ctx, e, t)
        break
      case E_SMOKE:
        tickSmoke(ctx, e, t)
        break
      case E_XRAY:
        tickXray(ctx, e, t)
        break
      case E_MIST:
        tickMist(ctx, e, t)
        break
      case E_GHOST:
        tickGhost(ctx, e, t)
        break
    }
  }
}

/** Make sure the GPU pools exist for this world (deaths.ts init). */
export function initDeathKit(ctx: VfxCtx): void {
  kit(ctx)
}
