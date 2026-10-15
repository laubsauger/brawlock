import * as THREE from 'three/webgpu'
import {
  abs,
  atan,
  attribute,
  bumpMap,
  dot,
  exp,
  float,
  length,
  max,
  min,
  mix,
  normalView,
  normalWorld,
  positionGeometry,
  positionLocal,
  positionView,
  pow,
  saturate,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  vec2,
  vec3,
} from 'three/tsl'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { S } from '../coords'
import { asF, gamePos, type WorldCtx } from './world'

/**
 * Placeholder warlock built from primitives (until rigged glTF characters):
 * bell robe, team-colour mantle and trims, deep hood with glowing eyes, and a
 * separate staff with a crystal so the cast pose can animate it. Built in game
 * units (height ~110, hem radius ~34 vs. collision radius 30), forward = +z.
 */

const ROBE = 0
const TRIM = 1
const MANTLE = 2
const HOOD = 3
const VOID = 4
const EYES = 5
const WOOD = 6
const CRYSTAL = 7
const CAPE = 8

/** Visual scale over the modelling units: reads better at gameplay zoom. */
export const MODEL_SCALE = 1.2
/** Hand position the staff pivots on (game units, model space). */
export const STAFF_PIVOT = new THREE.Vector3(25, 48, 13)
/** Crystal tip position relative to the staff pivot. */
export const STAFF_TIP = new THREE.Vector3(0, 100, 0)

function tag(g: THREE.BufferGeometry, part: number): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g
  const n = ng.getAttribute('position').count
  ng.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(n).fill(part), 1))
  if (!ng.getAttribute('uv')) ng.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2))
  return ng
}

function limb(from: THREE.Vector3, to: THREE.Vector3, r0: number, r1: number): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(to, from)
  const len = dir.length()
  const g = new THREE.CylinderGeometry(r1, r0, len, 8, 1)
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize())
  g.applyQuaternion(q)
  const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5)
  g.translate(mid.x, mid.y, mid.z)
  return g
}

let bodyGeo: THREE.BufferGeometry | null = null
let staffGeo: THREE.BufferGeometry | null = null

export function getBodyGeometry(): THREE.BufferGeometry {
  if (bodyGeo) return bodyGeo
  const parts: THREE.BufferGeometry[] = []
  const profile = [
    [0.01, 0],
    [33, 0],
    [34.5, 4],
    [31, 20],
    [26, 40],
    [22, 56],
    [19.5, 66],
    [15, 76],
    [8, 82],
    [0.01, 84],
  ].map(([r, y]) => new THREE.Vector2(r, y))
  parts.push(tag(new THREE.LatheGeometry(profile, 18), ROBE))

  const hem = new THREE.TorusGeometry(33.2, 2.6, 6, 28)
  hem.rotateX(Math.PI / 2)
  hem.translate(0, 3, 0)
  parts.push(tag(hem, TRIM))

  const belt = new THREE.TorusGeometry(23.6, 2.3, 6, 24)
  belt.rotateX(Math.PI / 2)
  belt.translate(0, 47, 0)
  parts.push(tag(belt, TRIM))

  // a front panel stripe so the facing reads even from above
  const stripe = new THREE.BoxGeometry(7, 44, 3)
  stripe.rotateX(-0.2)
  stripe.translate(0, 24, 29)
  parts.push(tag(stripe, TRIM))

  const mantle = new THREE.SphereGeometry(24, 18, 8, 0, Math.PI * 2, 0, Math.PI * 0.5)
  mantle.scale(1.2, 0.6, 1.05)
  mantle.translate(0, 64, -1)
  parts.push(tag(mantle, MANTLE))

  const mantleEdge = new THREE.TorusGeometry(24, 2, 6, 28)
  mantleEdge.rotateX(Math.PI / 2)
  mantleEdge.scale(1.2, 1, 1.05)
  mantleEdge.translate(0, 64, -1)
  parts.push(tag(mantleEdge, TRIM))

  // cape: an open shell hanging behind, widening to the hem; the most
  // cloth-weighted part, so it streams behind dashes and knockbacks
  const capeProfile = [
    [25, 74],
    [29, 60],
    [33, 40],
    [37, 20],
    [39.5, 5],
  ].map(([r, y]) => new THREE.Vector2(r, y))
  const cape = new THREE.LatheGeometry(capeProfile, 14, Math.PI - 1.25, 2.5)
  parts.push(tag(cape, CAPE))

  const hood = new THREE.SphereGeometry(15.5, 16, 12)
  hood.scale(1, 1.08, 1.08)
  hood.translate(0, 89, -1)
  parts.push(tag(hood, HOOD))

  const peak = new THREE.ConeGeometry(11, 26, 12)
  peak.rotateX(-0.55)
  peak.translate(0, 104, -8)
  parts.push(tag(peak, HOOD))

  const face = new THREE.SphereGeometry(11.5, 14, 10)
  face.scale(1, 1.05, 0.62)
  face.translate(0, 87.5, 8)
  parts.push(tag(face, VOID))

  for (const sx of [-1, 1]) {
    const eye = new THREE.SphereGeometry(2.5, 8, 6)
    eye.scale(1.2, 0.8, 0.8)
    eye.translate(sx * 4.6, 89, 14.2)
    parts.push(tag(eye, EYES))
  }

  // sleeves: right arm reaches for the staff, left arm hangs forward
  parts.push(tag(limb(new THREE.Vector3(18, 68, 0), STAFF_PIVOT, 6.5, 8.5), ROBE))
  parts.push(tag(limb(new THREE.Vector3(-18, 68, 0), new THREE.Vector3(-17, 45, 9), 6.5, 8.5), ROBE))
  for (const p of [STAFF_PIVOT, new THREE.Vector3(-17, 45, 9)]) {
    const cuff = new THREE.TorusGeometry(8.4, 1.6, 5, 12)
    cuff.rotateX(Math.PI / 2)
    cuff.translate(p.x, p.y + 2, p.z)
    parts.push(tag(cuff, TRIM))
  }

  const merged = mergeGeometries(parts, false)
  if (!merged) throw new Error('pawnModel: merge failed')
  merged.scale(S * MODEL_SCALE, S * MODEL_SCALE, S * MODEL_SCALE)
  merged.computeBoundingSphere()
  bodyGeo = merged
  return merged
}

export function getStaffGeometry(): THREE.BufferGeometry {
  if (staffGeo) return staffGeo
  const parts: THREE.BufferGeometry[] = []
  const shaft = new THREE.CylinderGeometry(1.8, 2.4, 146, 6)
  shaft.translate(0, 146 / 2 - STAFF_PIVOT.y, 0)
  parts.push(tag(shaft, WOOD))
  const claw = new THREE.TorusGeometry(7, 1.5, 5, 12, Math.PI * 1.6)
  claw.rotateZ(-Math.PI * 0.3)
  claw.translate(0, STAFF_TIP.y - 4, 0)
  parts.push(tag(claw, WOOD))
  const crystal = new THREE.OctahedronGeometry(6.5, 0)
  crystal.scale(1, 1.7, 1)
  crystal.translate(0, STAFF_TIP.y, 0)
  parts.push(tag(crystal, CRYSTAL))
  const merged = mergeGeometries(parts, false)
  if (!merged) throw new Error('pawnModel: staff merge failed')
  merged.scale(S * MODEL_SCALE, S * MODEL_SCALE, S * MODEL_SCALE)
  merged.computeBoundingSphere()
  staffGeo = merged
  return merged
}

export interface PawnUniforms {
  team: ReturnType<typeof makeColorUniform>
  flash: ReturnType<typeof makeFloatUniform>
  burn: ReturnType<typeof makeFloatUniform>
  invuln: ReturnType<typeof makeFloatUniform>
  dissolve: ReturnType<typeof makeFloatUniform>
  cast: ReturnType<typeof makeFloatUniform>
  /** cloth lag at the hem, model-local world units (x, z); y unused */
  sway: ReturnType<typeof makeVec3Uniform>
  /** 0..1 hem flutter from fast movement */
  flutter: ReturnType<typeof makeFloatUniform>
  /** per-pawn phase so robes do not flutter in sync */
  phase: ReturnType<typeof makeFloatUniform>
  /** hit flash strength (scaled by damage / knockback of the hit) */
  flashK: ReturnType<typeof makeFloatUniform>
  /** 0..1 below 30 % HP: red pulse on the rim */
  lowHp: ReturnType<typeof makeFloatUniform>
  /** 1 -> 0 after a heal: soft green glow */
  heal: ReturnType<typeof makeFloatUniform>
  /** dissolve edge colour (burn-up orange on death, arcane cyan on teleport) */
  dissolveColor: ReturnType<typeof makeColorUniform>
  /** 1 -> 0 after a teleport arrival: cyan rim flash */
  arrive: ReturnType<typeof makeFloatUniform>
}

const makeVec3Uniform = () => uniform(new THREE.Vector3())
const makeColorUniform = () => uniform(new THREE.Color())
const makeFloatUniform = () => uniform(0)

const pick = (part: ReturnType<typeof asF>, k: number) => float(1).sub(step(0.5, abs(part.sub(k))))

export function createPawnMaterial(ctx: WorldCtx): { material: THREE.MeshStandardNodeMaterial; u: PawnUniforms } {
  const u: PawnUniforms = {
    team: makeColorUniform(),
    flash: makeFloatUniform(),
    burn: makeFloatUniform(),
    invuln: makeFloatUniform(),
    dissolve: makeFloatUniform(),
    cast: makeFloatUniform(),
    sway: makeVec3Uniform(),
    flutter: makeFloatUniform(),
    phase: makeFloatUniform(),
    flashK: makeFloatUniform(),
    lowHp: makeFloatUniform(),
    heal: makeFloatUniform(),
    dissolveColor: makeColorUniform(),
    arrive: makeFloatUniform(),
  }
  u.dissolveColor.value.setRGB(4.5, 1.4, 0.25)
  const t = ctx.uTime
  const part = asF(attribute('aPart', 'float'))
  const team = u.team

  const pRobe = pick(part, ROBE)
  const pTrim = pick(part, TRIM)
  const pMantle = pick(part, MANTLE)
  const pHood = pick(part, HOOD)
  const pEyes = pick(part, EYES)
  const pWood = pick(part, WOOD)
  const pCrystal = pick(part, CRYSTAL)
  const pCape = pick(part, CAPE)

  const base = vec3(0.05, 0.044, 0.06)
    .mul(pRobe.add(pHood))
    .add(team.mul(0.85).mul(pTrim))
    .add(team.mul(0.42).mul(pMantle))
    .add(vec3(0.1, 0.06, 0.035).mul(pWood))
    .add(team.mul(0.3).mul(pCrystal))
    .add(team.mul(0.16).add(vec3(0.02, 0.018, 0.024)).mul(pCape))

  const h01 = positionGeometry.y.div(110 * S * MODEL_SCALE)
  const viewDir = positionView.negate().normalize()
  const ndv = saturate(dot(normalView, viewDir))
  const rimF = pow(float(1).sub(ndv), 3)

  let em = team.mul(0.32).mul(pTrim)
  em = em.add(mix(team, vec3(1, 1, 1), 0.35).mul(5).mul(pEyes))
  em = em.add(team.mul(u.cast.mul(8).add(1.4)).add(vec3(1, 1, 1).mul(u.cast.mul(3))).mul(pCrystal))
  // silhouette rim: team tint plus cool moonlight, keeps dark robes readable on dark tiles
  em = em.add(team.mul(0.28).add(vec3(0.05, 0.07, 0.14)).mul(rimF).mul(float(1).sub(pEyes)))
  // hit: a split-second hot-white core that cools into a red tint, scaled by the hit
  const hot = smoothstep(0.72, 1.0, u.flash)
  const hitCol = mix(vec3(2.4, 0.14, 0.07), vec3(3.4, 3.1, 2.8), hot)
  em = em.add(hitCol.mul(u.flash).mul(u.flashK).mul(rimF.mul(0.6).add(0.55)))
  // below 30 % HP: a faint persistent red pulse on the rim
  const lowPulse = sin(t.mul(6.5)).mul(0.5).add(0.5)
  em = em.add(vec3(1.4, 0.06, 0.04).mul(u.lowHp).mul(rimF.mul(0.9).add(0.12)).mul(lowPulse.mul(0.7).add(0.3)))
  // heal: soft green wash
  em = em.add(vec3(0.25, 1.3, 0.45).mul(u.heal).mul(rimF.mul(0.7).add(0.25)))
  // lava light: the closer to the shore (or standing in it), the more the
  // robe is lit orange from below and the sides
  const sdP = ctx.field.sample(gamePos())
  const lavaNear = exp(min(sdP, 0).div(170))
  const fromBelow = float(0.65).sub(normalWorld.y.mul(0.45))
  em = em.add(vec3(1.0, 0.34, 0.07).mul(base.mul(3).add(0.025)).mul(lavaNear).mul(fromBelow))
  // burning: flickering orange licking up from the hem
  const n = texture(ctx.noise, vec2(positionGeometry.x.add(positionGeometry.z).mul(2.2), positionGeometry.y.mul(1.4).sub(t.mul(1.6))))
  const flicker = n.r.mul(1.3).add(sin(t.mul(29)).mul(0.15))
  const burnMask = float(1).sub(smoothstep(0.15, 0.85, h01.sub(n.g.mul(0.3))))
  em = em.add(vec3(3.2, 0.95, 0.16).mul(u.burn.mul(flicker).mul(burnMask.add(0.15))))
  // invulnerability shimmer
  const shimmer = sin(t.mul(9).add(positionGeometry.y.mul(80))).mul(0.5).add(0.5)
  em = em.add(vec3(1.0, 1.5, 2.6).mul(u.invuln.mul(rimF.mul(0.8).add(0.15)).mul(shimmer.mul(0.6).add(0.4))))
  // death: burn-up from the feet with a hot edge
  const dis = u.dissolve.mul(1.25)
  const v = h01.mul(0.65).add(n.b.mul(0.35))
  const edge = float(1).sub(smoothstep(0, 0.08, v.sub(dis))).mul(step(0.001, u.dissolve))
  em = em.add(u.dissolveColor.mul(edge))
  // teleport arrival: arcane rim flash
  em = em.add(vec3(0.9, 1.8, 3.2).mul(u.arrive).mul(rimF.mul(1.2).add(0.3)))

  // ---- faked cloth: the robe hem and mantle lag behind velocity changes
  // (CPU spring in PawnView feeds u.sway), ripple when moving fast, settle
  // when idle. Weight grows toward the hem; head, eyes and staff stay rigid.
  const cloth = pRobe.add(pTrim).add(pMantle).add(pCape)
  const hemW = pow(saturate(float(1).sub(h01.div(0.8))), 1.5)
    .mul(float(1).add(pCape.mul(0.9)))
    .add(pMantle.mul(0.35))
  const w = cloth.mul(hemW)
  const pg = positionGeometry
  const radial = vec2(pg.x, pg.z)
  const rlen = max(length(radial), 0.0001)
  const ang = atan(pg.z, pg.x)
  const ripple = sin(ang.mul(5).add(t.mul(13)).add(u.phase)).mul(sin(ang.mul(3).sub(t.mul(7.3)))).mul(u.flutter).mul(2.6 * S * MODEL_SCALE)
  // clamp the lag so the hem never folds through the body
  const swayRaw = vec2(u.sway.x, u.sway.z)
  const swayLen = length(swayRaw)
  const maxLag = 20 * S * MODEL_SCALE
  const sway = swayRaw.mul(min(float(1), float(maxLag).div(max(swayLen, 0.00001))))
  const dispXZ = sway.add(radial.div(rlen).mul(ripple)).mul(w)
  const lift = min(swayLen, maxLag).mul(0.3).mul(w)
  // keep displaced cloth outside the body/leg capsule (radius grows from
  // legs to hips), pushing out along the capsule normal
  const moved = radial.add(dispXZ)
  const mlen = max(length(moved), 0.00001)
  // vertices that start inside the core (robe top cap, mantle dome) are left alone
  const coreR = min(mix(float(13 * S * MODEL_SCALE), float(19 * S * MODEL_SCALE), saturate(h01.div(0.55))), rlen)
  const outXZ = moved.mul(max(mlen, coreR).div(mlen))
  const clothPos = vec3(outXZ.x, pg.y.add(lift), outXZ.y)

  const m = new THREE.MeshStandardNodeMaterial()
  m.name = 'Warlock'
  m.positionNode = mix(positionLocal, clothPos, step(0.5, cloth))
  m.colorNode = mix(base, base.mul(0.25), u.burn.mul(0.5))
  // fabric weave + folds on cloth, worn metal on the trims, glassy crystal
  const pg2 = positionGeometry.div(S * MODEL_SCALE)
  // (no fine weave: at gameplay distance it aliases into stripes) soft vertical folds only
  const folds = texture(ctx.noise, vec2(atan(pg2.z, pg2.x).mul(0.45), pg2.y.mul(0.006))).r
  const metalH = texture(ctx.noise, pg2.xz.mul(0.05).add(pg2.y.mul(0.03))).g
  m.normalNode = bumpMap(folds.mul(cloth.add(pHood)).add(metalH.mul(pTrim).mul(0.4)), float(0.35))
  const clothRough = float(0.72).add(folds.sub(0.5).mul(0.25))
  m.roughnessNode = mix(mix(clothRough, float(0.32).add(metalH.mul(0.25)), pTrim), float(0.2), max(pCrystal, pEyes))
  // no environment map: keep metalness low or the trims go black
  m.metalnessNode = pTrim.mul(0.25)
  m.emissiveNode = em
  m.opacityNode = step(dis, v)
  m.alphaTest = 0.5
  // the cape is an open shell
  m.side = THREE.DoubleSide
  return { material: m, u }
}
