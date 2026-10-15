import * as THREE from 'three/webgpu'
import {
  abs,
  attribute,
  bumpMap,
  dot,
  exp,
  float,
  floor,
  fract,
  max,
  min,
  mix,
  normalGeometry,
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
  time,
  uniform,
  vec2,
  vec3,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import { getNoiseTexture } from '../noiseTexture'
import { loadSurface, type SurfaceMaps } from '../textures'

/**
 * Shared prop materials. One stone material per look (temple, volcanic,
 * overgrown); every pillar of that look shares it, per-pillar state comes
 * from object-scope uniforms read from mesh.userData (no material clones):
 *   userData.propDmg  0..1  damage (1 - hp fraction)       fragment
 *   userData.propHit  0..1  hit flash                       fragment
 *   userData.propLost 0..2  detachable chunks broken off    vertex
 * Each uniform is read in ONE shader stage only (r186: a uniform shared by
 * both stages only updates the vertex copy).
 *
 * Authored PBR sets load async; until then the procedural fallback renders,
 * then the materials are rebuilt and swapped on every registered mesh.
 */

export type Look = 'temple' | 'volcanic' | 'overgrown'

interface LookDef {
  set: [string, string]
  detail: [string, string] | null
  texScale: number
  tint: [number, number, number]
  fallback: [number, number, number]
  moss: number
  glow: [number, number, number]
  rune: [number, number, number]
  veins: number
}

const LOOKS: Record<Look, LookDef> = {
  temple: { set: ['temple', 'tile_side'], detail: ['shared', 'ground_moss'], texScale: 150, tint: [0.78, 0.74, 0.7], fallback: [0.26, 0.24, 0.22], moss: 0.55, glow: [3.2, 1.05, 0.22], rune: [2.6, 0.95, 0.25], veins: 0 },
  volcanic: { set: ['volcanic', 'tile_side'], detail: ['shared', 'lava_crust'], texScale: 120, tint: [0.62, 0.58, 0.6], fallback: [0.06, 0.055, 0.058], moss: 0.0, glow: [3.4, 0.9, 0.12], rune: [0, 0, 0], veins: 1 },
  overgrown: { set: ['overgrown', 'tile_side'], detail: ['shared', 'ground_moss'], texScale: 130, tint: [0.8, 0.82, 0.76], fallback: [0.15, 0.15, 0.13], moss: 1.0, glow: [0.35, 2.6, 0.9], rune: [0.3, 2.2, 0.9], veins: 0 },
}

const MOSS_TINT = vec3(0.55, 0.68, 0.42)

// ------------------------------------------------------------------ per-object uniforms

type Obj = { userData: Record<string, unknown> }
const objNum = (key: string, def: number) => (frame: { object?: unknown }) => {
  const o = frame.object as Obj | undefined
  const v = o?.userData?.[key]
  return typeof v === 'number' ? v : def
}

// ------------------------------------------------------------------ helpers

/** Triplanar with sharpened weights; side faces keep the texture's v = world up. */
function tri(tex: THREE.Texture, p: Node<'vec3'>, n: Node<'vec3'>, scale: number): Node<'vec4'> {
  let w = pow(abs(n), vec3(4))
  w = w.div(w.x.add(w.y).add(w.z))
  const s = float(scale)
  const cx = texture(tex, vec2(p.z, p.y).mul(s))
  const cy = texture(tex, vec2(p.x, p.z).mul(s))
  const cz = texture(tex, vec2(p.x, p.y).mul(s))
  return cx.mul(w.x).add(cy.mul(w.y)).add(cz.mul(w.z)) as unknown as Node<'vec4'>
}

/** Procedural rune glyph strokes in a carved band cell (u in cells, v 0..1). Returns 0..1 line mask. */
function runeGlyph(u: Node<'float'>, v: Node<'float'>, seed: number): Node<'float'> {
  const cell = floor(u)
  const fx = fract(u)
  const h = fract(sin(cell.mul(91.7).add(seed * 13.1)).mul(43758.5453))
  const h2 = fract(sin(cell.mul(47.3).add(seed * 7.7)).mul(24634.6345))
  const w = float(0.06)
  const line = (d: Node<'float'>) => float(1).sub(smoothstep(w, w.add(0.05), d))
  const gy = v.sub(0.5).mul(1.6)
  const gx = fx.sub(0.5)
  // frame lines top and bottom
  const frameL = line(abs(v.sub(0.08)).mul(1.4)).add(line(abs(v.sub(0.92)).mul(1.4)))
  // stroke set chosen by hash
  const vert = line(abs(gx)).mul(step(0.35, h))
  const diamond = line(abs(abs(gx).add(abs(gy)).sub(0.32))).mul(step(h2, 0.45))
  const chevron = line(abs(abs(gx).mul(1.3).sub(gy.add(0.15)))).mul(step(0.55, h2)).mul(step(gy, 0.4))
  const bar = line(abs(gy.sub(0.18))).mul(step(h, 0.5)).mul(step(abs(gx), 0.3))
  const inner = max(max(vert.mul(step(abs(gy), 0.36)), diamond), max(chevron, bar))
  // keep a gap between glyphs
  const gap = smoothstep(0.02, 0.1, fx).mul(smoothstep(0.98, 0.9, fx))
  return saturate(frameL.add(inner.mul(gap)))
}

// ------------------------------------------------------------------ stone

export interface StoneMats {
  stone: THREE.MeshStandardNodeMaterial
  crystal: THREE.MeshStandardNodeMaterial
  chip: THREE.MeshStandardNodeMaterial
}

function buildStone(look: Look, maps: SurfaceMaps | null, detail: SurfaceMaps | null): THREE.MeshStandardNodeMaterial {
  const L = LOOKS[look]
  const noise = getNoiseTexture()
  const uDmg = uniform(0).onObjectUpdate(objNum('propDmg', 0))
  const uHit = uniform(0).onObjectUpdate(objNum('propHit', 0))
  const uLost = uniform(0).onObjectUpdate(objNum('propLost', 0))
  const info = attribute('aInfo', 'vec3') as unknown as Node<'vec3'>
  const band = attribute('aBand', 'vec2') as unknown as Node<'vec2'>
  const p = positionGeometry
  const n = normalGeometry
  const cav = info.x
  const matId = info.y
  const isRubble = step(0.5, matId).mul(step(matId, 1.5))
  const isWood = step(1.5, matId).mul(step(matId, 2.5))
  const isGlass = step(2.5, matId).mul(step(matId, 3.5))

  // ---- noise (tileable texture, triplanar in local game units)
  const nz = tri(noise, p, n, 1 / 160)
  const nzF = tri(noise, p, n, 1 / 55)
  const crackField = tri(noise, p.add(vec3(37, 11, 5)), n, 1 / 70).b

  // ---- albedo
  let alb: Node<'vec3'>
  let rough: Node<'float'>
  let height: Node<'float'>
  let aoTex: Node<'float'> = float(1)
  const tint = vec3(...L.tint)
  if (maps) {
    alb = tri(maps.albedo, p, n, 1 / L.texScale).rgb.mul(tint)
    const orm = tri(maps.orm, p, n, 1 / L.texScale)
    aoTex = mix(float(1), orm.r, 0.8)
    rough = orm.g
    height = tri(maps.height ?? maps.albedo, p, n, 1 / L.texScale).r.mul(0.75).add(nzF.g.mul(0.25))
  } else {
    alb = vec3(...L.fallback).mul(nz.r.mul(0.6).add(0.7)).mul(nzF.g.mul(0.3).add(0.85))
    rough = float(0.82).add(nzF.r.sub(0.5).mul(0.2))
    height = nzF.g.mul(0.6).add(nz.r.mul(0.4))
  }
  // large-scale value variation so no two faces read identical
  alb = alb.mul(nz.g.mul(0.5).add(0.75))
  // rubble: same stone, a touch darker and dustier
  alb = mix(alb, alb.mul(vec3(0.82, 0.8, 0.78)), isRubble)
  // wood (roots): dark bark with lengthwise streaks
  const bark = vec3(0.07, 0.045, 0.03).mul(nzF.r.mul(0.8).add(0.6))
  alb = mix(alb, bark, isWood)
  rough = mix(rough, float(0.9), isWood)
  // obsidian: near-black glass with a violet sheen, sharp highlights
  const obs = vec3(0.018, 0.016, 0.022).add(vec3(0.02, 0.012, 0.03).mul(nz.r))
  alb = mix(alb, obs, isGlass)
  rough = mix(rough, float(0.16).add(nzF.r.mul(0.12)), isGlass)

  // ---- moss: up-facing surfaces and carved crevices
  if (L.moss > 0) {
    const up = saturate(normalWorld.y)
    const amt = float(L.moss)
    const onTop = smoothstep(0.45, 0.85, up.add(nz.b.mul(0.35)).sub(float(1).sub(amt).mul(0.5)))
    const inCrev = smoothstep(0.85, 0.55, cav).mul(nz.r.add(0.3)).mul(amt)
    // drips down the sides from the cap on overgrown stones
    const drip = look === 'overgrown' ? smoothstep(0.1, 0.5, nzF.g.add(up.mul(0.6)).sub(0.25)).mul(smoothstep(40, 160, p.y)).mul(0.8) : float(0)
    const mm = saturate(max(onTop, max(inCrev, drip))).mul(float(1).sub(isGlass)).mul(float(1).sub(isWood).mul(0.7).add(0.3))
    const mossCol = detail && look !== 'volcanic' ? tri(detail.albedo, p, n, 1 / 70).rgb.mul(MOSS_TINT) : vec3(0.05, 0.09, 0.03).mul(nzF.g.add(0.5))
    alb = mix(alb, mossCol, mm)
    rough = mix(rough, float(0.95), mm)
    height = mix(height, nzF.r.mul(0.5).add(0.5), mm.mul(0.6))
  }
  if (look === 'volcanic' && detail) {
    // cooled crust on rubble and near the floor
    const crust = tri(detail.albedo, p, n, 1 / 90).rgb.mul(0.55)
    const k = saturate(isRubble.add(smoothstep(40, 0, p.y).mul(0.6)))
    alb = mix(alb, crust, k.mul(float(1).sub(isGlass)))
  }

  // ---- damage cracks: a worley crack network that spreads and widens with damage
  const dmg = uDmg
  const spread = smoothstep(dmg.mul(1.25).sub(0.05), dmg.mul(1.25).sub(0.3), nz.r.add(nzF.b.mul(0.3)))
  const crackW = dmg.mul(0.075).add(0.006)
  const crack = float(1).sub(smoothstep(crackW.mul(0.4), crackW, crackField)).mul(spread).mul(step(0.02, dmg)).mul(float(1).sub(isWood))
  alb = alb.mul(float(1).sub(crack.mul(0.85)))

  // ---- occlusion: baked cavities, darker toward the floor (sits IN the light)
  const floorAO = mix(float(0.32), float(1), smoothstep(-6, 70, p.y))
  const ao = saturate(cav.mul(0.6).add(0.4)).mul(floorAO).mul(aoTex)
  alb = alb.mul(ao)

  // ---- emissive
  const glow = vec3(...L.glow)
  const pulse = sin(time.mul(2.3).add(p.y.mul(0.03))).mul(0.18).add(0.82)
  let em: Node<'vec3'> = glow.mul(crack.mul(dmg.mul(1.6).add(0.35)).mul(pulse))
  // crack faces glow faintly around the line (heat bleeding into the stone)
  em = em.add(glow.mul(0.12).mul(float(1).sub(smoothstep(0, crackW.mul(3), crackField)).mul(spread).mul(dmg)))
  if (L.veins > 0) {
    // thin ember veins in crevices and near the floor (heat from below), never slits
    const vf = tri(noise, p.add(vec3(13, 71, 29)), n, 1 / 42).b
    const vein = float(1).sub(smoothstep(0.012, 0.03, vf))
    const where = saturate(smoothstep(0.8, 0.45, cav).add(smoothstep(95, 0, p.y).mul(0.85)).add(nz.b.sub(0.7).mul(2)))
    const vk = vein.mul(where).mul(float(1).sub(isWood))
    em = em.add(glow.mul(vk.mul(dmg.mul(0.8).add(0.45))).mul(pulse))
    alb = alb.mul(float(1).sub(vk.mul(0.6)))
    // ember bloom into the lowest crust
    em = em.add(glow.mul(0.05).mul(exp(p.y.div(-14))))
  }
  if (L.rune[0] + L.rune[1] > 0) {
    const bv = band.y
    const inBand = step(0, bv).mul(step(bv, 1))
    const g = runeGlyph(band.x, bv, look === 'temple' ? 1 : 2).mul(inBand)
    em = em.add(vec3(...L.rune).mul(g.mul(dmg.mul(0.9).add(0.28))).mul(pulse))
    alb = alb.mul(float(1).sub(g.mul(0.5)))
    height = height.sub(g.mul(0.5))
  }
  // hit flash: hot white-orange wash
  em = em.add(vec3(1.3, 0.9, 0.6).mul(uHit.mul(0.55)))
  // subtle cool rim (moonlight wrap), reads the silhouette against the floor
  const vdir = positionView.negate().normalize()
  const fres = pow(float(1).sub(saturate(dot(normalView, vdir))), 4)
  em = em.add(vec3(0.05, 0.07, 0.12).mul(fres).mul(ao))

  const m = new THREE.MeshStandardNodeMaterial()
  m.name = `Prop_${look}`
  m.colorNode = alb
  m.roughnessNode = saturate(rough.add(crack.mul(0.15)))
  m.metalnessNode = float(0)
  m.normalNode = bumpMap(height.sub(crack.mul(0.8)), float(look === 'volcanic' ? 1.1 : 1.4))
  m.emissiveNode = em
  // detachable chunks collapse to a point once broken off (vertex stage only)
  const chunk = info.z
  const gone = step(0.5, chunk).mul(step(chunk, uLost.add(0.01)))
  m.positionNode = positionLocal.mul(float(1).sub(gone))
  return m
}

function buildCrystal(look: Look): THREE.MeshStandardNodeMaterial {
  const uHit = uniform(0).onObjectUpdate(objNum('propHit', 0))
  const uDmg = uniform(0).onObjectUpdate(objNum('propDmg', 0))
  const p = positionGeometry
  const col = look === 'volcanic' ? vec3(3.0, 0.8, 0.15) : vec3(0.35, 2.6, 0.95)
  const vdir = positionView.negate().normalize()
  const facing = saturate(dot(normalView, vdir))
  const fres = pow(float(1).sub(facing), 2)
  // inner glow brightest low in the crystal, facets catch the rim
  const h01 = saturate(p.y.div(90))
  const pulse = sin(time.mul(1.6).add(p.x.mul(0.05)).add(p.z.mul(0.07))).mul(0.2).add(0.8)
  const m = new THREE.MeshStandardNodeMaterial()
  m.name = `PropCrystal_${look}`
  m.colorNode = col.mul(0.03)
  m.roughnessNode = float(0.12)
  m.metalnessNode = float(0)
  m.emissiveNode = col.mul(float(0.35).add(fres.mul(0.9)).add(float(1).sub(h01).mul(0.35))).mul(pulse).mul(uDmg.mul(0.8).add(0.7)).add(col.mul(uHit.mul(0.8)))
  return m
}

function buildChip(look: Look, maps: SurfaceMaps | null): THREE.MeshStandardNodeMaterial {
  const L = LOOKS[look]
  const m = new THREE.MeshStandardNodeMaterial()
  m.name = `PropChip_${look}`
  const base = maps ? tri(maps.albedo, positionGeometry.mul(40), normalGeometry, 1 / L.texScale).rgb.mul(vec3(...L.tint)) : vec3(...L.fallback)
  m.colorNode = base.mul(0.85)
  m.roughnessNode = float(0.85)
  m.metalnessNode = float(0)
  // fresh chips carry a little heat for a moment (instance colour carries the fade)
  return m
}

// ------------------------------------------------------------------ registry

interface LookEntry {
  mats: StoneMats
  meshes: { stone: Set<THREE.Mesh>; crystal: Set<THREE.Mesh>; chip: Set<THREE.Mesh> }
  loaded: boolean
}

const entries = new Map<Look, LookEntry>()
let anisotropy = 4

/** Set before the first prop is created (tier texture anisotropy). */
export function setPropAnisotropy(a: number): void {
  anisotropy = a
}

function entry(look: Look): LookEntry {
  let e = entries.get(look)
  if (e) return e
  const ent: LookEntry = {
    mats: { stone: buildStone(look, null, null), crystal: buildCrystal(look), chip: buildChip(look, null) },
    meshes: { stone: new Set(), crystal: new Set(), chip: new Set() },
    loaded: false,
  }
  e = ent
  entries.set(look, ent)
  const L = LOOKS[look]
  void Promise.all([loadSurface(L.set[0], L.set[1], anisotropy), L.detail ? loadSurface(L.detail[0], L.detail[1], anisotropy) : Promise.resolve(null)]).then(([maps, det]) => {
    if (!maps || entries.get(look) !== ent) return
    const old = ent.mats
    ent.mats = { stone: buildStone(look, maps, det), crystal: old.crystal, chip: buildChip(look, maps) }
    ent.loaded = true
    for (const m of ent.meshes.stone) m.material = ent.mats.stone
    for (const m of ent.meshes.chip) m.material = ent.mats.chip
    old.stone.dispose()
    old.chip.dispose()
  })
  return ent
}

/** Shared materials for a look, and a registration so async texture upgrades reach the mesh. */
export function useLook(look: Look, mesh: THREE.Mesh, slot: keyof StoneMats): () => void {
  const e = entry(look)
  mesh.material = e.mats[slot]
  e.meshes[slot].add(mesh)
  return () => {
    e.meshes[slot].delete(mesh)
  }
}

/** Kick off texture loading early (optional). */
export function preloadLooks(): void {
  entry('temple')
  entry('volcanic')
  entry('overgrown')
}

// ------------------------------------------------------------------ contact shadow

let decalMat: THREE.MeshBasicNodeMaterial | null = null

/**
 * Dark contact ring under a pillar, all the way around (incl. the front):
 * a tight occlusion crease at the base plus a soft falloff. Geometry is a
 * unit disc (radius 1 = 1.75 x pillar radius); the inner 1/1.75 is under
 * the pillar.
 */
export function contactDecalMaterial(): THREE.MeshBasicNodeMaterial {
  if (decalMat) return decalMat
  const m = new THREE.MeshBasicNodeMaterial()
  m.transparent = true
  m.depthWrite = false
  m.name = 'PropContact'
  const q = positionGeometry.xy
  const d = q.length()
  const base = 1 / 1.75
  const crease = float(1).sub(smoothstep(base * 0.98, base * 1.18, d))
  const soft = float(1).sub(smoothstep(base * 0.9, 1.0, d))
  m.colorNode = vec3(0, 0, 0)
  m.opacityNode = min(float(1), crease.mul(0.55).add(soft.mul(soft).mul(0.5)))
  decalMat = m
  return m
}

export function lookForTheme(theme: number, variant: number): Look {
  if (variant < 0) return 'volcanic'
  const t = ((theme % 3) + 3) % 3
  return t === 0 ? 'temple' : t === 1 ? 'volcanic' : 'overgrown'
}
