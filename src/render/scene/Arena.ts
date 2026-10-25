import * as THREE from 'three/webgpu'
import {
  abs,
  ceil,
  Fn,
  If,
  Loop,
  attribute,
  bumpMap,
  cameraPosition,
  cameraViewMatrix,
  clamp,
  dFdx,
  dFdy,
  dot,
  exp,
  floor,
  fwidth,
  int,
  normalMap,
  float,
  length,
  max,
  min,
  mix,
  normalGeometry,
  positionGeometry,
  positionWorld,
  rotate,
  saturate,
  select,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import { GRID_MAX, TILE_SIZE, arenaTiles, cellIndex, clampLayer, tileExists } from '../arenaGeom'
import { S } from '../coords'
import { tweaks } from '../tweaks'
import { THEME_DIRS, loadSurface, type SurfaceMaps } from './textures'
import { TILE_GROUP_SIDE, TILE_GROUP_TOP, buildTileGeometry } from './tileGeometry'
import { asV4, gamePos, type WorldCtx } from './world'
import { TILE_GAP } from '../scale'

/**
 * Calm floor albedo lift per theme (same cool palette). Measured floor
 * luminance at the gameplay camera. A small additional albedo lift keeps
 * the texture and cool palette intact without raising lava bounce or bloom.
 */
const FLOOR_LIFT = [1.26, 1.58, 1.26] as const

/**
 * Calm floor: the 45 degree bevels shade like the tile tops (normal pulled
 * toward up), so the moon no longer draws a bright and a dark line along
 * every tile edge. The grout reads as the thin 4-unit gap only.
 */
function calmBevel(n: unknown, isBevel: Node<'float'>): Node<'vec3'> {
  const upView = cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz
  return mix(n as Node<'vec3'>, upView, isBevel.mul(0.8)).normalize()
}

/**
 * Removed-tile timeline (render only; the sim drops the tile at once). The
 * first SINK_DROP seconds sell "no longer ground": the slab lurches below the
 * walk level, tilts and glows crimson (a pawn on it is already in lava). Then
 * the lava takes its time: over SINK_SWALLOW the slab rocks, cracks open hot,
 * the waterline creeps over it and it goes under. A ring's slow phase sweeps
 * around the platform over SINK_SWEEP (per-tile delay from its angle), so a
 * whole ring is swallowed in a wave instead of all at once.
 */
export const SINK_DROP = 0.24
export const SINK_SWALLOW = 2.7
export const SINK_SWEEP = 0.8
/** seconds until the last tile of a ring is under */
export const SINK_DUR = SINK_DROP + SINK_SWEEP + SINK_SWALLOW
/** game units the slab lurches down at once (top 30 -> 9 above the lava) */
const DROP_H = 21
/** further sink while swallowed: top ends well under the lava even fully tilted */
const SWALLOW_H = 80

/**
 * Slow-phase delay of the tile centred at game (x, y) for a ring whose sweep
 * starts at angle `sweep`: 0 there, SINK_SWEEP on the opposite side, both
 * halves running around to meet. Lava.ts evaluates the same curve per cell.
 */
export function sinkDelay(x: number, y: number, sweep: number): number {
  const a = Math.atan2(y, x + 1e-5) - sweep
  const w = (((a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
  return (Math.abs(w - Math.PI) / Math.PI) * SINK_SWEEP
}
const RISE_DUR = 0.45
const CAPACITY = (GRID_MAX * 2 + 1) ** 2

interface TileEntry {
  gx: number
  gy: number
  mask: number
  seed: number
  removedAt: number
  addedAt: number
  ring: number
}

interface Theme {
  a: THREE.Color
  b: THREE.Color
  rune: THREE.Color
  rough: number
}

/** 0 ruins (warm basalt), 1 rocks (obsidian), 2 debris (ash and iron). Linear colours. */
const THEMES: Theme[] = [
  { a: new THREE.Color(0.11, 0.085, 0.07), b: new THREE.Color(0.25, 0.2, 0.16), rune: new THREE.Color(2.2, 0.75, 0.16), rough: 0.86 },
  { a: new THREE.Color(0.022, 0.02, 0.028), b: new THREE.Color(0.085, 0.072, 0.09), rune: new THREE.Color(1.0, 0.35, 2.0), rough: 0.38 },
  { a: new THREE.Color(0.07, 0.055, 0.05), b: new THREE.Color(0.19, 0.11, 0.08), rune: new THREE.Color(2.4, 0.3, 0.12), rough: 0.7 },
]

function seedOf(gx: number, gy: number): number {
  let h = (gx * 73856093) ^ (gy * 19349663)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

interface MaskMesh {
  mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshStandardNodeMaterial[]>
  attr: THREE.InstancedBufferAttribute
  /** per-tile centre (world x, z) */
  offset: THREE.InstancedBufferAttribute
}

/**
 * Instanced tile platform. One instanced mesh per rounded-corner mask (at most
 * 16, usually ~9 with instances); a removed tile keeps its slot with a
 * `removedAt` stamp and sinks red-hot into the lava in the shader.
 *
 * Tiles only translate, so the centre is a per-instance attribute instead of
 * an InstancedMesh matrix: three keeps small instance-matrix arrays in a
 * per-object uniform buffer and re-uploads all of it every frame (441 slots x
 * 64 B per draw group), while an attribute uploads only when the layout changes.
 */
export class Arena {
  readonly group = new THREE.Group()
  /** 0..1, pulses the next ring red before a shrink */
  readonly uTelegraph = uniform(0)
  /** shockwave: game x, y, start time, strength */
  readonly uShock = uniform(new THREE.Vector4(0, 0, -100, 0))
  /**
   * King of the Hill: x = hill radius (game units, 0 = no hill; whole tiles whose centre is
   * inside), y = 0 empty / 1 held / 2 contested, z = shrink warning 0..1, w = radius after it
   */
  readonly uHill = uniform(new THREE.Vector4(0, 0, 0, 0))
  /** the holder's identity colour (linear) */
  readonly uHillColor = uniform(new THREE.Color(1, 0.72, 0.28))
  private uStoneA = uniform(new THREE.Color())
  private uStoneB = uniform(new THREE.Color())
  private uRune = uniform(new THREE.Color())
  private uRough = uniform(0.8)
  /** calm floor albedo lift for the current theme (fragment only) */
  private uLift = uniform(1)
  /** by tile draw group: [tops + chamfers, walls] (tileGeometry TILE_GROUP_*) */
  private materials: THREE.MeshStandardNodeMaterial[]
  private meshes = new Map<number, MaskMesh>()
  private tiles = new Map<number, TileEntry>()
  private sinking: TileEntry[] = []
  private layer = -1
  private theme = -1
  private dirty = false
  /** authored PBR maps for the current theme, null = procedural */
  /**
   * Authored texture sets per theme (null until loaded / absent). The textured
   * material is built ONCE; a theme change only swaps the texture node values,
   * so new rounds never recompile the tile shader (that was a ~100 ms hitch).
   */
  private themeMaps: ({ top: SurfaceMaps; side: SurfaceMaps | null } | null)[] = [null, null, null]
  private maps: { top: SurfaceMaps; side: SurfaceMaps | null } | null = null
  /** texture nodes of the textured material, by map slot, for value swaps */
  private texNodes: { node: { value: THREE.Texture }; slot: TexSlot }[] = []
  /** luminance POM (no authored height) was baked into the current material */
  private builtLumHeight = false

  constructor(private ctx: WorldCtx) {
    this.group.name = 'Arena'
    this.materials = this.buildMaterials()
    this.setTheme(0)
    this.loadAllThemes()
  }

  get currentLayer(): number {
    return this.layer
  }

  setTheme(theme: number): void {
    const t = ((theme % 3) + 3) % 3
    if (t === this.theme) return
    this.theme = t
    const th = THEMES[t]
    this.uStoneA.value.copy(th.a)
    this.uStoneB.value.copy(th.b)
    this.uRune.value.copy(th.rune)
    this.uRough.value = th.rough
    this.uLift.value = FLOOR_LIFT[t]
    if (this.themeMaps[t]) this.applyThemeMaps()
  }

  /** Load every theme's texture set up front (first call only). */
  private loadAllThemes(): void {
    const aniso = this.ctx.tier.anisotropy
    THEME_DIRS.forEach((dir, t) => {
      void Promise.all([loadSurface(dir, 'tile_top', aniso), loadSurface(dir, 'tile_side', aniso)]).then(([top, side]) => {
        if (this.disposed || !top) return
        this.themeMaps[t] = { top, side }
        if (t === this.theme) this.applyThemeMaps()
      })
    })
  }

  /** Point the textured material at the current theme's maps (builds it on first use). */
  private applyThemeMaps(): void {
    const next = this.themeMaps[this.theme]
    if (!next) return
    const needsHeightMode = next.top.height === null
    if (this.maps === null || needsHeightMode !== this.builtLumHeight) {
      // first textured build (or a height-mode change): one compile, at load
      this.maps = next
      this.rebuildMaterial()
      return
    }
    this.maps = next
    for (const { node, slot } of this.texNodes) node.value = mapFor(next, slot)
  }

  private disposed = false

  private rebuildMaterial(): void {
    const old = this.materials
    this.texNodes = []
    this.materials = this.buildMaterials()
    for (const m of this.meshes.values()) m.mesh.material = this.materials
    for (const m of old) m.dispose()
  }

  private buildMaterials(): THREE.MeshStandardNodeMaterial[] {
    const out: THREE.MeshStandardNodeMaterial[] = []
    out[TILE_GROUP_TOP] = this.buildMaterial('top')
    out[TILE_GROUP_SIDE] = this.buildMaterial('side')
    return out
  }

  /**
   * Switch to `layer`. With `animate`, removed tiles sink and new tiles rise;
   * otherwise the platform snaps (initial state, new match).
   */
  setLayer(layer: number, now: number, animate: boolean, sweep = 0): void {
    const L = clampLayer(layer)
    if (L === this.layer) return
    const next = arenaTiles(L)
    const nextIdx = new Set<number>()
    for (const t of next) nextIdx.add(cellIndex(t.gx, t.gy))
    // removals (a sinking tile carries its sweep delay in the ring slot)
    for (const [idx, e] of this.tiles) {
      if (nextIdx.has(idx)) continue
      this.tiles.delete(idx)
      if (animate) {
        e.removedAt = now
        e.ring = sinkDelay(e.gx * TILE_SIZE, e.gy * TILE_SIZE, sweep)
        this.sinking.push(e)
      }
    }
    // additions and mask updates
    const grow = animate && this.layer > 1
    for (const t of next) {
      const idx = cellIndex(t.gx, t.gy)
      const e = this.tiles.get(idx)
      if (e) {
        e.mask = t.mask
      } else {
        // a tile that rises back while still sinking: drop the sinking copy
        this.sinking = this.sinking.filter((s) => s.gx !== t.gx || s.gy !== t.gy)
        this.tiles.set(idx, {
          gx: t.gx,
          gy: t.gy,
          mask: t.mask,
          seed: seedOf(t.gx, t.gy),
          removedAt: -1,
          addedAt: grow ? now + Math.hypot(t.gx, t.gy) * 0.02 : -100,
          ring: 0,
        })
      }
    }
    for (const e of this.tiles.values()) e.ring = tileExists(e.gx, e.gy, L - 1) ? 0 : 1
    const grew = L > this.layer && this.layer > 0
    this.layer = L
    if (grow && grew) {
      // growing: keep the lava (shore glow, under-platform darkening) on the
      // old outline until the new ring has risen, or the lava under the
      // still-submerged tiles reads as a flat dark slab
      let last = 0
      for (const e of this.tiles.values()) last = Math.max(last, e.addedAt)
      this.pendingField = { layer: L, at: last + RISE_DUR * 0.6 }
    } else {
      this.pendingField = null
      this.ctx.field.setLayer(L)
    }
    this.dirty = true
  }

  /** deferred SDF switch while a grown ring is still rising */
  private pendingField: { layer: number; at: number } | null = null

  /** Round-start shockwave from a game-space origin. */
  shock(x: number, y: number, now: number, strength = 1): void {
    this.uShock.value.set(x, y, now, strength)
  }

  private tweakVersion = tweaks.version

  update(now: number): void {
    if (this.pendingField && now >= this.pendingField.at) {
      this.ctx.field.setLayer(this.pendingField.layer)
      this.pendingField = null
    }
    if (this.tweakVersion !== tweaks.version) {
      this.tweakVersion = tweaks.version
      this.rebuildMaterial()
    }
    if (this.sinking.length > 0) {
      // in place: no per-frame allocation while a ring sinks
      let n = 0
      for (const e of this.sinking) if (now - e.removedAt < SINK_DUR + 0.15) this.sinking[n++] = e
      if (n !== this.sinking.length) {
        this.sinking.length = n
        this.dirty = true
      }
    }
    if (this.dirty) this.rebuild()
  }

  private meshFor(mask: number): MaskMesh {
    let m = this.meshes.get(mask)
    if (m) return m
    const tile = buildTileGeometry(mask)
    const geo = new THREE.InstancedBufferGeometry().copy(tile as THREE.InstancedBufferGeometry)
    tile.dispose()
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 4), 4)
    attr.setUsage(THREE.StaticDrawUsage)
    geo.setAttribute('aTile', attr)
    const offset = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 2), 2)
    offset.setUsage(THREE.StaticDrawUsage)
    geo.setAttribute('aTileXZ', offset)
    geo.instanceCount = 0
    const mesh = new THREE.Mesh(geo, this.materials)
    mesh.frustumCulled = false
    mesh.receiveShadow = this.ctx.tier.shadowMap > 0
    mesh.visible = false
    mesh.name = `tiles-m${mask}`
    this.group.add(mesh)
    m = { mesh, attr, offset }
    this.meshes.set(mask, m)
    return m
  }

  private rebuild(): void {
    this.dirty = false
    const counts = new Map<number, number>()
    const put = (e: TileEntry) => {
      const mm = this.meshFor(e.mask)
      const i = counts.get(e.mask) ?? 0
      if (i >= CAPACITY) return
      counts.set(e.mask, i + 1)
      const o = mm.offset.array as Float32Array
      o[i * 2] = e.gx * TILE_SIZE * S
      o[i * 2 + 1] = -e.gy * TILE_SIZE * S
      const a = mm.attr.array as Float32Array
      a[i * 4] = e.seed
      a[i * 4 + 1] = e.removedAt
      a[i * 4 + 2] = e.addedAt
      a[i * 4 + 3] = e.ring
    }
    for (const e of this.tiles.values()) put(e)
    for (const e of this.sinking) put(e)
    for (const [mask, mm] of this.meshes) {
      const n = counts.get(mask) ?? 0
      mm.mesh.geometry.instanceCount = n
      mm.mesh.visible = n > 0
      mm.offset.needsUpdate = true
      mm.attr.needsUpdate = true
    }
  }

  /**
   * One tile shader per draw group. A wall pixel never samples the top maps
   * and a top pixel never the wall maps (both were sampled and mixed before).
   */
  private buildMaterial(face: 'top' | 'side'): THREE.MeshStandardNodeMaterial {
    const { uTime: t, noise, field, glow } = this.ctx
    const wall = face === 'side'
    const aTile = asV4(attribute('aTile', 'vec4'))
    const seed = aTile.x
    const removedAt = aTile.y
    const addedAt = aTile.z
    const isRem = step(0, removedAt)
    // live tiles: telegraph flag; sinking tiles: their sweep delay (seconds)
    const ring = aTile.w.mul(float(1).sub(isRem))
    const delay = aTile.w.mul(isRem)

    // ---------------- vertex: sink, rise, shockwave lift
    // drop: an immediate lurch below the walk level (ease-out, ~0.24 s)
    const age = t.sub(removedAt)
    const dropT = saturate(age.div(SINK_DROP)).mul(isRem)
    const dropE = float(1).sub(float(1).sub(dropT).pow(3))
    // swallow: slow, accelerating pull under (ease-in), after the sweep delay
    const sinkT = saturate(age.sub(SINK_DROP).sub(delay).div(SINK_SWALLOW)).mul(isRem)
    // the slab rocks on the melt while it still floats, settling as it goes under
    const rock = sin(age.mul(2.6).add(seed.mul(40))).mul(float(1).sub(sinkT)).mul(dropT)
    const sink = dropE.mul(DROP_H).add(sinkT.pow(1.7).mul(SWALLOW_H)).add(rock.mul(2.5))
    const tiltA = dropE.mul(0.08).add(sinkT.pow(1.2).mul(0.36)).add(rock.mul(0.03))
    const phi = seed.mul(6.2831)
    const tilted = rotate(positionGeometry, vec3(tiltA.mul(phi.cos()), 0, tiltA.mul(phi.sin())))
    const riseT = saturate(t.sub(addedAt).div(RISE_DUR))
    const back = float(1).sub(riseT)
    // ease-out with a small overshoot
    const rise = back.mul(back).mul(back).mul(-170).add(sin(riseT.mul(Math.PI)).mul(6))
    const tileXZ = attribute('aTileXZ', 'vec2') as unknown as Node<'vec2'>
    const centre = vec3(tileXZ.x, 0, tileXZ.y)
    const sh = this.uShock
    // (the round-start wave no longer lifts tiles: it exposed bright wall strips)
    const lift = rise.sub(sink)
    const positionNode = centre.add(tilted).add(vec3(0, lift.mul(S), 0))

    // ---------------- fragment: layered stone
    // 'calm' floor (default): one readable surface with subtle tiles; 'classic'
    // keeps the earlier structured look (tweaks.floorStyle, Inspector: Arena)
    const calm = tweaks.floorStyle === 'calm'
    // fragment reads of the clock go through vertex varyings (the fragment
    // stage's own uniform copy did not track the frame clock)
    const tF = varying(t)
    const sinkTV = varying(sinkT)
    const isRemV = varying(isRem)
    const dropTV = varying(dropT)
    const ageV = varying(age)
    const gp = gamePos()
    const lp = positionGeometry.xz.div(TILE_SIZE * 0.5 * S)
    const ny = normalGeometry.y
    const isTop = wall ? float(0) : step(0.9, ny)
    const isBevel = wall ? float(0) : step(0.3, ny).mul(float(1).sub(isTop))
    const isSide = float(wall ? 1 : 0)
    const h = positionWorld.y.div(S)
    const edge = max(abs(lp.x), abs(lp.y))

    // macro (platform-wide tonal patches), meso (per-tile variation), micro (grain)
    const nMacro = texture(noise, gp.mul(1 / 2600))
    const n = texture(noise, gp.mul(1 / 650).add(seed))
    const n2 = texture(noise, gp.mul(1 / 170).add(seed.mul(3.7)))
    const nMicro = texture(noise, gp.mul(1 / 46).add(seed.mul(9.1)))
    // fractures: ridged noise gives long meandering hairline cracks (the lava
    // uses cellular plates; the stone must not echo that pattern)
    const fr = texture(noise, gp.mul(1 / 520).add(seed.mul(1.3)))
    const ridge = float(1).sub(abs(fr.r.mul(2).sub(1))).mul(float(1).sub(abs(fr.g.mul(2).sub(1)).mul(0.35)))
    const crackLine = smoothstep(0.94, 0.99, ridge).mul(isTop)
    const crackHalo = smoothstep(0.86, 0.99, ridge).mul(isTop)

    let stone = mix(this.uStoneA, this.uStoneB, saturate(n.r.mul(1.1).add(nMacro.g.sub(0.5).mul(0.8)).sub(0.08).add(seed.sub(0.5).mul(0.35))))
    stone = calm
      ? stone.mul(n2.g.mul(0.14).add(0.93)).mul(nMicro.r.mul(0.07).add(0.965))
      : stone.mul(n2.g.mul(0.36).add(0.82)).mul(nMicro.r.mul(0.22).add(0.89))
    // cavity: cracks and the halo around them darken, seams fall into shadow
    stone = stone.mul(float(1).sub(crackLine.mul(calm ? 0.3 : 0.7)).sub(crackHalo.mul(calm ? 0.04 : 0.12)))
    stone = stone.mul(calm ? mix(float(1), float(0.88), smoothstep(0.965, 1.0, edge).mul(isTop)) : mix(float(1), float(0.62), smoothstep(0.9, 1.0, edge).mul(isTop)))
    // edge wear: the chamfer and chipped rims are polished lighter by feet
    const chips = smoothstep(0.55, 0.75, nMicro.g).mul(smoothstep(0.78, 0.95, edge)).mul(isTop).mul(calm ? 0.25 : 1)
    const wear = saturate(isBevel.mul(calm ? 0.3 : 0.8).add(chips))
    stone = mix(stone, stone.mul(1.65).add(0.015), wear.mul(0.7))
    if (calm) stone = stone.mul(this.uLift)
    stone = mix(stone, stone.mul(0.8), isSide)

    // engraved sigils on ~1 in 9 tiles: a square-and-diamond glyph (never a
    // circle, so it can't be mistaken for a team ring or an AoE)
    const hasRune = step(seed, 0.07)
    const ax = abs(lp.x)
    const ay = abs(lp.y)
    const sq = float(1).sub(smoothstep(0.012, 0.03, abs(max(ax, ay).sub(0.42))))
    const dia = float(1).sub(smoothstep(0.012, 0.03, abs(ax.add(ay).sub(0.5))))
    const crossL = float(1).sub(smoothstep(0.01, 0.025, min(ax, ay))).mul(step(max(ax, ay), 0.3))
    // sigils read as a UI artifact at gameplay zoom: off by default (tweak 'sigils')
    const rune = max(max(sq, dia.mul(0.8)), crossL.mul(0.6)).mul(hasRune).mul(isTop).mul(tweaks.uSigils)
    const runePulse = sin(tF.mul(1.4).add(seed.mul(40))).mul(0.4).add(0.6)
    stone = stone.mul(float(1).sub(rune.mul(0.45)))

    // gloss breakup: glassy inclusions and polished wear vs rough grain
    const glassy = smoothstep(0.58, 0.72, n.g.mul(0.7).add(nMacro.r.mul(0.3))).mul(isTop)
    let rough = this.uRough.add(n2.r.sub(0.5).mul(0.3)).add(crackLine.mul(0.25))
    rough = mix(rough, rough.mul(0.35), glassy.mul(0.85))
    rough = mix(rough, rough.mul(0.7), wear)

    // telegraph pulse on the next ring, red-hot on removed tiles
    const pulse = sin(tF.mul(15)).mul(0.5).add(0.5)
    const tele = this.uTelegraph.mul(ring)
    const sd = field.sample(gp)
    const W = tweaks.uEdgeWidth
    // clamp, don't gate: the SDF (30-unit texels) reads slightly positive over
    // the outermost units of an edge tile -- exactly the bevel. Gating with
    // step(sd, 0) switched the lava light off right at the rim (black band).
    // tiles in transit stand where the SDF already (removed) or still (regrown:
    // the field switch waits for the last ring) says lava: read them as an
    // inner tile near the shore. Unclamped, every shore term fired at full
    // strength across the whole slab and ACES turned it cream-white (the
    // shrink / regrow whiteout). A live tile's own centre is always >= ~96
    // units inside the edge, so a centre that reads as lava means a stale SDF.
    // Sampled per vertex (tile centre is constant per instance).
    const sdC = varying(field.sample(vec2(centre.x, centre.z.negate()).div(S)))
    const stale = smoothstep(-50, -15, sdC).mul(float(1).sub(isRemV))
    const riseTV = varying(riseT)
    const transit = max(isRemV, max(stale, float(1).sub(riseTV)))
    const sdIn = mix(min(sd, 0), min(sd, W.mul(-2)), transit)
    const nearLava = exp(sdIn.div(W))
    const edgeHeat = exp(sdIn.div(W.mul(0.5))).mul(float(1).sub(isSide))
    // tile walls glow where they meet lava; interior seams stay a dim ember line
    // Lava-facing walls are lit by the lava over their FULL height (hot at the
    // waterline, still warm under the rim). A pure exp falloff left the upper
    // wall near-black: that was the "black band under the tile edge".
    // Interior seam walls keep a dim ember underglow.
    // Which walls face the lava? Sample the SDF 40 units out along the wall
    // normal (per vertex: walls are flat, the SDF is smooth). A lava-facing
    // wall lands in lava; a seam wall lands on the neighbouring slab. Gating
    // by distance to the shore alone lit the 4-unit seams between the outer
    // tiles like lava walls: bright 1-2 px lines that flickered with every
    // camera move (user report: "the lava flickers very brightly").
    const vG = centre.add(positionGeometry)
    const nG = vec2(normalGeometry.x, normalGeometry.z.negate())
    const sdAhead = varying(field.sample(vec2(vG.x, vG.z.negate()).div(S).add(nG.mul(40))))
    const facesLava = smoothstep(-25, 10, sdAhead)
    const outerWall = smoothstep(-170, -50, sd).mul(facesLava)
    const wallFall = exp(h.div(-22))
    // seam walls: a calm ember line, fading further when the seam covers less
    // than ~3 px (sub-pixel lines alias into on/off flicker)
    const upp = length(fwidth(positionWorld)).div(S)
    const seamAA = saturate(float(TILE_GAP * 0.75).div(max(upp, 0.001)))
    const seamGlow = wallFall.mul(0.05).mul(seamAA)
    const sideHeat = isSide.mul(mix(seamGlow, wallFall.mul(0.6).add(0.4), outerWall))

    // (calm: the albedo lift must not raise the lava bounce, or small late-game
    // platforms wash out pink-cream; the shore heat stays as before)
    const lumStone = calm ? stone.div(this.uLift) : stone
    const albedoLum = lumStone.r.add(lumStone.g).add(lumStone.b).mul(1.4).add(0.05)
    // spell ground light: floors take it, walls a little, seam walls (deep
    // 4-unit grooves the light barely reaches) hardly at all
    let em = glow.at(gp).mul(albedoLum).mul(mix(float(0.5), mix(float(0.05), float(0.25), facesLava), isSide))
    // lava veins: heat seeping up through the cracks, stronger toward the shore
    const veinPulse = sin(tF.mul(0.9).add(n.b.mul(12)).add(seed.mul(20))).mul(0.25).add(0.75)
    // calm: sparser veins (only the strongest ridges); the telegraph below keeps the dense set
    const veinLine = calm ? smoothstep(0.972, 0.992, ridge).mul(isTop) : crackLine
    const vein = veinLine.mul(nearLava.mul(1.2).mul(tweaks.uEdgeGlow).add(0.05)).mul(veinPulse)
    em = em.add(vec3(1.1, 0.22, 0.03).mul(vein)) // toned down from (1.5, 0.3, 0.04): the veins shone too hard through bloom
    em = em.add(this.uRune.mul(rune).mul(runePulse.mul(0.05)).mul(tele.mul(14).add(1)))
    em = em.add(vec3(1.2, 0.26, 0.04).mul(edgeHeat.mul(0.2)).mul(tweaks.uEdgeGlow))
    // lava bounce: the shore lights nearby stone orange (modulated by albedo);
    // walls always catch some of it from below
    em = em.add(vec3(1.0, 0.36, 0.08).mul(albedoLum).mul(nearLava.mul(0.6).mul(tweaks.uEdgeGlow).add(isSide.mul(mix(float(0.08).mul(seamAA), float(1.1), outerWall)))))
    em = em.add(vec3(1.9, 0.42, 0.06).mul(sideHeat))
    // telegraph: the doomed ring heats from within, cracks first, then the slab
    const teleP = tele.mul(pulse.mul(0.7).add(0.3))
    em = em.add(vec3(0.16, 0.008, 0.003).mul(teleP).mul(isTop.mul(0.7).add(0.3)))
    em = em.add(vec3(3.2, 0.35, 0.06).mul(teleP).mul(crackHalo.mul(0.5).add(crackLine).add(smoothstep(0.86, 1.0, edge).mul(isTop).mul(0.6))))
    // removed tiles: the same runed stone charring in the heat, never a flat
    // colour. A uniform crimson body glow (0.2-0.36 R) over the moonlit
    // blue-grey stone added up to salmon-pink; the old (3.2, 0.9, 0.16) went
    // cream-white. Instead: the telegraph's cracks stay hot (the cue players
    // learned) and widen as the lava pulls the slab, the rim glows where the
    // melt laps, and only patches of the body smoulder; the albedo chars dark
    // below so the stone's own texture still reads. Hues stay red-orange
    // (G ~ 0.15 R): a pure crimson over the lit stone is what read pink.
    // drop flash: the first ~0.4 s say "no longer ground" (hot, then settling)
    const flash = float(1).sub(smoothstep(SINK_DROP, SINK_DROP + 0.3, ageV)).mul(isRemV)
    const remHeat = isRemV.mul(flash.mul(0.45).add(0.55).add(sinkTV.mul(0.45)))
    // cracks: the telegraph's network, spreading wider as the slab goes under
    const crackLo = float(0.94).sub(sinkTV.mul(0.14))
    const sinkCrack = smoothstep(crackLo, crackLo.add(0.035), ridge).mul(smoothstep(0, 0.25, sinkTV))
    const remCracks = max(crackHalo.mul(0.4).add(crackLine), sinkCrack).mul(isTop)
    em = em.add(vec3(3.0, 0.48, 0.07).mul(remCracks).mul(remHeat))
    // hot rim: the slab's chamfer and edge glow, broken up by the grain
    const rimBand = smoothstep(0.86, 1.0, edge).mul(isTop).add(isBevel).mul(nMicro.g.mul(0.6).add(0.55))
    em = em.add(vec3(1.1, 0.19, 0.03).mul(rimBand).mul(remHeat))
    // smoulder: patchy embers in the body (mottled, never uniform), hotter in the flash
    const mottle = smoothstep(0.42, 0.8, n2.g.mul(0.65).add(nMicro.r.mul(0.35)))
    em = em.add(vec3(0.34, 0.06, 0.01).mul(mottle.mul(0.8).add(0.08)).mul(flash.mul(0.8).add(0.35)).mul(isRemV))
    // waterline: the melt's own glow climbs the slab where it meets the lava
    // (game height ~0), lapping in tongues rather than as a flat band
    const lap = exp(max(h, 0).div(-2.5)).mul(n2.r.mul(0.8).add(0.5)).mul(isRemV).mul(dropTV)
    em = em.add(vec3(1.5, 0.42, 0.06).mul(saturate(lap)))
    // round-start pulse: pale arcane white-gold ring, evaluated PER FRAGMENT so
    // it sweeps as a smooth band (a per-tile value lit whole tiles as squares)
    const shAgeF = tF.sub(sh.z)
    const shDf = length(gp.sub(sh.xy))
    const shXf = shDf.sub(shAgeF.mul(2600)).div(90)
    const waveF = exp(shXf.mul(shXf).negate()).mul(sh.w).mul(saturate(float(1.2).sub(shAgeF))).mul(step(0, shAgeF))
    em = em.add(vec3(0.5, 0.48, 0.62).mul(waveF.mul(0.16)).mul(isTop))
    // King of the Hill: hill tiles found per fragment from the grid cell under it (no varyings:
    // this shader is at WebGPU's 16 inter-stage limit; two more broke the tile pipeline)
    const hl = this.uHill
    const cLen = length(floor(gp.div(TILE_SIZE).add(0.5)).mul(TILE_SIZE))
    const onHillV = step(cLen, hl.x).mul(float(1).sub(isRemV))
    const hillDoomV = step(hl.w, cLen)
    // an inlaid band inside every hill tile's rim and slow rings of light
    // flowing out from the centre. Empty: dim gold; held: the holder's colour, brighter and
    // faster; contested: only the rim band, a steady pale outline (no hue, so it never reads
    // as a red holder; no fill or strobe, which flashed the whole hill). Kept modest: ACES
    // turns hot hues cream.
    const hHeld = step(0.5, hl.y).mul(step(hl.y, 1.5))
    const hContest = step(1.5, hl.y)
    const hFill = float(1).sub(hContest)
    const hCol = mix(mix(vec3(1.0, 0.68, 0.24), this.uHillColor, hHeld), vec3(0.78, 0.78, 0.86), hContest)
    const hBand = smoothstep(0.72, 0.86, edge).mul(float(1).sub(smoothstep(0.93, 0.99, edge)))
    const hFlow = sin(length(gp).mul(0.03).sub(tF.mul(hHeld.mul(2.5).add(1.2)))).mul(0.5).add(0.5)
    const hBreathe = sin(tF.mul(2.1)).mul(0.15).add(0.85)
    const hLevel = hHeld.mul(0.7).add(0.55)
    const hillGlow = onHillV.mul(isTop.add(isBevel.mul(0.6))).mul(hBand.mul(0.8).add(hFlow.pow(3).mul(0.22).add(0.05).mul(hFill))).mul(hBreathe).mul(hLevel)
    em = em.add(hCol.mul(hillGlow))
    // the hill's outer ring blinks red before it stops counting
    em = em.add(vec3(1.3, 0.16, 0.04).mul(onHillV.mul(hillDoomV).mul(hl.z).mul(pulse).mul(hBand.add(0.25)).mul(isTop)))
    // hard ceiling (hue kept) on the doomed ring and on tiles in transit. ACES
    // desaturates bright orange toward cream: the telegraph cracks at full
    // pulse (3.2 R + 0.5 halo) and the sinking slabs read near-white up close
    // (showcase camera, Ultra bloom). 1.2 keeps them crimson-to-ember at any
    // distance and tier; the 1 s pulse and the hot crack pattern still read.
    const emMax = max(em.r, max(em.g, em.b))
    const ringCap = max(transit, smoothstep(0, 0.05, tele))
    em = mix(em, em.mul(min(float(1), float(1.2).div(max(emMax, 0.001)))), ringCap)
    // sinking slabs: charred basalt with an ember cast, never pale (QA: white
    // shards); multiplied, so the stone's texture still shows through
    const sinkDark = isRemV.mul(sinkTV.mul(0.15).add(dropTV.mul(0.1)).add(0.75))
    const sinkTint = vec3(0.24, 0.15, 0.11)

    const m = new THREE.MeshStandardNodeMaterial()
    m.name = wall ? 'TilesWall' : 'Tiles'
    m.positionNode = positionNode

    const mode = tweaks.tileMaterial
    const maps = mode === 'procedural' ? null : this.maps
    if (maps) {
      // authored PBR set: world-planar UVs, per-tile offset + quarter turn so
      // repeats never line up across the platform
      const rot = seed.mul(4).floor().mul(Math.PI / 2)
      const cs = rot.cos()
      const sn = rot.sin()
      const base = gp.div(TILE_SIZE * 2)
      const uvTop = vec2(base.x.mul(cs).sub(base.y.mul(sn)), base.x.mul(sn).add(base.y.mul(cs))).add(seed.mul(7.31))
      const uvSide = vec2(gp.x.add(gp.y).div(TILE_SIZE), h.div(TILE_SIZE)).add(seed.mul(3.1))
      // every texture() here is recorded so a theme change can swap its value
      const tex = (slot: TexSlot, uvn: Node<'vec2'>) => {
        const node = texture(mapFor(maps, slot), uvn)
        this.texNodes.push({ node: node as unknown as { value: THREE.Texture }, slot })
        return node
      }
      // parallax occlusion on tile tops (High+): view ray marched through the
      // height map (authored height, else albedo luminance as a stand-in)
      let uvTopP: Node<'vec2'> = uvTop
      this.builtLumHeight = maps.top.height === null
      if (this.ctx.tier.ao && !wall) {
        const V = cameraPosition.sub(positionWorld).normalize()
        // world -> game (y flipped) -> per-tile rotated uv axes
        const vg = vec2(V.x, V.z.negate())
        const vUv = vec2(vg.x.mul(cs).sub(vg.y.mul(sn)), vg.x.mul(sn).add(vg.y.mul(cs)))
        const hSlot: TexSlot = this.builtLumHeight ? 'top.albedo' : 'top.height'
        uvTopP = pomUv(uvTop, vUv.div(max(V.y, 0.25)), (u) => tex(hSlot, u), this.builtLumHeight, calm ? 0.0035 : 0.008, 8)
      }
      // POM only on the flat tops: on the 45 degree bevel the horizontal-surface
      // march stretched and darkened the albedo (the dark band under the rim)
      const uvT = wall ? uvSide : mix(uvTop, uvTopP, isTop)
      let alb: Node<'vec3'> = tex(wall ? 'side.albedo' : 'top.albedo', uvT).rgb
      let orm: Node<'vec3'> = tex(wall ? 'side.orm' : 'top.orm', uvT).rgb
      let tint: Node<'float'> = n.r.mul(0.3).add(0.85)
      if (calm) {
        // flatten the authored flagstone pattern: blend each texel toward its
        // local mean (a coarse mip), so the tile reads as one stone with soft
        // mottling instead of a sub-grid of small stones
        // (1024 px spans two tiles: mip 7 = 128 px texels, about the size of
        // the authored sub-stones, so they average out)
        const mean = wall ? tex('side.albedo', uvT).level(float(6)).rgb : tex('top.albedo', uvT).level(float(7)).rgb
        alb = mix(mean, alb, float(wall ? 0.65 : 0.3))
        const aoMean = wall ? tex('side.orm', uvT).level(float(6)).r : tex('top.orm', uvT).level(float(7)).r
        orm = vec3(mix(aoMean, orm.r, 0.25), orm.g, orm.b)
        // per-tile variation: small, plus slow platform-wide patches
        tint = float(1).add(n.r.sub(0.5).mul(0.07)).add(nMacro.g.sub(0.5).mul(0.16))
      }
      let col = alb.mul(tint).mul(orm.r)
      col = col.mul(float(1).sub(rune.mul(0.45)))
      col = col.mul(calm ? mix(float(1), float(0.88), smoothstep(0.965, 1.0, edge).mul(isTop)) : mix(float(1), float(0.65), smoothstep(0.9, 1.0, edge).mul(isTop)))
      if (calm) col = col.mul(this.uLift)
      m.colorNode = mix(col, col.mul(sinkTint), sinkDark)
      // the top maps are sampled in a per-tile rotated frame: rotate the
      // tangent-space normal back by -rot so it agrees with the mesh uv frame
      let nT: Node<'vec3'>
      if (wall) nT = tex('side.normal', uvT).xyz.mul(2).sub(1)
      else {
        const nTop = tex('top.normal', uvT).xyz.mul(2).sub(1)
        nT = vec3(nTop.x.mul(cs).add(nTop.y.mul(sn)), nTop.y.mul(cs).sub(nTop.x.mul(sn)), nTop.z)
      }
      const nTS = nT.mul(0.5).add(0.5)
      // calm relief: tops at ~40 % of the authored strength, walls a bit more
      const nScale = float(calm ? (wall ? 0.6 : 0.14) : wall ? 0.8 : 0.45)
      m.normalNode = calm ? calmBevel(normalMap(nTS, vec2(nScale, nScale)), isBevel) : normalMap(nTS, vec2(nScale, nScale))
      // never mirror-smooth: low-roughness texels made tile-sized moon hotspots
      // matte basalt; only genuinely glossy texels (wet / obsidian) stay shiny
      // (charred sinking slabs go matte: a moonlit sheen read as a milky haze)
      m.roughnessNode = mix(select(orm.g.lessThan(0.22), float(0.38), max(orm.g, 0.66)), float(0.95), isRemV)
      m.metalnessNode = orm.b.mul(0.3)
    } else {
      m.colorNode = mix(stone, stone.mul(sinkTint), sinkDark)
      // relief: grain + chips + cut cracks and glyphs
      const relief = n2.g.mul(0.45).add(nMicro.r.mul(0.35)).add(n.r.mul(0.2)).sub(crackLine.mul(0.6)).sub(rune.mul(0.3)).sub(chips.mul(0.25))
      const bump = bumpMap(relief.mul(isTop.add(isSide.mul(0.5))), float(calm ? 0.22 : 0.5))
      m.normalNode = calm ? calmBevel(bump, isBevel) : bump
      m.roughnessNode = mix(clamp(rough, 0.62, 1), float(0.95), isRemV)
      m.metalnessNode = float(0)
    }
    // debug (Inspector: Arena > debugFaces): 1 = face classes, 2 = lighting only on white
    const dbg = tweaks.uDebugFaces
    const dbgClasses = step(0.5, dbg).mul(step(dbg, 1.5))
    const dbgLight = step(1.5, dbg)
    m.emissiveNode = mix(mix(em, vec3(isTop, isBevel, isSide).mul(2), dbgClasses), vec3(0, 0, 0), dbgLight)
    m.colorNode = mix(m.colorNode as Node<'vec3'>, vec3(0.8, 0.8, 0.8), dbgLight)
    return m
  }

  dispose(): void {
    this.disposed = true
    for (const m of this.meshes.values()) {
      m.mesh.geometry.dispose()
      m.mesh.dispose()
    }
    for (const m of this.materials) m.dispose()
  }
}

/**
 * Parallax occlusion mapping: march layers along the tangent-space view
 * direction (uv units per unit depth = viewUv), then interpolate between the
 * last two layers. Gradients are taken outside the loop (textureGrad), so the
 * loop is valid non-uniform control flow in WGSL.
 *
 * The layer count follows the deepest shift this pixel can show: about two
 * layers per screen pixel of shift, POM_MIN_STEPS..maxSteps. At gameplay zoom
 * the whole relief moves the texture by about a pixel, and 3 layers give the
 * same image as 8 (pixel diff at the noise floor); close cameras still march
 * all 8.
 */
const POM_MIN_STEPS = 3

function pomUv(uv0: Node<'vec2'>, viewUv: Node<'vec2'>, sampleH: (u: Node<'vec2'>) => ReturnType<typeof texture>, luminance: boolean, scale: number, maxSteps: number): Node<'vec2'> {
  const gx = dFdx(uv0)
  const gy = dFdy(uv0)
  const depthAt = (u: Node<'vec2'>) => {
    const t = sampleH(u).grad(gx, gy) as unknown as Node<'vec4'>
    const h = luminance ? dot(t.rgb, vec3(0.3, 0.55, 0.15)).mul(1.6).clamp(0, 1) : t.r
    return float(1).sub(h)
  }
  return Fn(() => {
    // full-depth shift in pixels: uv shift over the uv footprint of one pixel
    const shiftPx = length(viewUv).mul(scale).div(max(max(length(gx), length(gy)), 1e-7))
    const steps = clamp(ceil(shiftPx.mul(2)), POM_MIN_STEPS, maxSteps).toVar()
    const layer = float(1).div(steps)
    const delta = viewUv.mul(scale).div(steps)
    const uvc = uv0.toVar()
    const depth = float(0).toVar()
    const d = depthAt(uv0).toVar()
    Loop({ start: int(0), end: int(steps), type: 'int', condition: '<' }, () => {
      If(depth.lessThan(d), () => {
        uvc.subAssign(delta)
        depth.addAssign(layer)
        d.assign(depthAt(uvc))
      })
    })
    const prev = uvc.add(delta)
    const after = d.sub(depth)
    const before = depthAt(prev).sub(depth.sub(layer))
    const w = saturate(after.div(after.sub(before).add(1e-4)))
    return mix(uvc, prev, w)
  })() as unknown as Node<'vec2'>
}

type TexSlot = 'top.albedo' | 'top.orm' | 'top.normal' | 'top.height' | 'side.albedo' | 'side.orm' | 'side.normal'

/** texture for a map slot of a theme set (side falls back to top, height to albedo) */
function mapFor(m: { top: SurfaceMaps; side: SurfaceMaps | null }, slot: TexSlot): THREE.Texture {
  const side = m.side ?? m.top
  switch (slot) {
    case 'top.albedo':
      return m.top.albedo
    case 'top.orm':
      return m.top.orm
    case 'top.normal':
      return m.top.normal
    case 'top.height':
      return m.top.height ?? m.top.albedo
    case 'side.albedo':
      return side.albedo
    case 'side.orm':
      return side.orm
    case 'side.normal':
      return side.normal
  }
}
