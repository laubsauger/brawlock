import * as THREE from 'three/webgpu'
import {
  abs,
  Fn,
  If,
  Loop,
  attribute,
  bumpMap,
  cameraPosition,
  clamp,
  dFdx,
  dFdy,
  dot,
  exp,
  normalMap,
  float,
  length,
  max,
  min,
  mix,
  normalGeometry,
  positionGeometry,
  positionLocal,
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
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import { GRID_MAX, TILE_SIZE, arenaTiles, cellIndex, clampLayer, tileExists } from '../arenaGeom'
import { S } from '../coords'
import { tweaks } from '../tweaks'
import { THEME_DIRS, loadSurface, type SurfaceMaps } from './textures'
import { buildTileGeometry } from './tileGeometry'
import { asV4, gamePos, type WorldCtx } from './world'

/** Seconds a removed tile takes to sink out of sight. */
export const SINK_DUR = 0.55
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
  mesh: THREE.InstancedMesh
  attr: THREE.InstancedBufferAttribute
}

/**
 * Instanced tile platform. One InstancedMesh per rounded-corner mask (at most
 * 16, usually ~9 with instances); a removed tile keeps its slot with a
 * `removedAt` stamp and sinks red-hot into the lava in the shader.
 */
export class Arena {
  readonly group = new THREE.Group()
  /** 0..1, pulses the next ring red before a shrink */
  readonly uTelegraph = uniform(0)
  /** shockwave: game x, y, start time, strength */
  readonly uShock = uniform(new THREE.Vector4(0, 0, -100, 0))
  private uStoneA = uniform(new THREE.Color())
  private uStoneB = uniform(new THREE.Color())
  private uRune = uniform(new THREE.Color())
  private uRough = uniform(0.8)
  private material: THREE.MeshStandardNodeMaterial
  private meshes = new Map<number, MaskMesh>()
  private tiles = new Map<number, TileEntry>()
  private sinking: TileEntry[] = []
  private layer = -1
  private theme = -1
  private dirty = false
  private tmpM = new THREE.Matrix4()
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
    this.material = this.buildMaterial()
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
    const old = this.material
    this.texNodes = []
    this.material = this.buildMaterial()
    for (const m of this.meshes.values()) m.mesh.material = this.material
    old.dispose()
  }

  /**
   * Switch to `layer`. With `animate`, removed tiles sink and new tiles rise;
   * otherwise the platform snaps (initial state, new match).
   */
  setLayer(layer: number, now: number, animate: boolean): void {
    const L = clampLayer(layer)
    if (L === this.layer) return
    const next = arenaTiles(L)
    const nextIdx = new Set<number>()
    for (const t of next) nextIdx.add(cellIndex(t.gx, t.gy))
    // removals
    for (const [idx, e] of this.tiles) {
      if (nextIdx.has(idx)) continue
      this.tiles.delete(idx)
      if (animate) {
        e.removedAt = now
        e.ring = 0
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
      const before = this.sinking.length
      this.sinking = this.sinking.filter((e) => now - e.removedAt < SINK_DUR + 0.15)
      if (this.sinking.length !== before) this.dirty = true
    }
    if (this.dirty) this.rebuild()
  }

  private meshFor(mask: number): MaskMesh {
    let m = this.meshes.get(mask)
    if (m) return m
    const geo = buildTileGeometry(mask)
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 4), 4)
    attr.setUsage(THREE.StaticDrawUsage)
    geo.setAttribute('aTile', attr)
    const mesh = new THREE.InstancedMesh(geo, this.material, CAPACITY)
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
    mesh.frustumCulled = false
    mesh.receiveShadow = this.ctx.tier.shadowMap > 0
    mesh.count = 0
    mesh.name = `tiles-m${mask}`
    this.group.add(mesh)
    m = { mesh, attr }
    this.meshes.set(mask, m)
    return m
  }

  private rebuild(): void {
    this.dirty = false
    const counts = new Map<number, number>()
    for (const m of this.meshes.values()) m.mesh.count = 0
    const put = (e: TileEntry) => {
      const mm = this.meshFor(e.mask)
      const i = counts.get(e.mask) ?? 0
      if (i >= CAPACITY) return
      counts.set(e.mask, i + 1)
      this.tmpM.makeTranslation(e.gx * TILE_SIZE * S, 0, -e.gy * TILE_SIZE * S)
      mm.mesh.setMatrixAt(i, this.tmpM)
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
      mm.mesh.count = n
      mm.mesh.visible = n > 0
      mm.mesh.instanceMatrix.needsUpdate = true
      mm.attr.needsUpdate = true
    }
  }

  private buildMaterial(): THREE.MeshStandardNodeMaterial {
    const { uTime: t, noise, field, glow } = this.ctx
    const aTile = asV4(attribute('aTile', 'vec4'))
    const seed = aTile.x
    const removedAt = aTile.y
    const addedAt = aTile.z
    const ring = aTile.w

    // ---------------- vertex: sink, rise, shockwave lift
    const isRem = step(0, removedAt)
    const sinkT = saturate(t.sub(removedAt).div(SINK_DUR)).mul(isRem)
    const sink = sinkT.mul(sinkT).mul(150)
    const tiltA = sinkT.mul(0.35)
    const phi = seed.mul(6.2831)
    const tilted = rotate(positionGeometry, vec3(tiltA.mul(phi.cos()), 0, tiltA.mul(phi.sin())))
    const riseT = saturate(t.sub(addedAt).div(RISE_DUR))
    const back = float(1).sub(riseT)
    // ease-out with a small overshoot
    const rise = back.mul(back).mul(back).mul(-170).add(sin(riseT.mul(Math.PI)).mul(6))
    const centre = positionLocal.sub(positionGeometry)
    const sh = this.uShock
    // (the round-start wave no longer lifts tiles: it exposed bright wall strips)
    const lift = rise.sub(sink)
    const positionNode = centre.add(tilted).add(vec3(0, lift.mul(S), 0))

    // ---------------- fragment: layered stone
    // fragment reads of the clock go through vertex varyings (the fragment
    // stage's own uniform copy did not track the frame clock)
    const tF = varying(t)
    const sinkTV = varying(sinkT)
    const isRemV = varying(isRem)
    const gp = gamePos()
    const lp = positionGeometry.xz.div(TILE_SIZE * 0.5 * S)
    const ny = normalGeometry.y
    const isTop = step(0.9, ny)
    const isBevel = step(0.3, ny).mul(float(1).sub(isTop))
    const isSide = float(1).sub(step(0.3, ny))
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
    stone = stone.mul(n2.g.mul(0.36).add(0.82)).mul(nMicro.r.mul(0.22).add(0.89))
    // cavity: cracks and the halo around them darken, seams fall into shadow
    stone = stone.mul(float(1).sub(crackLine.mul(0.7)).sub(crackHalo.mul(0.12)))
    stone = stone.mul(mix(float(1), float(0.62), smoothstep(0.9, 1.0, edge).mul(isTop)))
    // edge wear: the chamfer and chipped rims are polished lighter by feet
    const chips = smoothstep(0.55, 0.75, nMicro.g).mul(smoothstep(0.78, 0.95, edge)).mul(isTop)
    const wear = saturate(isBevel.mul(0.8).add(chips))
    stone = mix(stone, stone.mul(1.65).add(0.015), wear.mul(0.7))
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
    const outerWall = smoothstep(-170, -50, sd)
    const wallFall = exp(h.div(-22))
    const sideHeat = isSide.mul(mix(wallFall.mul(0.05), wallFall.mul(0.6).add(0.4), outerWall))

    const albedoLum = stone.r.add(stone.g).add(stone.b).mul(1.4).add(0.05)
    let em = glow.at(gp).mul(albedoLum).mul(mix(float(0.5), float(0.25), isSide))
    // lava veins: heat seeping up through the cracks, stronger toward the shore
    const veinPulse = sin(tF.mul(0.9).add(n.b.mul(12)).add(seed.mul(20))).mul(0.25).add(0.75)
    const vein = crackLine.mul(nearLava.mul(1.2).mul(tweaks.uEdgeGlow).add(0.05)).mul(veinPulse)
    em = em.add(vec3(1.5, 0.3, 0.04).mul(vein))
    em = em.add(this.uRune.mul(rune).mul(runePulse.mul(0.05)).mul(tele.mul(14).add(1)))
    em = em.add(vec3(1.2, 0.26, 0.04).mul(edgeHeat.mul(0.2)).mul(tweaks.uEdgeGlow))
    // lava bounce: the shore lights nearby stone orange (modulated by albedo);
    // walls always catch some of it from below
    em = em.add(vec3(1.0, 0.36, 0.08).mul(albedoLum).mul(nearLava.mul(0.6).mul(tweaks.uEdgeGlow).add(isSide.mul(mix(float(0.08), float(1.1), outerWall)))))
    em = em.add(vec3(1.9, 0.42, 0.06).mul(sideHeat))
    // telegraph: the doomed ring heats from within, cracks first, then the slab
    // removed tiles carry the telegraph's crimson on (the cue players learned)
    // and cool as they sink, instead of jumping to a new flat colour
    const teleP = max(tele.mul(pulse.mul(0.7).add(0.3)), isRemV.mul(float(1).sub(sinkTV)).mul(0.6))
    em = em.add(vec3(0.16, 0.008, 0.003).mul(teleP).mul(isTop.mul(0.7).add(0.3)))
    em = em.add(vec3(3.2, 0.35, 0.06).mul(teleP).mul(crackHalo.mul(0.5).add(crackLine).add(smoothstep(0.86, 1.0, edge).mul(isTop).mul(0.6))))
    // removed tiles: the telegraph's faint crimson body glow (its hot cracks carry
    // on above), cooling as they sink. The old (3.2, 0.9, 0.16) tone-mapped to
    // cream-white for 0.2-0.4 s on every shrink; even 0.4 red over the moonlit
    // stone read salmon-pink.
    const hotCol = mix(vec3(0.2, 0.014, 0.005), vec3(0.06, 0.004, 0.002), sinkTV)
    em = em.add(hotCol.mul(isRemV).mul(float(1).sub(sinkTV.mul(0.6))))
    // round-start pulse: pale arcane white-gold ring, evaluated PER FRAGMENT so
    // it sweeps as a smooth band (a per-tile value lit whole tiles as squares)
    const shAgeF = tF.sub(sh.z)
    const shDf = length(gp.sub(sh.xy))
    const shXf = shDf.sub(shAgeF.mul(2600)).div(90)
    const waveF = exp(shXf.mul(shXf).negate()).mul(sh.w).mul(saturate(float(1.2).sub(shAgeF))).mul(step(0, shAgeF))
    em = em.add(vec3(0.5, 0.48, 0.62).mul(waveF.mul(0.16)).mul(isTop))
    // hard ceiling on tiles in transit (hue kept): bloom must never saturate a
    // whole slab; thin hot cracks still read
    const emMax = max(em.r, max(em.g, em.b))
    em = mix(em, em.mul(min(float(1), float(1.8).div(max(emMax, 0.001)))), transit)
    // sinking slabs: dark basalt with an ember cast, never pale (QA: white shards)
    const sinkDark = isRemV.mul(sinkTV.mul(0.25).add(0.75))
    const sinkTint = vec3(0.28, 0.17, 0.14)

    const m = new THREE.MeshStandardNodeMaterial()
    m.name = 'Tiles'
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
      if (this.ctx.tier.ao) {
        const V = cameraPosition.sub(positionWorld).normalize()
        // world -> game (y flipped) -> per-tile rotated uv axes
        const vg = vec2(V.x, V.z.negate())
        const vUv = vec2(vg.x.mul(cs).sub(vg.y.mul(sn)), vg.x.mul(sn).add(vg.y.mul(cs)))
        const hSlot: TexSlot = this.builtLumHeight ? 'top.albedo' : 'top.height'
        uvTopP = pomUv(uvTop, vUv.div(max(V.y, 0.25)), (u) => tex(hSlot, u), this.builtLumHeight, 0.008, 8)
      }
      // POM only on the flat tops: on the 45 degree bevel the horizontal-surface
      // march stretched and darkened the albedo (the dark band under the rim)
      const uvT = mix(mix(uvTop, uvTopP, isTop), uvSide, isSide)
      const alb = mix(tex('top.albedo', uvT).rgb, tex('side.albedo', uvT).rgb, isSide)
      const orm = mix(tex('top.orm', uvT).rgb, tex('side.orm', uvT).rgb, isSide)
      const tint = n.r.mul(0.3).add(0.85)
      let col = alb.mul(tint).mul(orm.r)
      col = col.mul(float(1).sub(rune.mul(0.45)))
      col = col.mul(mix(float(1), float(0.65), smoothstep(0.9, 1.0, edge).mul(isTop)))
      m.colorNode = mix(col, col.mul(sinkTint), sinkDark)
      // the top maps are sampled in a per-tile rotated frame: rotate the
      // tangent-space normal back by -rot so it agrees with the mesh uv frame
      const nTop = tex('top.normal', uvT).xyz.mul(2).sub(1)
      const nTopR = vec3(nTop.x.mul(cs).add(nTop.y.mul(sn)), nTop.y.mul(cs).sub(nTop.x.mul(sn)), nTop.z)
      const nSide = tex('side.normal', uvT).xyz.mul(2).sub(1)
      const nTS = mix(nTopR, nSide, isSide).mul(0.5).add(0.5)
      // calm relief: tops at ~40 % of the authored strength, walls a bit more
      const nScale = mix(float(0.45), float(0.8), isSide)
      m.normalNode = normalMap(nTS, vec2(nScale, nScale))
      // never mirror-smooth: low-roughness texels made tile-sized moon hotspots
      // matte basalt; only genuinely glossy texels (wet / obsidian) stay shiny
      m.roughnessNode = select(orm.g.lessThan(0.22), float(0.38), max(orm.g, 0.66))
      m.metalnessNode = orm.b.mul(0.3)
    } else {
      m.colorNode = mix(stone, stone.mul(sinkTint), sinkDark)
      // relief: grain + chips + cut cracks and glyphs
      const relief = n2.g.mul(0.45).add(nMicro.r.mul(0.35)).add(n.r.mul(0.2)).sub(crackLine.mul(0.6)).sub(rune.mul(0.3)).sub(chips.mul(0.25))
      m.normalNode = bumpMap(relief.mul(isTop.add(isSide.mul(0.5))), float(0.5))
      m.roughnessNode = clamp(rough, 0.62, 1)
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
    this.material.dispose()
  }
}

/**
 * Parallax occlusion mapping: march `steps` layers along the tangent-space
 * view direction (uv units per unit depth = viewUv), then interpolate between
 * the last two layers. Gradients are taken outside the loop (textureGrad), so
 * the loop is valid non-uniform control flow in WGSL.
 */
function pomUv(uv0: Node<'vec2'>, viewUv: Node<'vec2'>, sampleH: (u: Node<'vec2'>) => ReturnType<typeof texture>, luminance: boolean, scale: number, steps: number): Node<'vec2'> {
  const gx = dFdx(uv0)
  const gy = dFdy(uv0)
  const depthAt = (u: Node<'vec2'>) => {
    const t = sampleH(u).grad(gx, gy) as unknown as Node<'vec4'>
    const h = luminance ? dot(t.rgb, vec3(0.3, 0.55, 0.15)).mul(1.6).clamp(0, 1) : t.r
    return float(1).sub(h)
  }
  return Fn(() => {
    const layer = float(1 / steps)
    const delta = viewUv.mul(scale / steps)
    const uvc = uv0.toVar()
    const depth = float(0).toVar()
    const d = depthAt(uv0).toVar()
    Loop(steps, () => {
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
