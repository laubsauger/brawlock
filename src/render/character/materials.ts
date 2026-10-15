import * as THREE from 'three/webgpu'
import {
  Fn,
  abs,
  atan,
  attribute,
  clamp,
  cross,
  dFdx,
  dFdy,
  dot,
  exp,
  faceDirection,
  float,
  floor,
  fract,
  fwidth,
  length,
  max,
  min,
  mix,
  normalLocal,
  normalMap,
  normalView,
  normalize,
  positionGeometry,
  positionLocal,
  positionView,
  pow,
  saturate,
  select,
  sign,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  time,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import { U } from './gpuState'

/*
 * Warlock look (art/brand/splash.png): near-black fabric tinted toward the
 * player colour (dark teal, dark crimson ...) with a soft sheen and fold
 * detail, dark leather, aged metal, and player-colour emissive runes along
 * every robe edge plus sigils on the chest panel and cape. All materials are
 * shared by every warlock; per-pawn values come from gpuState.U (per-object
 * uniforms).
 */

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
const f = (n: unknown) => n as F
const v2 = (n: unknown) => n as V2
const v3 = (n: unknown) => n as V3

/** Rig-measured collision radii (set once at load) and the clipping debug switch. */
export const clothParams = {
  /** lower leg / boot capsule radius (m) */
  calfR: uniform(0.085),
  /** upper arm capsule radius (m) */
  armR: uniform(0.085),
  /** 1: robe-covered body parts render pure red, everything else black (preview clipping check) */
  debugClip: uniform(0),
}

const LUMA = vec3(0.2126, 0.7152, 0.0722)
const LEATHER = vec3(0.042, 0.027, 0.022)
const METAL = vec3(0.4, 0.3, 0.19)
const DUST = vec3(0.05, 0.043, 0.038)

/** near-black fabric with a hint of the player colour */
const fabric = (k = 1): V3 => v3(mix(vec3(0.011, 0.01, 0.013), U.team.mul(0.032), 0.55).mul(k))
const sheenColor = (): V3 => v3(mix(vec3(0.13, 0.12, 0.15), U.team.mul(0.3), 0.35))

function fresnel(power = 3): F {
  const viewDir = positionView.negate().normalize()
  return f(pow(float(1).sub(saturate(dot(normalView, viewDir))), power))
}

/** Hash of a cell id to 0..1. */
const hash = (x: F): F => f(fract(sin(x.mul(127.1).add(311.7)).mul(43758.5453)))

/** Distance from p to segment ab (2D). */
const segDist = (p: V2, a: V2, b: V2): F => {
  const pa = p.sub(a)
  const ba = b.sub(a)
  const h = clamp(dot(pa, ba).div(dot(ba, ba)), 0, 1)
  return f(length(pa.sub(ba.mul(h))))
}

/**
 * Rune glyph in a unit cell, picked by the cell hash: separator dot, ring,
 * diamond, or a branching stave rune. 0..1 coverage, antialiased.
 */
const glyph = Fn(([cellArg, pArg]: [unknown, unknown]) => {
  const cell = f(cellArg)
  const p = v2(pArg)
  const h0 = hash(cell.add(3.1))
  const h1 = hash(cell)
  const h2 = hash(cell.add(17.3))
  const h3 = hash(cell.add(41.9))
  const aa = max(fwidth(p.x), fwidth(p.y)).mul(1.2)
  const w = float(0.055)
  const c = p.sub(0.5)
  // stave rune
  let d = segDist(p, vec2(0.5, 0.1), vec2(0.5, 0.9))
  const dA = segDist(p, vec2(0.5, 0.72), select(h1.greaterThan(0.5), vec2(0.84, 0.45), vec2(0.16, 0.45)))
  const dB = segDist(p, vec2(0.5, 0.38), select(h2.greaterThan(0.5), vec2(0.82, 0.12), vec2(0.18, 0.12)))
  const barY = select(h3.greaterThan(0.5), float(0.64), float(0.36))
  const dC = segDist(p, vec2(0.2, barY), vec2(0.8, barY))
  d = min(d, select(h1.greaterThan(0.2), dA, float(9)))
  d = min(d, select(h2.greaterThan(0.3), dB, float(9)))
  d = min(d, select(h3.greaterThan(0.35), dC, float(9)))
  const stave = float(1).sub(smoothstep(w.sub(aa), w.add(aa), d))
  const ring = float(1).sub(smoothstep(w.sub(aa), w.add(aa), abs(length(c).sub(0.3)))).max(float(1).sub(smoothstep(0.07, float(0.07).add(aa), length(c))))
  const diamond = float(1).sub(smoothstep(w.sub(aa), w.add(aa), abs(abs(c.x).add(abs(c.y)).sub(0.32))))
  const dot0 = float(1).sub(smoothstep(0.1, float(0.1).add(aa), abs(c.x).add(abs(c.y))))
  return select(h0.lessThan(0.18), dot0, select(h0.lessThan(0.34), ring, select(h0.lessThan(0.48), diamond, stave)))
})

/**
 * Surface-gradient bump from a procedural height (metres): perturbs the
 * shading normal with screen-space derivatives, no tangents needed.
 */
function bumpNormal(h: F): V3 {
  const pv = positionView
  const dpdx = dFdx(pv)
  const dpdy = dFdy(pv)
  const n = normalView
  const r1 = cross(dpdy, n)
  const r2 = cross(n, dpdx)
  const det = dot(dpdx, r1)
  const grad = sign(det).mul(dFdx(h).mul(r1).add(dFdy(h).mul(r2)))
  return v3(normalize(abs(det).mul(n).sub(grad)))
}

/**
 * Shared fx on every warlock material: hit flash, lava burn licking up from
 * the hem, invulnerability shimmer, and the death burn-up (via opacity +
 * alphaTest). Heights are model metres (0 feet .. 1.9 hood tip).
 */
function applyFx(m: THREE.MeshStandardNodeMaterial, base: V3, emissive: V3, heightNode: F, cover?: F): void {
  const t = time
  const h01 = saturate(heightNode.div(1.9))
  const n1 = sin(heightNode.mul(37).add(t.mul(7)).add(positionGeometry.x.mul(55))).mul(0.5).add(0.5)
  const n2 = sin(positionGeometry.z.mul(61).sub(t.mul(5.3)).add(heightNode.mul(19))).mul(0.5).add(0.5)
  const flick = n1.mul(n2)
  const fr = fresnel(2)
  const burnMask = float(1).sub(smoothstep(0.05, 0.6, h01.sub(flick.mul(0.25))))
  // death looks: charred with ember cracks, frozen, withered
  const c1 = sin(positionGeometry.x.mul(91).add(heightNode.mul(57)))
  const c2 = sin(positionGeometry.z.mul(83).sub(heightNode.mul(71)).add(positionGeometry.x.mul(23)))
  const cracks = smoothstep(0.9, 0.99, abs(c1.mul(c2)).oneMinus())
  let col = v3(mix(base, base.mul(0.2), U.burn.mul(0.6)))
  col = v3(mix(col, vec3(0.012, 0.009, 0.008), U.char.mul(0.9)))
  const luma = dot(col, LUMA)
  col = v3(mix(col, vec3(luma, luma, luma).mul(vec3(0.75, 0.8, 0.7)), U.wither))
  col = v3(mix(col, vec3(0.32, 0.5, 0.68).mul(luma.mul(4).add(0.35)), U.freeze.mul(0.85)))
  let em = emissive.mul(float(1).sub(U.char.mul(0.7)).sub(U.wither.mul(0.6)).max(0))
  em = em.add(vec3(3.2, 0.9, 0.15).mul(U.burn.mul(flick.mul(1.4).add(0.2)).mul(burnMask)))
  em = em.add(vec3(3.5, 0.9, 0.12).mul(cracks.mul(U.char).mul(flick.mul(0.8).add(0.4))))
  em = em.add(vec3(0.6, 0.9, 1.4).mul(U.freeze.mul(fr.mul(1.2).add(0.05))))
  em = em.add(vec3(1.6, 2.2, 4.0).mul(U.xray.mul(fr.mul(2.5).add(0.25))))
  em = em.add(vec3(1.4, 1.4, 1.5).mul(U.flash))
  const shimmer = sin(t.mul(9).add(heightNode.mul(40))).mul(0.5).add(0.5)
  em = em.add(vec3(0.8, 1.2, 2.2).mul(U.invuln.mul(fr.mul(0.9).add(0.12)).mul(shimmer.mul(0.6).add(0.4))))
  // death: burn up from the feet with a hot edge in the dissolve colour
  const dis = U.dissolve.mul(1.3)
  const v = h01.mul(0.7).add(flick.mul(0.3))
  const edge = float(1).sub(smoothstep(0, 0.07, v.sub(dis))).mul(step(0.001, U.dissolve))
  em = em.add(U.dissolveColor.mul(edge))
  // clipping check: covered body parts pure red, the rest black (depth still written)
  const dbg = clothParams.debugClip
  const cv = cover ?? float(0)
  const red = step(0.5, cv).mul(step(cv, 1.5))
  const green = step(1.5, cv)
  m.colorNode = mix(col, vec3(0, 0, 0), dbg)
  m.emissiveNode = mix(em, vec3(red.mul(40), green.mul(40), 0), dbg)
  m.opacityNode = step(dis, v)
  m.alphaTest = 0.5
}

/** Silhouette rim: player tint plus cool moonlight so dark robes read on dark tiles. */
function rim(k = 1): V3 {
  return v3(U.team.mul(0.14).add(vec3(0.03, 0.04, 0.08)).mul(fresnel(3)).mul(k))
}

/** Eye glow spilling onto the hood interior / face void (model-space distance). */
function eyeSpill(k: number): V3 {
  const d = length(positionLocal.sub(U.eyes))
  const fall = exp(d.mul(d).div(-0.0035))
  return v3(mix(U.team, vec3(1, 1, 1), 0.3).mul(fall.mul(k).mul(float(1).add(U.castCharge).add(U.castFlare.mul(2)))))
}

// ------------------------------------------------------------------ outfit (CC0 ranger parts, recoloured)

export function createOutfitMaterial(src: THREE.MeshStandardMaterial): THREE.MeshPhysicalNodeMaterial {
  const m = new THREE.MeshPhysicalNodeMaterial()
  m.name = 'WarlockOutfit'
  // the hood is an open shell: its inside renders as part of the face void
  m.side = THREE.DoubleSide
  const bcTex = src.map!
  const ormTex = (src.roughnessMap ?? src.metalnessMap)!
  const nTex = src.normalMap!
  const bc = texture(bcTex).rgb
  const orm = texture(ormTex)
  const lum = dot(bc, LUMA)
  // the ranger atlas: green = fabric, brown = leather, ORM.b = metal
  const green = bc.g.sub(max(bc.r, bc.b))
  const isFabric = smoothstep(0.004, 0.03, green)
  const metal = smoothstep(0.35, 0.6, orm.b)
  const leather = float(1).sub(isFabric).mul(float(1).sub(metal))
  // keep the painted shading, swap the palette
  const shade = (ref: number) => clamp(lum.div(ref), 0.25, 2.2)
  const fabricCol = fabric(1.25).mul(shade(0.05))
  const leatherCol = LEATHER.mul(shade(0.12))
  const metalCol = METAL.mul(shade(0.3).mul(0.8).add(0.2))
  // inside of the hood (and anything else seen from behind near the face) = void
  const back = f(float(1).sub(step(0, faceDirection)))
  const nearFace = smoothstep(0.24, 0.13, length(positionLocal.sub(U.eyes)))
  const voidK = f(max(back.mul(nearFace), back.mul(0.6)))
  const base = v3(fabricCol.mul(isFabric).add(leatherCol.mul(leather)).add(metalCol.mul(metal)).mul(float(1).sub(voidK)))
  m.roughnessNode = mix(orm.g.mul(0.9).add(0.08), float(0.32), metal).max(mix(float(0), float(0.62), isFabric)).max(voidK)
  m.metalnessNode = metal.mul(float(1).sub(voidK))
  m.aoNode = orm.r.mul(0.7).add(0.3)
  m.sheenNode = sheenColor().mul(isFabric).mul(float(1).sub(voidK))
  m.sheenRoughnessNode = float(0.42)
  const ns = src.normalScale
  m.normalNode = normalMap(texture(nTex), vec2(ns.x, ns.y))
  // metal studs catch a little player colour; eye glow lights the hood inside
  const em = v3(rim().mul(float(1).sub(voidK)).add(U.team.mul(0.06).mul(metal)).add(eyeSpill(0.35).mul(float(1).sub(back.mul(0.7)))))
  applyFx(m, base, em, f(positionLocal.y), f(attribute('aCover', 'float')))
  return m
}

// ------------------------------------------------------------------ gloves (CC0 hands, recoloured)

export function createGloveMaterial(src: THREE.MeshStandardMaterial, palmLeftX: number): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial()
  m.name = 'WarlockGloves'
  const bc = texture(src.map!).rgb
  const lum = dot(bc, LUMA)
  const base = v3(vec3(0.035, 0.026, 0.024).mul(clamp(lum.div(0.25), 0.4, 1.8)))
  m.roughnessNode = float(0.55)
  m.metalnessNode = float(0)
  if (src.normalMap) m.normalNode = normalMap(texture(src.normalMap), vec2(src.normalScale.x, src.normalScale.y))
  // casting hand glows: palm / fingers of the casting side (bind pose x sign)
  const sideX = positionGeometry.x.mul(U.castSide)
  const handMask = smoothstep(palmLeftX - 0.04, palmLeftX + 0.06, sideX)
  const flicker = sin(time.mul(53)).mul(0.5).add(0.5)
  const charge = U.castCharge.mul(U.castCharge).add(U.castFlare.mul(2.5)).add(U.castFizzle.mul(flicker).mul(0.8))
  const em = v3(U.castColor.mul(charge.mul(2.2)).mul(handMask).add(rim(0.6)))
  applyFx(m, base, em, f(positionLocal.y))
  return m
}

// ------------------------------------------------------------------ hood void + eyes

export function createVoidMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial()
  m.name = 'WarlockVoid'
  const part = f(attribute('aPart', 'float'))
  const eye = step(0.5, part)
  const pulse = sin(time.mul(2.1).add(U.phase)).mul(0.08).add(0.92)
  const hot = mix(U.team, vec3(1, 1, 1), 0.45)
  const glow = hot.mul(float(5).add(U.castCharge.mul(5)).add(U.castFlare.mul(10)).mul(pulse).mul(U.runeBoost))
  // the void is black, faintly lit around the eyes
  m.colorNode = mix(mix(eyeSpill(0.12), glow, eye), vec3(0, 0, 0), clothParams.debugClip)
  m.opacityNode = step(U.dissolve.mul(1.3), float(0.92))
  m.alphaTest = 0.5
  return m
}

// ------------------------------------------------------------------ cloth (coat, tabard, cape, mantle, sleeves, panel, medallions)

/** Push p out of capsule (a, b, r), toward the cloth's outward side; k = strength. */
const pushOut = (p: V3, a: V3, b: V3, r: number | F, nOut: V3, k: F): V3 => {
  const ab = b.sub(a)
  const h = clamp(dot(p.sub(a), ab).div(dot(ab, ab).add(1e-6)), 0, 1)
  const c = a.add(ab.mul(h))
  const d0 = p.sub(c)
  const dist0 = length(d0)
  // a vertex the limb passed through is resolved to the cloth's outer side
  const s = dot(d0, nOut)
  const d1 = d0.sub(nOut.mul(min(s, 0).mul(2)))
  const dist1 = max(length(d1), 1e-5)
  const rr = typeof r === 'number' ? float(r) : r
  const pushed = c.add(d1.mul(rr.div(dist1)))
  const inside = float(1).sub(step(rr, dist0))
  return v3(mix(p, pushed, inside.mul(k)))
}

export function createClothMaterial(): THREE.MeshPhysicalNodeMaterial {
  const m = new THREE.MeshPhysicalNodeMaterial()
  m.name = 'WarlockCloth'
  m.side = THREE.DoubleSide
  const aC = attribute('aCloth', 'vec4')
  const aD = attribute('aDim', 'vec2')
  const w = f(aC.x)
  const L = f(aC.y)
  const kind = f(aC.z)
  const side = f(aC.w)
  const isK = (k: number) => f(float(1).sub(step(0.5, abs(kind.sub(k)))))
  const isCoat = isK(0)
  const isTabard = isK(1)
  const isCape = isK(2)
  const isMantle = isK(3)
  const isSleeve = isK(4)
  const isMedal = isK(5)
  const isPanel = isK(6)

  // ---- vertex: spring lag + flutter + billow, pendulum-clamped, pushed out of the limbs
  {
    const p0 = v3(positionLocal)
    const n0 = v3(normalLocal)
    // per-layer response: the tabard swings more than the coat, the mantle and sleeves less
    const gain = f(isCoat.add(isTabard.mul(1.35)).add(isCape).add(isMantle.mul(0.45)).add(isSleeve.mul(0.5)))
    const sway = mix(U.swayCoat, U.swayCape, isCape)
    const uvn = uv()
    const nh = v2(normalize(vec2(n0.x, n0.z).add(vec2(1e-4, 0))))
    let d = v2(vec2(sway.x, sway.z).mul(w).mul(gain))
    // ripples travelling around the hem, idle breathing sway, bell-like billow when moving
    const ph = uvn.x.mul(23).add(time.mul(6.1)).add(U.phase).add(uvn.y.mul(5))
    const wave = sin(ph).mul(sin(time.mul(3.3).add(uvn.x.mul(9)).add(U.phase.mul(1.7))))
    const amp = float(0.006).add(U.flutter.mul(0.04)).mul(w).mul(gain).mul(mix(float(1), float(1.5), isCape))
    const idle = sin(time.mul(1.3).add(U.phase).add(uvn.x.mul(2.5))).mul(0.008).mul(w).mul(gain)
    const billow = U.flutter.mul(0.07).mul(w).mul(isCoat.add(isTabard.mul(0.5)).add(isCape.mul(0.6)))
    d = v2(d.add(nh.mul(wave.mul(amp).add(idle).add(billow))))
    // pendulum: the hem keeps its length, so a big swing lifts it instead of
    // stretching, and it can never fold above its attachment
    const dl = max(length(d), 1e-5)
    const dmax = L.mul(0.92)
    d = v2(d.mul(min(float(1), dmax.div(dl))))
    const rise = L.sub(sqrt(max(L.mul(L).sub(dot(d, d)), 0)))
    let p = v3(p0.add(vec3(d.x, rise, d.y)))
    const nOut = v3(vec3(n0.x, 0, n0.z).normalize())
    const k = f(smoothstep(0.015, 0.12, w).mul(float(1).sub(isMedal).sub(isPanel)))
    // legs: thigh capsule starts a little below the hip joint (no waist bulge)
    const thighL = v3(mix(U.hipL, U.kneeL, 0.18))
    const thighR = v3(mix(U.hipR, U.kneeR, 0.18))
    p = pushOut(p, thighL, U.kneeL, 0.105, nOut, k)
    p = pushOut(p, U.kneeL, U.footL, clothParams.calfR, nOut, k)
    p = pushOut(p, thighR, U.kneeR, 0.105, nOut, k)
    p = pushOut(p, U.kneeR, U.footR, clothParams.calfR, nOut, k)
    // torso keeps the cape off the back, upper arms keep the mantle above them
    const kBody = f(k.mul(isCape.add(isMantle)))
    p = pushOut(p, U.pelvis, U.chest, 0.17, nOut, kBody)
    // the cape drapes over the coat: keep it outside a cone around the hips
    // (only while upright; lying poses skip it)
    const rel = vec2(p.x.sub(U.pelvis.x), p.z.sub(U.pelvis.z))
    const rl = max(length(rel), 1e-4)
    const tt = saturate(float(1.02).sub(p.y).div(0.95))
    const rc = mix(float(0.21), float(0.45), pow(tt, 1.5))
    const outR = rel.mul(max(rl, rc).div(rl))
    const kCone = f(k.mul(isCape).mul(smoothstep(0.6, 0.85, U.pelvis.y)))
    p = v3(mix(p, vec3(U.pelvis.x.add(outR.x), p.y, U.pelvis.z.add(outR.y)), kCone))
    // the whole mantle stays outside the upper arms (shoulders raise into it when casting)
    const kArm = f(isMantle)
    p = pushOut(p, U.armL0, U.armL1, clothParams.armR, nOut, kArm)
    p = pushOut(p, U.armR0, U.armR1, clothParams.armR, nOut, kArm)
    m.positionNode = p
  }

  // ---- fragment: fabric, folds, trims, runes, sigils
  const uvn = uv()
  const rowW = f(aD.x)
  const len = f(aD.y)
  const fromHem = f(float(1).sub(uvn.y).mul(len))
  const fromTop = f(uvn.y.mul(len))
  const fromSide = f(min(uvn.x, float(1).sub(uvn.x)).mul(rowW))
  const um = f(uvn.x.mul(rowW))
  const isFabric = f(float(1).sub(isMedal))
  // which edges carry trim: hem everywhere; slit / vent edges on the coat, all
  // sides on tabard / cape / panel, the front opening on the mantle; sleeves the cuff
  const sideTrim = isCoat.add(isTabard).add(isCape).add(isMantle).add(isPanel)
  const BAND = 0.034
  const hemBand = f(float(1).sub(step(BAND, fromHem)).mul(float(1).sub(isPanel)))
  const sideBand = f(float(1).sub(step(BAND, fromSide)).mul(sideTrim))
  const band = f(max(hemBand, sideBand).mul(isFabric))
  // distance into the band (0 at the outer edge) and the coordinate along it
  const across = f(select(hemBand.greaterThan(sideBand), fromHem, fromSide))
  const along = f(select(hemBand.greaterThan(sideBand), um, fromTop))
  const aaL = fwidth(across).mul(1.5)
  const line = (c: number, wdt: number) => float(1).sub(smoothstep(float(wdt).sub(aaL), float(wdt).add(aaL), abs(across.sub(c))))
  const edgeLine = line(0.004, 0.0021)
  const innerLine = line(BAND - 0.005, 0.0009)
  const CELL = 0.03
  const cellId = floor(along.div(CELL))
  const gp = vec2(fract(along.div(CELL)).mul(1.25).sub(0.125), across.sub(0.0095).div(BAND - 0.0185))
  const inGlyph = step(0, gp.y).mul(step(gp.y, 1))
  const g = f(glyph(cellId.add(kind.mul(97)), vec2(gp.x, gp.y)))
  // central rune column on the tabard and the chest panel
  const colX = abs(uvn.x.sub(0.5)).mul(rowW)
  const colGp = vec2(colX.div(0.034).add(0.5), fract(fromTop.div(0.036)))
  const colG = f(glyph(floor(fromTop.div(0.036)).add(300), colGp).mul(step(colX, 0.017)).mul(isTabard.add(isPanel)).mul(step(0.04, fromTop)))
  // cape back sigil: two rings with runes between them and one at the centre
  const capeC = vec2(um.sub(rowW.mul(0.5)), fromTop.sub(0.4))
  const cr = length(capeC)
  const aaS = fwidth(cr).mul(1.5)
  const ringS = (r: number, wdt: number) => float(1).sub(smoothstep(float(wdt).sub(aaS), float(wdt).add(aaS), abs(cr.sub(r))))
  const ang = atan(capeC.y, capeC.x).div(Math.PI * 2).add(0.5)
  const sigGp = vec2(fract(ang.mul(8)), cr.sub(0.083).div(0.03))
  const sigRunes = f(glyph(floor(ang.mul(8)).add(500), sigGp).mul(step(0, sigGp.y)).mul(step(sigGp.y, 1)))
  const sigCore = f(glyph(float(777), capeC.div(0.07).add(0.5)).mul(step(cr, 0.05)))
  const sigil = f(max(max(ringS(0.12, 0.0022), ringS(0.078, 0.0013)), max(sigRunes, sigCore)).mul(isCape))
  // edge lines brightest, runes softer; a slow pulse travels along the trims
  const pulse = sin(along.mul(9).sub(time.mul(1.8)).add(U.phase)).mul(0.5).add(0.5)
  const runeMask = f(
    edgeLine
      .mul(1.3)
      .add(innerLine.mul(0.7))
      .add(g.mul(inGlyph).mul(0.75))
      .mul(band)
      .add(colG.mul(0.8))
      .add(sigil.mul(0.7)),
  )
  // sleeves: casting arm runes charge with the windup
  const castArm = f(isSleeve.mul(step(0.5, side.mul(U.castSide))))
  const flicker = sin(time.mul(53)).mul(0.5).add(0.5)
  const castGlow = U.castCharge.mul(U.castCharge).mul(3).add(U.castFlare.mul(6)).add(U.castFizzle.mul(flicker).mul(2))
  const runeCol = mix(U.team, U.castColor, castArm.mul(saturate(castGlow)))
  const runeInt = f(float(0.55).add(pulse.mul(0.45)).mul(U.runeBoost).add(castArm.mul(castGlow)))

  // base: player-tinted near-black outside, lining a shade of the player colour,
  // embroidered band under the runes, ash dust and wear along the hem
  const back = f(float(1).sub(step(0, faceDirection)))
  const wear = sin(um.mul(97)).mul(sin(fromTop.mul(41))).mul(0.5).add(0.5)
  let base = v3(fabric(1).mul(float(0.85).add(wear.mul(0.3))))
  base = v3(mix(base, U.team.mul(0.045).add(vec3(0.008, 0.007, 0.009)), back))
  base = v3(mix(base, U.team.mul(0.05).add(vec3(0.01, 0.008, 0.011)), band.mul(float(1).sub(back))))
  base = v3(mix(base, DUST, smoothstep(0.14, 0.0, fromHem).mul(0.55).mul(wear.mul(0.5).add(0.5)).mul(isCoat.add(isCape).add(isTabard))))
  // medallions: gold rim, glowing player-colour gem
  const r01 = f(aD.x.div(max(aD.y, 1e-4)))
  const gem = f(float(1).sub(smoothstep(0.5, 0.6, r01)))
  base = v3(mix(base, mix(METAL, vec3(0.02, 0.02, 0.02), gem), isMedal))
  m.metalnessNode = isMedal.mul(float(1).sub(gem))
  m.roughnessNode = mix(float(0.8), float(0.3), isMedal)
  m.sheenNode = sheenColor().mul(isFabric)
  m.sheenRoughnessNode = float(0.38)

  // folds: soft vertical drapes deepening toward the hem, plus a fine weave
  // that fades out before it can alias
  {
    const deep = smoothstep(0.05, 0.9, uvn.y).mul(isCoat.add(isCape).add(isTabard.mul(0.5)).add(isMantle.mul(0.6)))
    const warp = sin(fromTop.mul(5.5).add(um.mul(3))).mul(1.4)
    const folds = sin(um.mul((Math.PI * 2) / 0.085).add(warp)).mul(0.004).mul(deep)
    const fine = sin(um.mul((Math.PI * 2) / 0.032).add(fromTop.mul(4))).mul(0.0012).mul(deep)
    const wPer = 0.0035
    const weaveFade = float(1).sub(smoothstep(0.25, 0.6, max(fwidth(um), fwidth(fromTop)).div(wPer)))
    const weave = sin(um.mul((Math.PI * 2) / wPer)).mul(sin(fromTop.mul((Math.PI * 2) / wPer))).mul(0.00015).mul(weaveFade)
    m.normalNode = bumpNormal(f(folds.add(fine).add(weave).mul(isFabric)))
  }

  let em = v3(runeCol.mul(runeMask.mul(runeInt)).mul(float(1).sub(back.mul(0.85))))
  em = v3(em.add(U.team.mul(gem.mul(isMedal).mul(float(3).add(U.castFlare.mul(4))).mul(pulse.mul(0.3).add(0.7)))))
  em = v3(em.add(rim(0.8)).add(eyeSpill(0.25).mul(isMantle)))
  applyFx(m, base, em, f(positionLocal.y))
  return m
}

// ------------------------------------------------------------------ staff

export function createStaffMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial()
  m.name = 'WarlockStaff'
  const part = f(attribute('aPart', 'float'))
  const isMetal = f(float(1).sub(step(0.5, abs(part.sub(1)))))
  const isCrystal = f(step(1.5, part))
  const grain = sin(positionGeometry.y.mul(180).add(sin(positionGeometry.x.mul(400)).mul(2))).mul(0.25).add(0.75)
  const wood = vec3(0.05, 0.03, 0.02).mul(grain)
  const base = v3(mix(mix(wood, METAL.mul(0.7), isMetal), U.castColor.mul(0.2), isCrystal))
  m.metalnessNode = isMetal
  m.roughnessNode = mix(mix(float(0.7), float(0.35), isMetal), float(0.1), isCrystal)
  const charge = U.castCharge.add(U.castFlare.mul(2))
  const em = v3(U.castColor.mul(isCrystal.mul(float(1.2).add(charge.mul(6)))).add(rim(0.5)))
  applyFx(m, base, em, f(positionGeometry.y.add(1)))
  return m
}
