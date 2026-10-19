import * as THREE from 'three/webgpu'
import { fog, rangeFogFactor, uniform, vec3 } from 'three/tsl'
import type { PawnState, PlayerSlot, SimEvent, SimState } from '../../sim/types'
import { TICK_HZ } from '../../sim/types'
import { TILE_SIZE, isLocationSafe, layerRadius } from '../arenaGeom'
import { inputViz } from '../../game/input'
import { cameraRig, devCamera, frameOffset, moveMarkers, spectateTarget } from '../cameraRig'
import { CameraReach, EDGE_SPEED, reachFor } from '../cameraReach'
import { PawnLocator } from '../overlay/PawnLocator'
import { renderPrefs } from '../prefs'
import { victoryCameraOffset, victoryCameraWeight } from '../victoryCamera'
import { victoryStyle } from '../character/victoryPose'
import { windupHiddenFrom } from '../character/castStyles'
import { createWarlock, warlockParams, warlockReady, type CastArm } from '../character'
import { LAVA_H, PROJECTILE_H, S, TILE_TOP_H } from '../coords'
import { WorldOverlay, type PlateInput } from '../overlay/WorldOverlay'
import type { TierConfig } from '../quality'
import type { RenderSource } from '../source'
import { Arena } from './Arena'
import { ContactShadows } from './ContactShadows'
import { Billboards } from './Billboards'
import { CastMarks, hasHandMark } from './CastMarks'
import { FacingChevrons } from './FacingChevrons'
import { MoveDestination } from './MoveDestination'
import { resolveDestination, type DestClick } from './moveDestinationLogic'
import { GroundFx, RING_CHEVRON, RING_EXPAND, RING_IMPLODE } from './GroundFx'
import { Lava } from './Lava'
import { Environment, Obstacles } from './props'
import { pendingUploads, texturesSettled } from './textures'
import { Particles } from './Particles'
import { PawnView, samplePawn, type PawnSample } from './Pawns'
import { Projectiles, spellLook } from './Projectiles'
import { Scorches } from './Scorches'
import { KEY_LIGHT_DIR, createWorldCtx, type WorldCtx } from './world'
import { spellPalette } from '../vfx/palette'
import { colorForPawn, slotColorOf } from '../teamColors'
import { spellVfxModules, vfxForModifier, vfxForSpell, type AfterHitKind, type PawnRenderInfo, type SpellVfx, type VfxCtx } from '../vfx/registry'
import '../vfx/spells'
import { toWorld } from '../coords'
import { AOE_RING_INSET, AOE_RING_THICK } from '../scale'
import { useGame, type Quality } from '../../game/store'

/** Shared with the post pipeline: hurt flash, heat haze data. */
export const postState = {
  /** 0..1 chromatic/red flash when the local pawn takes damage */
  hurt: 0,
  /** current platform SDF texture (heat haze mask) or null */
  sdf: null as THREE.DataTexture | null,
}

export interface MatchWorldOptions {
  source: RenderSource
  tier: TierConfig
  fx: number
  /** DOM element for nameplates and combat numbers; null = no overlay */
  overlayParent: HTMLElement | null
  /** 'menu' = slow orbit camera, no cursor, no overlay */
  mode: 'match' | 'menu'
  /** The menu director supplies its own camera before update/culling. */
  externalCamera?: boolean
  /** effective quality tier name (for VFX modules) */
  quality?: Quality
  /** the canvas renderer: staged texture uploads and material pre-warm */
  renderer?: THREE.WebGPURenderer
}

/** offline single-player pause (the session stops stepping; render freezes too) */
function isOfflinePaused(): boolean {
  const g = useGame.getState()
  return g.paused && g.lobby.role === 'offline'
}

/** spell level carried by a projectile / event (sim adds `level`; 1 when absent) */
export function levelOf(x: { level?: number } | null | undefined): number {
  const lv = x && typeof x.level === 'number' ? x.level : 1
  return lv > 0 ? lv : 1
}

/** visual power tier: 0 = levels 1-2, 1 = 3-5, 2 = 6-7 (visuals only, never hitboxes) */
export function powerTier(level: number): 0 | 1 | 2 {
  return level >= 6 ? 2 : level >= 3 ? 1 : 0
}

/** spell id carried by an event, for VFX module claiming */
function eventSpell(e: SimEvent): string | null {
  if ('spell' in e && typeof e.spell === 'string') return e.spell
  if (e.type === 'teleport') return 'teleport'
  return null
}

interface Beam {
  x0: number
  y0: number
  x1: number
  y1: number
  h: number
  born: number
  life: number
  r: number
  g: number
  b: number
}

interface Flash {
  x: number
  y: number
  h: number
  born: number
  life: number
  radius: number
  size: number
  r: number
  g: number
  b: number
}

/** warlock detail test (game units): bounds centre height, radius incl. cloth + cast shadow, model height */
const DETAIL_CENTER_H = 90
const DETAIL_RADIUS = 230
const WARLOCK_HEIGHT = 190
/** below this fraction of the viewport height a warlock counts as far (detail 1): default zoom ~0.19, max zoom-out ~0.14 at screen centre, less toward the top edge */
const DETAIL_FAR_FRAC = 0.12

/** persistent move destination brightness (identity colour x this, additive) */
const DEST_ALPHA = 1.3

/** main-thread budget per frame for texture uploads (decoded bitmaps: ~1-3 ms each) */
const UPLOAD_BUDGET_MS = 4

const SCOURGE_COLOR = [1.5, 0.55, 2.4] as const
/** max summed flash energy per frame (sum of (size/300)^2 x brightness) */
const FLASH_BUDGET = 6
/** half-extent of the key-light shadow frustum, three units */
const SHADOW_EXT = 14
const TELEPORT_COLOR = [0.55, 0.9, 2.6] as const

/**
 * Everything the match (or menu) scene draws, driven imperatively once per
 * frame from the render source. Owns all three objects it creates.
 */
export class MatchWorld {
  readonly root = new THREE.Group()
  readonly ctx: WorldCtx
  readonly arena: Arena
  private lava: Lava
  private env: Environment
  /** distance haze for the scene (set as scene.fogNode by the owner) */
  readonly fogNode
  private uFogNear = uniform(24)
  private uFogFar = uniform(95)
  /** current shadow frustum half-extent (three units), grows with zoom */
  private shadowExt = SHADOW_EXT
  /** edge pan / peek / aim look-ahead offset for the local warlock */
  private reach = new CameraReach()
  private reachSeq = 0
  private locator: PawnLocator | null = null
  private particles: Particles
  private smoke: Particles
  private ground: GroundFx
  private groundShadow: GroundFx
  /** single-slot move marker (+ its shadow): a new order replaces the old one */
  private marker: GroundFx
  private markerShadow: GroundFx
  private scorches: Scorches
  private obstacles: Obstacles
  private debris: Particles
  private billboards: Billboards
  /** windup telegraphs drawn over bodies (no depth test) */
  private billboardsTop: Billboards
  private castMarks = new CastMarks()
  /** facing chevrons for every warlock (one draw), drawn over the bodies */
  private chevrons = new FacingChevrons(16)
  /** local player's persistent move destination (after the click burst) */
  private dest!: MoveDestination
  private projectiles: Projectiles
  private overlay: WorldOverlay | null
  private views = new Map<number, PawnView>()
  private sample: PawnSample = { x: 0, y: 0, facing: 0 }
  private plates: PlateInput[] = []
  private flashes: Flash[] = []
  private beams: Beam[] = []
  private handRings: { x: number; y: number; h: number; born: number; life: number; r: number; g: number; b: number }[] = []
  private ghosts: { x: number; y: number; h: number; born: number; life: number; r: number; g: number; b: number; pillar?: boolean }[] = []
  private bv0 = new THREE.Vector3()
  private bv1 = new THREE.Vector3()
  /** world clock (s): stops during hit-stop so every effect freezes together */
  private clock = 0
  private hitStop = 0
  private lastEventTick = -1
  private lastStateTick = -1
  private emberAcc = 0
  private bubbleAcc = 0
  private lastCallout = -10
  private orbit = 0
  private deathFocus: { x: number; y: number; at: number } | null = null
  private victoryShot: { pawn: number; round: number; at: number; facing: number; x: number; y: number; floorH: number; releasedAt: number | null } | null = null
  private victoryAim = new THREE.PerspectiveCamera()
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  private spectateId = -1
  private lastLayer = -1
  private removedRing: { x: number; y: number }[] = []
  // cursor raycast
  readonly pointer = { x: 0, y: 0, inside: false }
  private raycaster = new THREE.Raycaster()
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -TILE_TOP_H * S)
  private ndc = new THREE.Vector2()
  private hit = new THREE.Vector3()
  private tmpV = new THREE.Vector3()
  // ---- spell VFX plugin modules (match only)
  private modulesOn: boolean
  private inited = new Set<SpellVfx>()
  private vfxFrame = { now: 0, dt: 0, state: null as SimState | null, prev: null as SimState | null, alpha: 1 }
  private pawnInfos = new Map<number, PawnRenderInfo>()
  readonly vfx: VfxCtx
  private hemi: THREE.HemisphereLight
  private moon: THREE.DirectionalLight
  private contact = new ContactShadows(128)
  /** key light direction (toward the light), from the camera's left-back, high */
  private moonDir = KEY_LIGHT_DIR
  /** light-space basis perpendicular to the key light (shadow texel snapping) */
  private lightRight = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), KEY_LIGHT_DIR).normalize()
  private lightUp = new THREE.Vector3().crossVectors(KEY_LIGHT_DIR, new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), KEY_LIGHT_DIR).normalize()).normalize()

  constructor(private opts: MatchWorldOptions) {
    this.ctx = createWorldCtx(opts.tier, opts.fx)
    const ctx = this.ctx
    this.root.name = 'MatchWorld'
    this.lava = new Lava(ctx)
    this.arena = new Arena(ctx)
    this.env = new Environment(ctx)
    // haze range follows the zoom (24..95 at the default distance), so the
    // overview zoom does not drown the arena
    this.fogNode = fog(vec3(0.045, 0.014, 0.009), rangeFogFactor(this.uFogNear, this.uFogFar))
    this.particles = new Particles(ctx, 4096 * Math.max(0.5, opts.tier.particles), 'add')
    this.smoke = new Particles(ctx, 768 * Math.max(0.5, opts.tier.particles), 'smoke')
    this.ground = new GroundFx(ctx)
    this.groundShadow = new GroundFx(ctx, 'shadow')
    this.marker = new GroundFx(ctx, 'add', 1)
    this.markerShadow = new GroundFx(ctx, 'shadow', 1)
    this.scorches = new Scorches(ctx)
    this.obstacles = new Obstacles(ctx)
    this.obstacles.onHit = (x, y, r, hpFrac) => this.obstacleChips(x, y, r, hpFrac, null)
    this.debris = new Particles(ctx, 512, 'debris')
    this.billboards = new Billboards(160, opts.tier.heatHaze, this.ctx.field)
    this.billboardsTop = new Billboards(96, false, null, true)
    this.projectiles = new Projectiles(ctx, this.particles, this.smoke, this.billboards)
    // night: low cool ambient from the sky, warm bounce from the lava below,
    // a cool moon key from high behind the camera's left (lights the faces the
    // camera sees; shadows fall up-right on screen)
    // the moon dominates the open floor so its cast shadows read (~0.6+ density);
    // the lava bounce from below keeps shadowed sides warm instead of flat
    this.hemi = new THREE.HemisphereLight(0x1e1932, 0xff4a12, 0.7)
    this.moon = new THREE.DirectionalLight(0xa4b6ff, 2.2)
    this.moon.position.copy(this.moonDir).multiplyScalar(30)
    if (opts.tier.shadowMap > 0) {
      const sh = this.moon.shadow
      this.moon.castShadow = true
      sh.mapSize.set(opts.tier.shadowMap, opts.tier.shadowMap)
      // fitted to the view at max zoom (~2700 units across), texel-snapped below
      const ext = SHADOW_EXT
      const cam = sh.camera as THREE.OrthographicCamera
      cam.left = -ext
      cam.right = ext
      cam.top = ext
      cam.bottom = -ext
      cam.near = 1
      cam.far = 70
      // refreshed every Nth frame (tier.shadowEvery), see updateShadowCadence
      sh.autoUpdate = opts.tier.shadowEvery <= 1
      // tight bias: shadows must start AT the feet / pillar base (no peter-panning)
      sh.bias = -0.00015
      sh.normalBias = 0.004
      sh.radius = 3
    }
    this.root.add(this.hemi, this.moon, this.moon.target, this.contact.mesh)
    this.root.add(this.lava.mesh, this.env.group, this.arena.group, this.obstacles.group, this.debris.sprite, this.scorches.mesh, this.groundShadow.mesh, this.markerShadow.mesh, this.ground.mesh, this.marker.mesh, this.smoke.sprite, this.particles.sprite, this.billboards.sprite, this.billboardsTop.sprite, this.castMarks.batch.sprite, this.projectiles.mesh, this.chevrons.mesh)
    this.dest = new MoveDestination(this.ctx.uTime)
    this.root.add(this.dest.mesh)
    this.overlay = opts.mode === 'match' && opts.overlayParent ? new WorldOverlay(opts.overlayParent) : null
    this.locator = opts.mode === 'match' && opts.overlayParent ? new PawnLocator(opts.overlayParent) : null
    for (let i = 0; i < 12; i++) {
      this.plates.push({ id: -1, x: 0, y: 0, h: 0, name: '', color: 0, nameColor: 0, hp: 0, maxHp: 1, kbPoints: 0, visible: false, local: false })
    }
    postState.sdf = ctx.field.texture
    postState.hurt = 0
    this.arena.setLayer(14, 0, false)
    if (opts.mode === 'match') cameraRig.reset()
    this.modulesOn = opts.mode === 'match'
    this.vfx = this.buildVfxCtx()
  }

  // ---------------------------------------------------------------- uploads

  private shadowFrame = 0

  /**
   * Prewarm (lobby / behind the loading overlay): one warlock per style sits
   * under the lava so its materials, skinning and shadow variants compile,
   * and pending texture uploads drain at once instead of one per frame.
   * Ends automatically when a real match state arrives.
   */
  private prewarmOn = false
  private prewarmGroup: THREE.Group | null = null
  private prewarmWarlocks: { dispose(): void }[] = []
  private prewarmState: unknown = null

  setPrewarm(on: boolean): void {
    if (on === this.prewarmOn) return
    this.prewarmOn = on
    if (on) {
      this.prewarmState = this.opts.source.buf.curr
      const g = new THREE.Group()
      g.name = 'prewarm'
      for (const style of ['cc0', 'procedural'] as const) {
        try {
          const w = createWarlock({ color: 0x888888, style, ctx: this.ctx })
          w.object3d.position.set(style === 'cc0' ? -0.6 : 0.6, -3, 0)
          g.add(w.object3d)
          this.prewarmWarlocks.push(w)
        } catch {
          /* character not available: nothing to warm */
        }
      }
      this.root.add(g)
      this.prewarmGroup = g
    } else this.endPrewarm()
  }

  private endPrewarm(): void {
    this.prewarmOn = false
    if (this.prewarmGroup) this.root.remove(this.prewarmGroup)
    this.prewarmGroup = null
    for (const w of this.prewarmWarlocks) w.dispose()
    this.prewarmWarlocks = []
  }

  /** true when no texture uploads are pending (prewarm readiness) */
  get uploadsDone(): boolean {
    return texturesSettled()
  }

  /** Re-render the key-light shadow map every tier.shadowEvery frames. */
  private updateShadowCadence(): void {
    const every = this.opts.tier.shadowEvery
    if (every <= 1 || !this.moon.castShadow) return
    this.shadowFrame = (this.shadowFrame + 1) % every
    if (this.shadowFrame === 0) this.moon.shadow.needsUpdate = true
  }

  /** Upload pending textures on a per-frame time budget (at least one per frame). */
  private drainUploads(): void {
    const r = this.opts.renderer
    if (!r) return
    const t0 = performance.now()
    while (pendingUploads.length > 0) {
      const tex = pendingUploads.shift()!
      try {
        r.initTexture(tex)
      } catch {
        /* renderer not ready / disposed: it will upload on first use */
      }
      if (performance.now() - t0 > UPLOAD_BUDGET_MS) break
    }
  }

  private buildVfxCtx(): VfxCtx {
    const self = this
    const fr = this.vfxFrame
    const info = (v: PawnView | undefined, id: number): PawnRenderInfo | null => {
      if (!v) return null
      let pi = self.pawnInfos.get(id)
      if (!pi) {
        const origin = new THREE.Vector3()
        pi = { x: 0, y: 0, h: 0, color: 0, owner: -1, alive: false, onLava: false, castOrigin: origin, tip: origin }
        self.pawnInfos.set(id, pi)
      }
      pi.x = v.x
      pi.y = v.y
      pi.h = v.h
      pi.color = v.color.getHex()
      pi.owner = v.owner
      pi.alive = v.alive && !v.dead
      pi.onLava = v.onLava
      v.castOrigin(pi.castOrigin)
      return pi
    }
    return {
      get now() {
        return fr.now
      },
      get dt() {
        return fr.dt
      },
      get state() {
        return fr.state
      },
      get prev() {
        return fr.prev
      },
      get alpha() {
        return fr.alpha
      },
      get localPlayer() {
        return self.opts.source.buf.localPlayer
      },
      get fx() {
        return self.opts.fx
      },
      get quality() {
        return self.opts.quality ?? 'high'
      },
      tier: this.opts.tier,
      scene: this.root,
      get camera() {
        return self.lastCamera!
      },
      world: this.ctx,
      particles: this.particles,
      smoke: this.smoke,
      debris: this.debris,
      billboards: this.billboards,
      ground: this.ground,
      groundShadow: this.groundShadow,
      scorches: this.scorches,
      contact: this.contact,
      glow: this.ctx.glow,
      pawn: (id) => info(self.views.get(id), id),
      pawnOf: (owner) => {
        for (const [id, v] of self.views) if (v.owner === owner) return info(v, id)
        return null
      },
      colorOf: (owner) => (fr.state ? self.colorOf(fr.state, owner) : 0xffffff),
      floorAt: (x, y) => (isLocationSafe(x, y, self.arena.currentLayer) ? TILE_TOP_H : LAVA_H),
      isLava: (x, y) => !isLocationSafe(x, y, self.arena.currentLayer),
      toWorld: (x, y, h, out) => toWorld(x, y, h, out),
      flash: (x, y, h, life, radius, size, r, g, b) => self.flash(x, y, h, life, radius, size, r, g, b),
      shake: (a) => {
        if (self.opts.mode === 'match') cameraRig.shake(a)
      },
      shakeNear: (x, y, a) => {
        if (self.opts.mode === 'match') self.shakeNear(x, y, a)
      },
      kick: (dx, dy, a) => {
        if (self.opts.mode === 'match') cameraRig.kick(dx, dy, a)
      },
      hitStop: (sec) => {
        if (self.opts.fx > 0.05) self.hitStop = Math.max(self.hitStop, Math.min(4 / 60, sec))
      },
      projectileShadow: (x, y, h, radius) => self.projectileShadow(x, y, h, radius),
      aoeRing: (x, y, radius, r, g, b, life) => self.aoeRing(x, y, radius, r, g, b, life),
      afterHit: (pawnId, kind, strength) => self.afterHit(pawnId, kind, strength),
      pawnVisibility: (pawnId, v) => {
        const cur = self.visOverrides.get(pawnId)
        if (cur) Object.assign(cur, v)
        else self.visOverrides.set(pawnId, { ...v })
      },
      pawnDeathFx: (pawnId, kind, dx, dy, edge) => {
        self.views.get(pawnId)?.deathFx(kind, dx, dy, edge)
      },
      get tickEvents() {
        return self.currentTickEvents
      },
      damageCause: (e) => self.damageCause(e, self.currentTickEvents),
      level: (x) => levelOf(x),
      powerTier: (lv) => powerTier(lv),
      combatText: (pawnId, amount, kind, kb) => {
        const v = self.views.get(pawnId)
        if (v) self.overlay?.number(pawnId, v.x, v.y, v.h + 120, amount, kind, self.ctx.uTime.value, kb ?? 0)
      },
    }
  }

  /** per-frame pawn visibility overrides from VFX modules (cleared every frame) */
  private visOverrides = new Map<number, { body?: number; plate?: boolean; decal?: boolean; ambient?: boolean }>()
  private currentTickEvents: readonly SimEvent[] = []

  /** spell id behind a damage event (same-tick projectile/beam/explosion/melee), 'lava', or null */
  damageCause(e: SimEvent & { type: 'damage' }, tickEvents: readonly SimEvent[]): string | null {
    if (e.kb <= 0 && e.source === null) return 'lava'
    for (const x of tickEvents) {
      if (x.type === 'projectileHit' && x.target === e.target) return x.spell
      if (x.type === 'beam' && x.target === e.target) return x.spell
      if (x.type === 'spellHit' && x.target === e.target) return x.spell
    }
    for (const x of tickEvents) if (x.type === 'explosion') return x.spell
    return null
  }

  /** Lingering after-hit effects per pawn (see VfxCtx.afterHit). */
  private lingers = new Map<number, { kind: AfterHitKind; strength: number; until: number; acc: number }[]>()

  afterHit(pawnId: number, kind: AfterHitKind, strength: number): void {
    const dur = kind === 'fire' ? 1.5 : kind === 'lightning' ? 1.0 : kind === 'shadow' ? 1.2 : kind === 'lava' ? 2.5 : 0.6
    let list = this.lingers.get(pawnId)
    if (!list) {
      list = []
      this.lingers.set(pawnId, list)
    }
    const t = this.ctx.uTime.value
    const ex = list.find((l) => l.kind === kind)
    if (ex) {
      ex.until = Math.max(ex.until, t + dur)
      ex.strength = Math.min(2, Math.max(ex.strength, strength))
    } else list.push({ kind, strength: Math.min(2, strength), until: t + dur, acc: 0 })
  }

  private tickLingers(dt: number, t: number): void {
    const ps = this.particles
    for (const [id, list] of this.lingers) {
      const v = this.views.get(id)
      if (!v || v.dead) {
        this.lingers.delete(id)
        continue
      }
      let w = 0
      for (let i = 0; i < list.length; i++) {
        const l = list[i]
        if (t > l.until) continue
        list[w++] = l
        const fade = Math.min(1, (l.until - t) / 0.5)
        l.acc += dt * l.strength * fade * this.ctx.tier.particles * (l.kind === 'lightning' ? 30 : l.kind === 'dust' ? 40 : 14)
        while (l.acc >= 1) {
          l.acc -= 1
          const a = Math.random() * Math.PI * 2
          const rr = 10 + Math.random() * 22
          const px = v.x + Math.cos(a) * rr
          const py = v.y + Math.sin(a) * rr
          const ph = v.h + 15 + Math.random() * 100
          if (l.kind === 'fire') {
            this.smoke.spawn(px, py, ph, 0, 0, 70, 0.9, 14, 55, 0.05, 0.035, 0.03, 30, 0.8, 8)
            ps.spawn(px, py, ph, (Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40, 80 + Math.random() * 80, 0.5, 6, 1.5, 3.4, 1.1, 0.2, 40, 1, 6)
          } else if (l.kind === 'lightning') {
            const sp = 200 + Math.random() * 300
            ps.spawn(px, py, ph, Math.cos(a) * sp, Math.sin(a) * sp, (Math.random() - 0.3) * sp, 0.12 + Math.random() * 0.1, 5, 1, 2.6, 3.0, 4.0, 0, 4, -0.15)
          } else if (l.kind === 'shadow') {
            this.smoke.spawn(px, py, ph, 0, 0, 60, 0.9, 16, 60, 0.015, 0.005, 0.025, 20, 0.6, 10)
            ps.spawn(px, py, ph, 0, 0, 50, 0.6, 7, 2, 0.8, 0.2, 1.4, 0, 1, 8)
          } else if (l.kind === 'lava') {
            this.smoke.spawn(px, py, v.h + 10, 0, 0, 90, 1, 18, 70, 0.05, 0.03, 0.025, 25, 0.6, 8)
            ps.spawn(px, py, v.h + 6 + Math.random() * 20, 0, 0, 100 + Math.random() * 100, 0.4, 7, 2, 3.2, 1.0, 0.18, 60, 1, 4)
          } else {
            // dust kicked up behind a sliding warlock
            const g = 0.13 + Math.random() * 0.05
            this.smoke.spawn(v.x + (Math.random() - 0.5) * 30, v.y + (Math.random() - 0.5) * 30, v.h + 4, -v.knockX * 0.1, -v.knockY * 0.1, 30, 0.7, 14, 60, g, g * 0.92, g * 0.85, 0, 2, 6)
          }
        }
      }
      list.length = w
      if (w === 0) this.lingers.delete(id)
    }
  }

  /** Crisp boundary ring at exactly the gameplay radius (see VfxCtx.aoeRing). */
  aoeRing(x: number, y: number, radius: number, r: number, g: number, b: number, life = 0.45): void {
    const floor = isLocationSafe(x, y, this.arena.currentLayer) ? TILE_TOP_H + 1.2 : LAVA_H + 2
    // static ring (r0 = r1 = radius), thin, so its visible edge IS the hit edge
    this.ground.spawn(RING_EXPAND, x, y, floor, radius - AOE_RING_INSET, radius - AOE_RING_INSET, life, AOE_RING_THICK, r, g, b)
  }

  /** Blob shadow under a flying object, offset away from the key light. */
  projectileShadow(x: number, y: number, h: number, radius: number): void {
    const lava = !isLocationSafe(x, y, this.arena.currentLayer)
    const floor = lava ? LAVA_H : TILE_TOP_H
    const above = Math.max(0, h - floor)
    const md = this.moonDir
    const sx = x + (-md.x / md.y) * above
    const sy = y + (md.z / md.y) * above
    const r = radius * (1.15 + above / 170)
    const strength = Math.max(0.12, Math.min(1, 1 - above / 700)) * (lava ? 0.35 : 0.5)
    this.contact.add(sx * S, (floor + 0.9) * S, -sy * S, r * S, strength)
  }

  private lastCamera: THREE.PerspectiveCamera | null = null
  /** snapshot held while the world is frozen (hit-stop / pause) */
  private held: { curr: SimState | null; prev: SimState | null; alpha: number } = { curr: null, prev: null, alpha: 1 }

  setFx(fx: number): void {
    this.ctx.uFx.value = fx
    this.opts.fx = fx
  }

  update(dtReal: number, camera: THREE.PerspectiveCamera, aspect: number): void {
    // Frozen frames (hit-stop, offline pause, dev time scale 0) still run the
    // whole update so every per-frame batch is rebuilt from scratch (nothing
    // can accumulate), but with dt = 0, the world clock held, the last
    // snapshot/interpolation held and sim events deferred until unfreeze.
    let frozen = false
    if (this.hitStop > 0) {
      this.hitStop -= dtReal
      frozen = true
    }
    if (this.opts.mode === 'match' && isOfflinePaused()) frozen = true
    const dt = frozen ? 0 : dtReal
    // per-frame event lists start empty: frozen frames defer events, so the
    // warlocks must not see the previous frame's events again
    this.frameEvents.length = 0
    this.claimedHits.clear()
    this.clock += dt
    const t = this.clock
    this.ctx.uTime.value = t
    // VFX modules init as soon as the world exists (also with no match state
    // yet, e.g. a prewarmed lobby view), so their materials compile early
    if (this.modulesOn) {
      for (const m of spellVfxModules()) {
        if (this.inited.has(m)) continue
        this.inited.add(m)
        this.lastCamera = camera
        this.guard(m, 'init', () => m.init?.(this.vfx))
      }
    }
    this.ctx.glow.begin()
    this.billboards.begin()
    this.billboardsTop.begin()
    this.chevrons.begin()
    this.contact.begin()
    this.visOverrides.clear()
    const src = this.opts.source
    const buf = src.buf
    let curr = buf.curr

    // a state pushed after prewarm began (not a stale one left from an
    // earlier match) means the match started: drop the warm-up warlocks
    if (curr && this.prewarmGroup && curr !== this.prewarmState && (curr.phase === 'shop' || curr.phase === 'fight')) this.endPrewarm()
    if (this.prewarmGroup) {
      this.prewarmGroup.position.set(cameraRig.fx * S, 0, -cameraRig.fy * S)
      // under the lava with the warm-up warlocks: compiles the chevron material
      this.chevrons.add(cameraRig.fx, cameraRig.fy, -300, 0, 1, 1, 1, 1)
    }
    if (curr) {
      // a new match restarts tick numbering: drop everything tied to the old one
      if (curr.tick < this.lastStateTick) this.resetMatch()
      const first = this.lastStateTick < 0
      this.lastStateTick = curr.tick
      const span = buf.currAt - buf.prevAt
      let alpha = !buf.prev || span <= 0 ? 1 : Math.max(0, Math.min(1, (performance.now() - buf.currAt) / span))
      let prev = buf.prev && buf.prev.tick <= curr.tick ? buf.prev : null
      if (frozen && this.held.curr) {
        curr = this.held.curr
        prev = this.held.prev
        alpha = this.held.alpha
      } else {
        this.held.curr = curr
        this.held.prev = prev
        this.held.alpha = alpha
      }

      this.lastCamera = camera
      const fr = this.vfxFrame
      fr.now = t
      fr.dt = dt
      fr.state = curr
      fr.prev = prev
      fr.alpha = alpha
      if (this.modulesOn) {
        // once per rendered frame, even when the clock is frozen: modules reset
        // their per-frame batches here (never key that on ctx.now changing)
        for (const m of spellVfxModules()) this.guard(m, 'beginFrame', () => m.beginFrame?.(this.vfx))
      }
      this.updateArena(curr, t, first, alpha)
      // A keyframe can skip shop entirely. Advance life epochs before events,
      // preserving any authoritative death that belongs to this new round.
      for (const v of this.views.values()) v.beginRound(curr.round)
      if (!frozen) this.consumeEvents(curr, t, first)
      if (this.modulesOn) for (const m of spellVfxModules()) this.guard(m, 'frame', () => m.frame?.(this.vfx))
      this.updatePawns(prev, curr, alpha, t, dt)
      this.obstacles.setTheme(curr.arena.theme)
      this.obstacles.update(curr.obstacles, t, !first)
      // pillars from ./props carry their own contact ring
      this.updateLocalHelpers(curr)
      const cs = curr
      this.projectiles.update(prev ? prev.projectiles : null, cs.projectiles, alpha, t, (owner) => this.colorOf(cs, owner), camera, aspect, this.modulesOn ? claimedProjectile : undefined)
      if (this.modulesOn) this.drawModules(prev, curr, alpha)
      for (const [id, v] of this.views) {
        const o = this.visOverrides.get(id)
        const body = o?.body ?? 1
        v.applyVisibility(body, o?.decal ?? true)
        // facing chevron: fades with casting / death, and with any VFX
        // visibility override (Windwalk must not give a position away)
        if (this.opts.mode === 'match' && o?.decal !== false && !v.dead) {
          const c = v.identityColor
          this.chevrons.add(v.x, v.y, v.floorH, v.visualFacing, c.r, c.g, c.b, v.chevAlpha * Math.min(1, body))
        }
      }
      this.builtinProjectileShadows(prev, curr, alpha)
    }

    this.drainUploads()
    this.updateShadowCadence()
    this.ambient(dt, t)
    this.tickSmoulders(dt, t)
    this.tickLingers(dt, t)
    this.drawFlashes(t)
    this.drawBeams(t, camera)
    this.updateCamera(camera, curr, frozen ? dtReal : dt, aspect, t)
    this.drawCastMarks(curr, camera)
    // key light + its shadow frustum follow the camera focus, snapped to whole
    // shadow-map texels in light space (no shimmering edges while panning)
    {
      // centre of the visible floor (the framing offset moves it off the focus)
      const ahead = this.opts.mode === 'menu' ? 0 : cameraRig.dist * frameOffset(cameraRig.dist)
      const fx = this.opts.mode === 'menu' ? 0 : cameraRig.fx * S
      const fz = this.opts.mode === 'menu' ? 0 : -(cameraRig.fy + ahead) * S
      // cover the view at any zoom (14 fits up to the original max distance)
      const ext = this.opts.mode === 'menu' ? SHADOW_EXT : Math.ceil(SHADOW_EXT * Math.max(1, cameraRig.dist / 1500) * 2) / 2
      if (ext !== this.shadowExt && this.moon.castShadow) {
        this.shadowExt = ext
        const sc = this.moon.shadow.camera as THREE.OrthographicCamera
        sc.left = -ext
        sc.right = ext
        sc.top = ext
        sc.bottom = -ext
        sc.updateProjectionMatrix()
        this.moon.shadow.needsUpdate = true
      }
      const texel = (this.shadowExt * 2) / Math.max(512, this.opts.tier.shadowMap || 512)
      const R = this.lightRight
      const U = this.lightUp
      this.tmpV.set(fx, 0, fz)
      const a = this.tmpV.dot(R)
      const b = this.tmpV.dot(U)
      this.tmpV.addScaledVector(R, Math.round(a / texel) * texel - a).addScaledVector(U, Math.round(b / texel) * texel - b)
      this.moon.target.position.copy(this.tmpV)
      this.moon.position.copy(this.tmpV).addScaledVector(this.moonDir, 30)
    }
    this.updateCursor(camera)
    if (this.overlay) {
      let n = 0
      for (const [id, v] of this.views) {
        if (n >= this.plates.length) break
        const pl = this.plates[n++]
        pl.id = id
        pl.x = v.x
        pl.y = v.y
        pl.h = v.h + 190
        pl.name = v.name
        pl.color = v.color.getHex()
        pl.nameColor = v.nameColor
        pl.hp = v.hp
        pl.maxHp = v.maxHp
        pl.kbPoints = v.kbPoints
        pl.visible = v.alive && !v.dead && this.visOverrides.get(id)?.plate !== false
        pl.local = v.owner === buf.localPlayer
      }
      this.overlay.update(camera, t, this.plates, n, cameraRig.fx, cameraRig.fy)
    }
    postState.hurt = Math.max(0, postState.hurt - dt * 3.2)

    this.ctx.glow.end()
    this.arena.update(t)
    this.particles.commit()
    this.smoke.commit()
    this.ground.commit()
    this.groundShadow.commit()
    this.marker.commit()
    this.markerShadow.commit()
    this.scorches.commit()
    this.debris.commit()
    this.billboards.commit()
    this.billboardsTop.commit()
    this.castMarks.batch.commit()
    if (this.lastCamera) this.chevrons.commit(this.lastCamera)
    this.contact.commit()
  }

  /**
   * A spell VFX module that throws must never freeze the whole match render
   * (a Scourge kill once did). Log once per module and hook, skip the call.
   */
  private readonly vfxErrors = new Set<string>()
  private guard<T>(m: SpellVfx, hook: string, fn: () => T): T | undefined {
    try {
      return fn()
    } catch (err) {
      const key = `${m.spell}:${hook}`
      if (!this.vfxErrors.has(key)) {
        this.vfxErrors.add(key)
        console.error(`[vfx] module '${m.spell}' threw in ${hook}; skipping`, err)
      }
      return undefined
    }
  }

  private builtinErrors = new Set<string>()

  /**
   * Last-resort guard for built-in per-frame work: one bad event / pawn /
   * frame logs once per site and is skipped, so the view never freezes.
   */
  private safe(site: string, fn: () => void): void {
    try {
      fn()
    } catch (err) {
      if (!this.builtinErrors.has(site)) {
        this.builtinErrors.add(site)
        console.error(`[render] ${site} threw; skipping`, err)
      }
    }
  }

  private resetMatch(): void {
    this.held.curr = null
    this.held.prev = null
    for (const v of this.views.values()) {
      this.root.remove(v.root)
      v.dispose()
    }
    this.views.clear()
    this.lastEventTick = -1
    this.lastStateTick = -1
    this.lastLayer = -1
    this.deathFocus = null
    this.victoryShot = null
    if (this.opts.mode === 'match') cameraRig.recenter()
  }

  /** identity colour: TEAM colour in Teams / Shuffle (live), slot colour in FFA */
  private colorOf(s: SimState, owner: number): number {
    return colorForPawn(s, owner)
  }

  private slotOf(s: SimState, owner: number): PlayerSlot | undefined {
    for (const sl of s.slots) if (sl.id === owner) return sl
    return undefined
  }

  // ---------------------------------------------------------------- arena

  private updateArena(curr: SimState, t: number, first: boolean, alpha: number): void {
    this.arena.setTheme(curr.arena.theme)
    this.env.setTheme(curr.arena.theme)
    const L = curr.arena.layer
    if (L !== this.lastLayer) {
      const prevLayer = this.lastLayer
      this.lastLayer = L
      // remember the ring that sinks for the shrink burst
      this.removedRing.length = 0
      if (prevLayer > L) {
        const r0 = layerRadius(prevLayer)
        for (let gx = -10; gx <= 10; gx++) {
          for (let gy = -10; gy <= 10; gy++) {
            const cx = gx * TILE_SIZE
            const cy = gy * TILE_SIZE
            const d2 = cx * cx + cy * cy
            const r1 = layerRadius(L)
            if (d2 < r0 * r0 && d2 >= r1 * r1) this.removedRing.push({ x: cx, y: cy })
          }
        }
        this.shrinkBurst()
      }
      this.arena.setLayer(L, t, !first)
    }
    // telegraph: next ring pulses red during the last second before a shrink
    const next = curr.arena.nextShrinkTick
    let tele = 0
    if (next > 0 && curr.phase === 'fight') {
      const secs = (next - (curr.tick + alpha)) / TICK_HZ
      if (secs > 0 && secs <= 1.05) tele = 0.45 + 0.55 * (1 - Math.min(1, secs))
    }
    this.arena.uTelegraph.value = tele
  }

  private shrinkBurst(): void {
    const ps = this.particles
    for (const p of this.removedRing) {
      const n = ps.budget(5)
      for (let i = 0; i < n; i++) {
        ps.spawn(
          p.x + (Math.random() - 0.5) * 170, p.y + (Math.random() - 0.5) * 170, TILE_TOP_H,
          (Math.random() - 0.5) * 120, (Math.random() - 0.5) * 120, 120 + Math.random() * 260,
          0.6 + Math.random() * 0.8, 12, 3, 3.2, 1.0, 0.2, -260, 0.8, 10,
        )
      }
      if (Math.random() < 0.35 * this.ctx.tier.particles) {
        this.smoke.spawn(p.x, p.y, TILE_TOP_H, 0, 0, 70, 1.4, 60, 170, 0.06, 0.03, 0.025, 20, 0.6, 20)
      }
    }
    if (this.opts.mode === 'match') cameraRig.shake(0.22)
  }

  // ---------------------------------------------------------------- events

  private consumeEvents(curr: SimState, t: number, first: boolean): void {
    if (first || this.lastEventTick < 0) {
      // skip history older than half a second when (re)attaching mid-match
      this.lastEventTick = Math.max(this.lastEventTick, curr.tick - 30)
    }
    const batches = this.opts.source.eventsSince(this.lastEventTick)
    this.frameEvents.length = 0
    for (const b of batches) {
      for (const e of b.events) this.frameEvents.push(e)
      this.currentTickEvents = b.events
      for (const e of b.events) this.safe(`event:${e.type}`, () => this.handleEvent(e, b.events, curr, t))
      this.currentTickEvents = []
      if (b.tick > this.lastEventTick) this.lastEventTick = b.tick
    }
  }

  private viewOfPawn(id: number): PawnView | undefined {
    return this.views.get(id)
  }

  private isLocalPawn(curr: SimState, pawnId: number): boolean {
    const lp = this.opts.source.buf.localPlayer
    if (lp < 0) return false
    for (const p of curr.pawns) if (p.id === pawnId) return p.owner === lp
    return false
  }

  private handleEvent(e: SimEvent, tickEvents: SimEvent[], curr: SimState, t: number): void {
    const fx = this.opts.fx
    const match = this.opts.mode === 'match'
    // spell VFX modules see every event; built-in VFX is skipped when claimed
    let claimed = false
    if (this.modulesOn) {
      for (const m of spellVfxModules()) if (this.guard(m, 'onEvent', () => m.onEvent?.(e, this.vfx)) === true) claimed = true
      const sp = eventSpell(e)
      if (sp !== null && vfxForSpell(sp)) claimed = true
    }
    switch (e.type) {
      case 'projectileHit':
      case 'projectileExpire':
        if (!claimed) this.explodeProjectile(e.x, e.y, e.spell, e.type === 'projectileHit', levelOf(e as { level?: number }))
        if (e.type === 'projectileHit' && e.target !== null) {
          const ob = this.obstacles.get(e.target)
          if (ob) {
            this.windCol.setHex(spellPalette(e.spell).accent)
            this.obstacleChips(e.x, e.y, 40, ob.hp / 400, [this.windCol.r * 1.2, this.windCol.g * 1.2, this.windCol.b * 1.2])
            this.obstacles.hitFrom(e.target, e.x, e.y, 1)
          }
        }
        break
      case 'obstacleDestroyed':
        if (!claimed) this.obstacleBlast(e.x, e.y)
        break
      case 'damage': {
        const v = this.viewOfPawn(e.target)
        // a module that claims the hit draws its own victim flash
        if (!claimed) v?.hit(t, e.amount, e.kb)
        else this.claimedHits.add(e.target)
        // knockback direction: the victim's physics velocity right after the hit,
        // else away from the attacker's pawn
        let dx = 0
        let dy = 0
        for (const p of curr.pawns) {
          if (p.id === e.target) {
            dx = p.vx - p.walkVx
            dy = p.vy - p.walkVy
            break
          }
        }
        if (Math.hypot(dx, dy) < 40 && e.source !== null) {
          for (const p of curr.pawns) {
            if (p.owner === e.source) {
              dx = e.x - p.x
              dy = e.y - p.y
              break
            }
          }
        }
        const dl = Math.hypot(dx, dy)
        if (dl > 1e-3) {
          dx /= dl
          dy /= dl
        }
        if (e.kb > 0) {
          if (!claimed) this.hitImpact(e.x, e.y, e.kb, dx, dy, v)
          v?.impulse(dx, dy, e.kb)
        } else if (!claimed) {
          this.lavaHiss(e.x, e.y, v)
        }
        // lingering after-hit by cause (projectile spell / scourge blast in this tick)
        if (e.kb > 0) {
          const k = Math.min(2, 0.4 + e.amount / 100 + e.kb / 1500)
          let kind: AfterHitKind | null = null
          for (const x of tickEvents) {
            if (x.type === 'projectileHit' && x.target === e.target) kind = x.spell.startsWith('fire') || x.spell === 'meteor' ? 'fire' : null
            else if (x.type === 'beam' && x.target === e.target) kind = 'lightning'
            else if (x.type === 'explosion' && x.spell.startsWith('scourge')) kind = kind ?? 'shadow'
          }
          if (kind) this.afterHit(e.target, kind, k)
          if (e.kb > 900) this.afterHit(e.target, 'dust', Math.min(2, e.kb / 900))
        }
        const burn = e.kb <= 0 && e.source === null
        if (burn) this.afterHit(e.target, 'lava', 1)
        if (e.absorbed && e.absorbed > 0) this.overlay?.number(e.target, e.x, e.y, (v?.h ?? TILE_TOP_H) + 150, e.absorbed, 'absorb', t)
        this.overlay?.number(e.target, e.x, e.y, (v?.h ?? TILE_TOP_H) + 120, e.amount, burn ? 'burn' : 'dmg', t, e.kb)
        // screen-wide feedback only for REAL damage to the local pawn: blocked,
        // reflected or fully absorbed hits (amount 0) never shake, kick, flash
        // the screen or hit-stop
        if (match && e.amount >= 1 && this.isLocalPawn(curr, e.target)) {
          const real = e.amount / (e.amount + (e.absorbed ?? 0))
          cameraRig.shake(Math.min(1, 0.12 + e.kb / 1600) * real)
          if (e.kb > 0) cameraRig.kick(dx, dy, Math.min(900, 250 + e.kb * 0.5) * real)
          postState.hurt = Math.min(1, postState.hurt + (e.kb > 0 ? 0.35 + Math.min(0.5, e.kb / 2000) : 0.12) * real)
          // 2-4 frames of hit-stop on big, mostly unabsorbed hits
          if (e.kb >= 700 && real > 0.5 && fx > 0.05) this.hitStop = Math.min(4, 2 + Math.floor((e.kb - 700) / 500)) / 60
        }
        if (e.kb >= 1300 && t - this.lastCallout > 2.5 && e.source !== null) {
          this.lastCallout = t
          this.overlay?.callout('Smash!', e.x, e.y, (v?.h ?? TILE_TOP_H) + 120, t)
        }
        break
      }
      case 'heal': {
        const v = this.viewOfPawn(e.target)
        v?.healed(t, e.amount)
        this.overlay?.number(e.target, e.x, e.y, (v?.h ?? TILE_TOP_H) + 120, e.amount, 'heal', t)
        const n = claimed ? 0 : this.particles.budget(10)
        for (let i = 0; i < n; i++) {
          this.particles.spawn(e.x + (Math.random() - 0.5) * 50, e.y + (Math.random() - 0.5) * 50, TILE_TOP_H + 20 + Math.random() * 60, 0, 0, 90, 0.7, 10, 2, 0.4, 2.2, 0.5, 40, 1, 8)
        }
        break
      }
      case 'teleport': {
        const pv = this.viewOfPawn(e.pawn)
        let tlv = levelOf(e as { level?: number })
        for (const x of tickEvents) if (x.type === 'cast' && x.pawn === e.pawn) tlv = Math.max(tlv, levelOf(x as { level?: number }))
        if (!claimed) this.teleportFx(e.fromX, e.fromY, e.toX, e.toY, pv, tlv)
        else pv?.materialize(t)
        break
      }
      case 'explosion':
        if (claimed) break
        if (e.spell.startsWith('scourge')) this.scourgeBlast(e.x, e.y, e.radius)
        else this.genericBlast(e.x, e.y, e.radius, spellLook(e.spell).trail)
        if (match) this.shakeNear(e.x, e.y, 0.3)
        break
      case 'castStart': {
        this.viewOfPawn(e.pawn)?.castStart(e.spell, e.ticks)
        break
      }
      case 'cast': {
        const v = this.viewOfPawn(e.pawn)
        v?.castRelease(t)
        if (claimed) break
        if (e.spell.startsWith('scourge') && !tickEvents.some((x) => x.type === 'explosion' && x.spell.startsWith('scourge'))) {
          if (v) this.scourgeBlast(v.x, v.y, 250)
        }
        if (v && !e.spell.startsWith('scourge')) {
          // release: bright flash at the hand + recoil shockwave
          v.castOrigin(this.tmpV)
          this.windCol.setHex(spellPalette(e.spell).accent)
          const c = this.windCol
          const hx = this.tmpV.x / S
          const hy = -this.tmpV.z / S
          const hh = this.tmpV.y / S
          this.flash(hx, hy, hh, 0.16, 180, 110, c.r * 2.5 + 0.8, c.g * 2.5 + 0.8, c.b * 2.5 + 0.8)
          this.handRings.push({ x: hx, y: hy, h: hh, born: t, life: 0.25, r: c.r * 2.2, g: c.g * 2.2, b: c.b * 2.2 })
          const floor = isLocationSafe(v.x, v.y, this.arena.currentLayer) ? TILE_TOP_H + 1.2 : LAVA_H + 2
          this.ground.spawn(RING_EXPAND, v.x, v.y, floor, 24, 120, 0.3, 7, c.r * 1.6, c.g * 1.6, c.b * 1.6)
        }
        break
      }
      case 'death': {
        const v = this.viewOfPawn(e.pawn)
        if (v) {
          // cause-specific deaths (sim: death.cause = spell id | 'lava' | 'obstacle' | ...)
          const ext = e as unknown as { cause?: string; kb?: number; x?: number; y?: number }
          let cause = ext.cause ?? (v.onLava ? 'lava' : 'generic')
          if (cause.startsWith('scourge')) cause = 'scourge'
          if (!claimed) this.deathBurst(v, cause, ext.kb ?? 0)
          v.deathCause(cause)
          if (v.onLava && t - this.lastCallout > 1) {
            this.lastCallout = t
            this.overlay?.callout('Melted', v.x, v.y, v.h + 120, t)
          }
          if (match && cause !== 'disconnect' && v.owner === this.opts.source.buf.localPlayer) {
            cameraRig.shake(0.9)
            this.deathFocus = { x: v.x, y: v.y, at: t }
          }
          if (match && e.killer !== null && e.bountyGold && e.bountyGold > 0) this.bountyCollection(v, e.killer, e.bountyGold, t)
        }
        break
      }
      case 'arenaShrink':
        // tiles are diffed from state; the event only adds a rumble when the
        // diff already happened this frame (removedRing filled in updateArena)
        break
      case 'phase':
        if (e.phase === 'fight' && !claimed) this.roundStart(curr, t)
        break
      case 'roundWin':
      case 'gameOver': {
        const winners = e.type === 'roundWin' ? e.players : e.winners
        if (claimed) break
        const living = [...this.views.entries()].filter(([, v]) => winners.includes(v.owner) && v.alive && !v.dead)
        if (match && e.type === 'roundWin' && living.length === 1 && this.lastCamera) {
          const [pawn, v] = living[0]
          const facing = Math.atan2(-this.lastCamera.position.z / S - v.y, this.lastCamera.position.x / S - v.x) + 0.18
          this.victoryShot = { pawn, round: curr.round, at: t, facing, x: v.x, y: v.y, floorH: v.floorH, releasedAt: null }
        }
        for (const [pawn, v] of living) {
          if (match && this.lastCamera) {
            const facing = this.victoryShot?.facing ?? Math.atan2(-this.lastCamera.position.z / S - v.y, this.lastCamera.position.x / S - v.x)
            if (e.type !== 'gameOver' || this.victoryShot?.pawn !== pawn) v.celebrate(facing, victoryStyle(curr.round, v.owner, this.slotOf(curr, v.owner)?.cosmetics?.victory))
          }
          if (fx <= 0 || this.reducedMotion.matches) continue
          const c = v.identityColor
          this.ground.spawn(RING_EXPAND, v.x, v.y, v.floorH + 2, 38, 205, 1.1, 7, (c.r * 1.5 + 0.6) * fx, (c.g * 1.5 + 0.4) * fx, (c.b * 1.5 + 0.2) * fx)
          this.ground.spawn(RING_IMPLODE, v.x, v.y, v.floorH + 3, 22, 170, 0.65, 5, 2.4 * fx, 1.7 * fx, 0.65 * fx)
          const n = this.particles.budget(Math.round(48 * fx))
          for (let i = 0; i < n; i++) {
            const a = i * 2.39996
            const radius = 45 + (i % 6) * 16
            const ca = Math.cos(a)
            const sa = Math.sin(a)
            this.particles.spawn(v.x + ca * radius, v.y + sa * radius, v.h + 30 + (i % 8) * 19, -sa * 125 - ca * 35, ca * 125 - sa * 35, 210 + Math.random() * 190, 0.8 + Math.random() * 0.65, 8, 2, c.r * 1.8 + 1.2, c.g * 1.8 + 0.8, c.b * 1.8 + 0.35, -150, 0.5, 5)
          }
        }
        break
      }
      case 'castCancel':
        // only a cast point that was visibly running needs to fizzle
        if (e.started) this.viewOfPawn(e.pawn)?.castCancel(t)
        break
      case 'swap':
        if (claimed) break
        this.teleportFx(e.fromX, e.fromY, e.toX, e.toY)
        if (e.other !== null) this.teleportFx(e.toX, e.toY, e.fromX, e.fromY)
        break
      case 'respawn': {
        if (claimed) break
        const floor = isLocationSafe(e.x, e.y, this.arena.currentLayer) ? TILE_TOP_H + 1 : LAVA_H + 2
        this.windCol.setHex(this.colorOf(curr, e.owner))
        const c = this.windCol
        this.ground.spawn(RING_IMPLODE, e.x, e.y, floor, 10, 140, 0.35, 10, c.r * 1.2 + 0.2, c.g * 1.2 + 0.25, c.b * 1.2 + 0.4)
        this.flash(e.x, e.y, 80, 0.22, 180, 110, c.r * 0.8 + 0.2, c.g * 0.8 + 0.25, c.b * 0.8 + 0.45)
        break
      }
      case 'purchase':
        this.purchaseFx(e, t)
        break
      default:
        break
    }
  }

  /** Upgrade bought: character level-up burst in the spell column's hue + a rising ring. */
  private purchaseFx(e: SimEvent & { type: 'purchase' }, t: number): void {
    const v = this.views.get(e.pawn)
    if (!v || !v.alive) return
    // masteries have no spell hue: a neutral arcane gold
    const hue = e.kind === 'mastery' ? 0xffd27a : spellPalette(e.id).accent
    v.levelUp(hue)
    this.windCol.setHex(hue)
    const c = this.windCol
    const floor = v.onLava ? LAVA_H + 2 : TILE_TOP_H + 1.2
    this.ground.spawn(RING_IMPLODE, v.x, v.y, floor, 20, 90, 0.4, 6, c.r * 1.6, c.g * 1.6, c.b * 1.6)
    const n = this.particles.budget(22)
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const rr = 28 + Math.random() * 14
      this.particles.spawn(v.x + Math.cos(a) * rr, v.y + Math.sin(a) * rr, v.h + 10, 0, 0, 260 + Math.random() * 160, 0.6, 8, 2, c.r * 2, c.g * 2, c.b * 2, -200, 1.2, -0.05)
    }
    void t
  }

  private builtinProjectileShadows(prev: SimState | null, curr: SimState, alpha: number): void {
    for (const p of curr.projectiles) {
      if (this.modulesOn && claimedProjectile(p.spell)) continue
      let x = p.x
      let y = p.y
      if (prev) {
        for (const q of prev.projectiles) {
          if (q.id === p.id) {
            x = q.x + (p.x - q.x) * alpha
            y = q.y + (p.y - q.y) * alpha
            break
          }
        }
      }
      this.projectileShadow(x, y, PROJECTILE_H, Math.max(10, p.radius))
    }
  }

  /** Route claimed projectiles and pawn modifiers to their VFX modules. */
  private drawModules(prev: SimState | null, curr: SimState, alpha: number): void {
    for (const p of curr.projectiles) {
      const m = vfxForSpell(p.spell)
      if (!m || !m.drawProjectile) continue
      let x = p.x
      let y = p.y
      if (prev) {
        for (const q of prev.projectiles) {
          if (q.id === p.id) {
            x = q.x + (p.x - q.x) * alpha
            y = q.y + (p.y - q.y) * alpha
            break
          }
        }
      }
      this.guard(m, 'drawProjectile', () => m.drawProjectile?.(p, x, y, this.vfx))
    }
    for (const p of curr.pawns) {
      if (!p.alive || p.modifiers.length === 0) continue
      const v = this.views.get(p.id)
      if (!v) continue
      for (const mod of p.modifiers) {
        const m = vfxForModifier(mod.id)
        if (m && m.drawModifier) this.guard(m, 'drawModifier', () => m.drawModifier?.(p, mod, v.x, v.y, this.vfx))
      }
    }
  }

  /** Cancellation extinguishes the attached charge; it never emits a muzzle burst. */
  private fizzleFx(v: PawnView): void {
    v.setCastRing(0, this.windCol, 0)
    this.ringFades.delete(v)
  }

  private shakeNear(x: number, y: number, amount: number): void {
    const dx = x - cameraRig.fx
    const dy = y - cameraRig.fy
    const d = Math.hypot(dx, dy)
    if (d < 900) cameraRig.shake(amount * (1 - d / 900))
  }

  private bountyCollection(victim: PawnView, killer: number, amount: number, now: number): void {
    let collector: PawnView | undefined
    for (const v of this.views.values()) if (v.owner === killer) { collector = v; break }
    if (!collector) return
    this.overlay?.callout(`+${amount} bounty`, collector.x, collector.y, collector.h + 125, now)
    const fx = this.opts.fx
    if (fx <= 0 || this.reducedMotion.matches) return
    // A fixed handful of gold facets crosses from the defeated holder to the
    // collector. Payout size changes the label, never particle or voice cost.
    const n = this.particles.budget(10)
    for (let i = 0; i < n; i++) {
      const angle = i * 2.39996
      const ox = Math.cos(angle) * 15
      const oy = Math.sin(angle) * 15
      const life = 0.3 + (i % 3) * 0.035
      const h = victim.h + 65 + (i % 3) * 8
      const gravity = -850
      this.particles.spawn(victim.x + ox, victim.y + oy, h,
        (collector.x - victim.x - ox) / life, (collector.y - victim.y - oy) / life,
        (collector.h + 85 - h - gravity * life * life * 0.5) / life,
        life, 8, 2, 2.1 * fx, 1.25 * fx, 0.22 * fx, gravity, 0, -0.025)
    }
    this.ground.spawn(RING_IMPLODE, collector.x, collector.y, collector.floorH + 2, 24, 100, 0.4, 4, 1.2 * fx, 0.72 * fx, 0.15 * fx)
  }

  private flash(x: number, y: number, h: number, life: number, radius: number, size: number, r: number, g: number, b: number): void {
    // per-flash cap: no single flash brighter than ~4 or wider than ~600 units
    const m = Math.max(r, g, b)
    if (m > 4) {
      r *= 4 / m
      g *= 4 / m
      b *= 4 / m
    }
    size = Math.min(size, 600)
    if (this.flashes.length > 24) this.flashes.shift()
    this.flashes.push({ x, y, h, born: this.ctx.uTime.value, life, radius, size, r, g, b })
  }

  private drawFlashes(t: number): void {
    // flash budget: the summed "screen energy" (area x brightness) of all live
    // flashes this frame is capped; when many stack (multi-death, respawn of
    // everyone in one tick) they are scaled down together, never to a whiteout
    let w = 0
    let energy = 0
    for (let i = 0; i < this.flashes.length; i++) {
      const f = this.flashes[i]
      const k = 1 - (t - f.born) / f.life
      if (k <= 0) continue
      this.flashes[w++] = f
      const e = k * k
      const sz = f.size / 300
      energy += sz * sz * Math.max(f.r, f.g, f.b) * e
    }
    this.flashes.length = w
    const scale = energy > FLASH_BUDGET ? FLASH_BUDGET / energy : 1
    for (let i = 0; i < w; i++) {
      const f = this.flashes[i]
      const k = 1 - (t - f.born) / f.life
      const e = k * k * scale
      this.ctx.glow.add(f.x, f.y, f.radius, 0.9 * e, f.r * 0.33, f.g * 0.33, f.b * 0.33)
      this.billboards.add(f.x * S, f.h * S, -f.y * S, f.size * S * (1.4 - k * 0.4), f.r * e, f.g * e, f.b * e, 1.8)
    }
    // afterimages (soft upright silhouettes) and arrival light pillars
    let gw = 0
    for (let i = 0; i < this.ghosts.length; i++) {
      const gh = this.ghosts[i]
      const k = 1 - (t - gh.born) / gh.life
      if (k <= 0) continue
      this.ghosts[gw++] = gh
      const e = gh.pillar ? k : k * k
      const size = (gh.pillar ? 70 : 60) * S
      const stretch = gh.pillar ? 4.5 : 2.3
      this.billboards.addStreak(gh.x * S, gh.h * S, -gh.y * S, size, stretch, Math.PI / 2, gh.r * e, gh.g * e, gh.b * e, gh.pillar ? 1.2 : 1.6, 0)
    }
    this.ghosts.length = gw
    // release recoil rings expanding from the hand
    let hw = 0
    for (let i = 0; i < this.handRings.length; i++) {
      const hr = this.handRings[i]
      const u = (t - hr.born) / hr.life
      if (u >= 1) continue
      this.handRings[hw++] = hr
      const e = 1 - u
      this.billboards.add(hr.x * S, hr.h * S, -hr.y * S, (24 + u * 130) * S, hr.r * e, hr.g * e, hr.b * e, -2.2)
    }
    this.handRings.length = hw
  }

  /** Short bright streaks between two points (teleport link), drawn as view-aligned stretched sprites. */
  private drawBeams(t: number, camera: THREE.PerspectiveCamera): void {
    let w = 0
    for (let i = 0; i < this.beams.length; i++) {
      const b = this.beams[i]
      const k = 1 - (t - b.born) / b.life
      if (k <= 0) continue
      this.beams[w++] = b
      this.bv0.set(b.x0 * S, b.h * S, -b.y0 * S).applyMatrix4(camera.matrixWorldInverse)
      this.bv1.set(b.x1 * S, b.h * S, -b.y1 * S).applyMatrix4(camera.matrixWorldInverse)
      const dx = this.bv1.x - this.bv0.x
      const dy = this.bv1.y - this.bv0.y
      const len = Math.hypot(dx, dy)
      if (len < 1e-4) continue
      const size = 34 * S
      const mx = ((b.x0 + b.x1) / 2) * S
      const mz = (-(b.y0 + b.y1) / 2) * S
      const e = k * k
      this.billboards.addStreak(mx, b.h * S, mz, size, len / size + 1, Math.atan2(dy, dx), b.r * e, b.g * e, b.b * e, 1.4, 0)
      this.billboards.addStreak(mx, b.h * S, mz, size * 0.35, (len / (size * 0.35)) + 1, Math.atan2(dy, dx), 3 * e, 3 * e, 3 * e, 2.5, 0)
    }
    this.beams.length = w
  }

  /** recent impact positions (x, y, time) for the per-location brightness budget */
  private recentImpacts: { x: number; y: number; t: number }[] = []

  /** 1 for a lone impact, shrinking as more land on the same spot within 0.3 s */
  private impactScale(x: number, y: number): number {
    const t = this.ctx.uTime.value
    let n = 0
    let w = 0
    for (let i = 0; i < this.recentImpacts.length; i++) {
      const r = this.recentImpacts[i]
      if (t - r.t > 0.3) continue
      this.recentImpacts[w++] = r
      if ((r.x - x) * (r.x - x) + (r.y - y) * (r.y - y) < 160 * 160) n++
    }
    this.recentImpacts.length = w
    if (w < 16) this.recentImpacts.push({ x, y, t })
    return 1 / (1 + n * 0.8)
  }

  private explodeProjectile(x: number, y: number, spell: string, hit: boolean, level = 1): void {
    const look = spellLook(spell)
    const stack = this.impactScale(x, y)
    const tier = powerTier(level)
    const ps = this.particles
    const h = PROJECTILE_H
    const nFire = ps.budget((hit ? 30 : 20) * stack)
    for (let i = 0; i < nFire; i++) {
      const a = Math.random() * Math.PI * 2
      const el = (Math.random() - 0.3) * 1.2
      const sp = 220 + Math.random() * 520
      ps.spawn(x, y, h, Math.cos(a) * sp, Math.sin(a) * sp, el * sp * 0.6, 0.3 + Math.random() * 0.35, 46 + Math.random() * 30, -12, look.trail[0] * 1.2, look.trail[1] * 1.2, look.trail[2] * 1.2, -200, 5.5, 0)
    }
    const nSpark = ps.budget(hit ? 22 : 12)
    for (let i = 0; i < nSpark; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 500 + Math.random() * 900
      ps.spawn(x, y, h, Math.cos(a) * sp, Math.sin(a) * sp, 150 + Math.random() * 400, 0.35 + Math.random() * 0.45, 8, 2, 5, 3, 1.2, -1500, 2.2, -0.1)
    }
    const nSmoke = this.smoke.budget(7)
    for (let i = 0; i < nSmoke; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 40 + Math.random() * 90
      this.smoke.spawn(x, y, h, Math.cos(a) * sp, Math.sin(a) * sp, 50 + Math.random() * 60, 0.9 + Math.random() * 0.7, 40, 150, 0.05, 0.03, 0.025, 25, 1.2, 10)
    }
    // power tiers: bigger, longer-lived embers (tier 1) and a white-hot inner
    // burst with a second shock ring (tier 2); never larger hitboxes
    if (tier >= 1) {
      const ne = ps.budget((10 + tier * 10) * stack)
      for (let i = 0; i < ne; i++) {
        const a = Math.random() * Math.PI * 2
        const sp = 260 + Math.random() * 420
        ps.spawn(x, y, h, Math.cos(a) * sp, Math.sin(a) * sp, 250 + Math.random() * 350, 0.8 + Math.random() * 0.6, 12 + tier * 3, 4, 3.4, 1.4, 0.3, -1100, 1.4, -0.06)
      }
    }
    if (tier >= 2) {
      const nw = ps.budget(14 * stack)
      for (let i = 0; i < nw; i++) {
        const a = Math.random() * Math.PI * 2
        const sp = 120 + Math.random() * 260
        ps.spawn(x, y, h, Math.cos(a) * sp, Math.sin(a) * sp, Math.random() * 120, 0.22, 34, -6, 3.6, 3.1, 2.2, 0, 6, 0)
      }
    }
    const onTile = isLocationSafe(x, y, this.arena.currentLayer)
    const floor = onTile ? TILE_TOP_H + 1 : LAVA_H + 2
    this.ground.spawn(RING_EXPAND, x, y, floor, 15, 170, 0.42, 16, look.trail[0], look.trail[1], look.trail[2])
    if (tier >= 2) this.ground.spawn(RING_EXPAND, x, y, floor, 30, 210, 0.5, 8, look.edge[0] * 1.6, look.edge[1] * 1.6, look.edge[2] * 1.6)
    if (onTile) this.scorches.spawn(x, y, TILE_TOP_H + 0.6, 60 + tier * 12 + Math.random() * 25)
    this.flash(x, y, h, 0.24, 340, 170, look.light[0] * 1.7 * stack, look.light[1] * 1.7 * stack, look.light[2] * 1.7 * stack)
    if (this.opts.mode === 'match') this.shakeNear(x, y, 0.12)
  }

  /**
   * Hit impact scaled by knockback: directional spark cone along the push,
   * hot flash at the contact, ground shockwave, debris and a smoke puff.
   */
  private hitImpact(x: number, y: number, kb: number, dx: number, dy: number, v: PawnView | undefined): void {
    const ps = this.particles
    // capped: even a 999-damage lab kill (kb ~3000) stays a hit, not a blob
    const k = Math.min(1.5, kb / 1000)
    const h = (v?.h ?? TILE_TOP_H) + 55
    const baseA = Math.atan2(dy, dx)
    const hasDir = dx !== 0 || dy !== 0
    const cone = hasDir ? 0.55 : Math.PI
    const n = ps.budget(10 + k * 34)
    for (let i = 0; i < n; i++) {
      const a = baseA + (Math.random() - 0.5) * 2 * cone
      const sp = Math.min(1500, (420 + Math.random() * 900) * (0.6 + k * 0.5))
      ps.spawn(x, y, h, Math.cos(a) * sp, Math.sin(a) * sp, 60 + Math.random() * 380, 0.22 + Math.random() * 0.3, 6 + k * 3, 1.5, 5, 3.6, 1.8, -1400, 3, -0.11)
    }
    // a few heavy embers that fall and bounce on the floor
    const nd = ps.budget(4 + k * 6)
    for (let i = 0; i < nd; i++) {
      const a = baseA + (Math.random() - 0.5) * 2 * cone * 1.4
      const sp = 150 + Math.random() * 350
      ps.spawn(x, y, h, Math.cos(a) * sp, Math.sin(a) * sp, 250 + Math.random() * 250, 0.6 + Math.random() * 0.5, 9, 4, 3.4, 1.2, 0.3, -1500, 1.2, -0.04)
    }
    // contact flash, pushed slightly along the hit direction
    this.flash(x - dx * 20, y - dy * 20, h, 0.09 + k * 0.04, 160 + k * 60, Math.min(140, 70 + k * 45), 1.8, 1.4, 1.0)
    const floor = v && v.onLava ? LAVA_H + 2 : TILE_TOP_H + 1
    this.ground.spawn(RING_EXPAND, x, y, floor, 18, 70 + k * 70, 0.28 + k * 0.06, 8 + k * 4, 1.6, 0.75, 0.3)
    if (k > 0.6) {
      const ns = this.smoke.budget(3 + k * 2)
      for (let i = 0; i < ns; i++) {
        this.smoke.spawn(x, y, h - 20, -dx * 80 + (Math.random() - 0.5) * 60, -dy * 80 + (Math.random() - 0.5) * 60, 40, 0.8 + Math.random() * 0.4, 30, 100, 0.06, 0.045, 0.04, 20, 1.2, 8)
      }
    }
  }

  /** Stone chips and dust off a damaged pillar. */
  private obstacleChips(x: number, y: number, radius: number, hpFrac: number, tint: readonly [number, number, number] | null): void {
    const n = this.debris.budget(8 + (1 - hpFrac) * 8)
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 150 + Math.random() * 350
      const k = 0.6 + Math.random() * 0.8
      const [dr, dg, db] = this.themeDust()
      this.debris.spawn(x + Math.cos(a) * radius * 0.6, y + Math.sin(a) * radius * 0.6, TILE_TOP_H + 40 + Math.random() * 90, Math.cos(a) * sp, Math.sin(a) * sp, 120 + Math.random() * 300, 0.6 + Math.random() * 0.5, 7 + Math.random() * 7, 5, dr * k, dg * k, db * k, -1700, 0.6, 0)
    }
    const ns = this.smoke.budget(3)
    for (let i = 0; i < ns; i++) {
      this.smoke.spawn(x, y, TILE_TOP_H + 60, (Math.random() - 0.5) * 100, (Math.random() - 0.5) * 100, 30, 0.9, 30, 100, 0.12, 0.1, 0.09, 10, 1, 8)
    }
    if (tint) this.flash(x, y, TILE_TOP_H + 70, 0.12, 160, 90, tint[0], tint[1], tint[2])
  }

  /** Pillar destroyed: blast, a shower of rock chunks, embers and dust. */
  /** per-theme pillar dust (linear rgb): temple sandstone, volcanic ash, overgrown loam */
  private themeDust(): [number, number, number] {
    const th = this.vfxFrame.state?.arena.theme ?? 0
    return th === 1 ? [0.05, 0.045, 0.045] : th === 2 ? [0.07, 0.085, 0.05] : [0.14, 0.12, 0.09]
  }

  /** Pillar destroyed: theme-coloured rock chunks and dust, a few embers, no white flash. */
  private obstacleBlast(x: number, y: number): void {
    const [dr, dg, db] = this.themeDust()
    const nd = this.debris.budget(60)
    for (let i = 0; i < nd; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 120 + Math.random() * 520
      const k = 0.6 + Math.random() * 0.8
      this.debris.spawn(x + (Math.random() - 0.5) * 60, y + (Math.random() - 0.5) * 60, TILE_TOP_H + Math.random() * 180, Math.cos(a) * sp, Math.sin(a) * sp, 200 + Math.random() * 500, 0.8 + Math.random() * 0.7, 10 + Math.random() * 16, 8, dr * k, dg * k, db * k, -1800, 0.4, 0)
    }
    const ne = this.particles.budget(18)
    for (let i = 0; i < ne; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 200 + Math.random() * 500
      this.particles.spawn(x, y, TILE_TOP_H + 80, Math.cos(a) * sp, Math.sin(a) * sp, 100 + Math.random() * 400, 0.5 + Math.random() * 0.4, 7, 2, 2.6, 0.8, 0.15, -1400, 1.5, -0.08)
    }
    const ns = this.smoke.budget(16)
    for (let i = 0; i < ns; i++) {
      const a = Math.random() * Math.PI * 2
      this.smoke.spawn(x, y, TILE_TOP_H + 40, Math.cos(a) * 140, Math.sin(a) * 140, 60 + Math.random() * 60, 1.6 + Math.random(), 70, 220, dr * 1.1, dg * 1.1, db * 1.1, 15, 0.9, 20)
    }
    this.ground.spawn(RING_EXPAND, x, y, TILE_TOP_H + 1, 20, 240, 0.45, 16, 1.2, 0.55, 0.2)
    this.scorches.spawn(x, y, TILE_TOP_H + 0.6, 110, 5)
    this.flash(x, y, TILE_TOP_H + 80, 0.22, 300, 160, 1.4, 0.6, 0.2)
    if (this.opts.mode === 'match') this.shakeNear(x, y, 0.45)
  }

  /** Lava tick: hiss of steam and a few embers off the burning robe. */
  private lavaHiss(x: number, y: number, v: PawnView | undefined): void {
    const h = (v?.h ?? LAVA_H) + 20
    const n = this.particles.budget(6)
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      this.particles.spawn(x, y, h, Math.cos(a) * 120, Math.sin(a) * 120, 200 + Math.random() * 200, 0.4, 7, 2, 3.6, 1.3, 0.25, -900, 1, -0.06)
    }
    this.smoke.spawn(x, y, h + 30, 0, 0, 120, 0.9, 30, 90, 0.09, 0.07, 0.065, 20, 0.6, 10)
  }

  /**
   * Teleport, readable from across the screen in <= 0.6 s:
   * departure implosion + afterimage + rune circle, a <= 0.15 s link streak
   * along the jump, arrival pillar + rune ring + shockwave + falling sparks;
   * the warlock itself re-forms (PawnView.materialize, called by the caller).
   */
  private teleportFx(fx: number, fy: number, tx: number, ty: number, pawn?: PawnView, level = 1): void {
    const [r, g, b] = TELEPORT_COLOR
    const tier = powerTier(level)
    const c = pawn?.color
    const tr = c ? r * 0.7 + c.r * 0.6 : r
    const tg = c ? g * 0.7 + c.g * 0.6 : g
    const tb = c ? b * 0.7 + c.b * 0.6 : b
    const h0 = isLocationSafe(fx, fy, this.arena.currentLayer) ? TILE_TOP_H + 1 : LAVA_H + 2
    const h1 = isLocationSafe(tx, ty, this.arena.currentLayer) ? TILE_TOP_H + 1 : LAVA_H + 2
    const ps = this.particles
    // departure: rune circle + implosion streaks pulled into a point + afterimage
    this.ground.spawn(RING_IMPLODE, fx, fy, h0, 8, 110, 0.3, 9, r, g, b)
    this.ground.spawn(RING_EXPAND, fx, fy, h0, 74, 74, 0.45, 3, r * 0.7, g * 0.7, b * 0.7)
    this.ground.spawn(RING_CHEVRON, fx, fy, h0, 40, 62, 0.4, 4, r * 0.6, g * 0.6, b * 0.6)
    const n = ps.budget(34)
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const rr = 40 + Math.random() * 50
      const hh = h0 + 10 + Math.random() * 120
      const life = 0.22
      ps.spawn(fx + Math.cos(a) * rr, fy + Math.sin(a) * rr, hh, (-Math.cos(a) * rr) / life, (-Math.sin(a) * rr) / life, (h0 + 60 - hh) / life, life, 10, 2, tr, tg, tb, 0, 0, -0.12)
    }
    // afterimage: a tall fading silhouette glow where the warlock stood
    this.flash(fx, fy, h0 + 70, 0.4, 160, 150, tr * 0.8, tg * 0.8, tb * 0.8)
    this.ghosts.push({ x: fx, y: fy, h: h0 + 70, born: this.ctx.uTime.value, life: 0.4, r: tr, g: tg, b: tb })
    // link: a bright streak along the jump so the eye follows it
    this.beams.push({ x0: fx, y0: fy, x1: tx, y1: ty, h: (h0 + h1) / 2 + 70, born: this.ctx.uTime.value, life: 0.15, r: tr * 1.4, g: tg * 1.4, b: tb * 1.4 })
    const steps = Math.min(30, Math.ceil(Math.hypot(tx - fx, ty - fy) / 30))
    for (let i = 0; i < steps; i++) {
      const f = i / steps
      ps.spawn(fx + (tx - fx) * f, fy + (ty - fy) * f, (h0 + h1) / 2 + 60 + (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 60, (Math.random() - 0.5) * 60, 30, 0.25 + Math.random() * 0.15, 9, 2, tr, tg, tb, 0, 2, 0)
    }
    // arrival: light pillar, rune ring, shockwave, sparks raining down, light pulse
    const t = this.ctx.uTime.value
    this.ghosts.push({ x: tx, y: ty, h: h1 + 130, born: t, life: 0.35, r: 2.2, g: 2.6, b: 3.4, pillar: true })
    this.ground.spawn(RING_EXPAND, tx, ty, h1, 10, 190, 0.45, 12, tr, tg, tb)
    this.ground.spawn(RING_EXPAND, tx, ty, h1, 30, 330, 0.55, 5, r * 0.5, g * 0.5, b * 0.5)
    this.ground.spawn(RING_EXPAND, tx, ty, h1, 78, 78, 0.55, 3, r, g, b)
    this.ground.spawn(RING_CHEVRON, tx, ty, h1, 44, 66, 0.5, 4, r * 0.7, g * 0.7, b * 0.7)
    const m = ps.budget(40)
    for (let i = 0; i < m; i++) {
      const a = Math.random() * Math.PI * 2
      const rr = Math.random() * 90
      ps.spawn(tx + Math.cos(a) * rr, ty + Math.sin(a) * rr, h1 + 180 + Math.random() * 120, Math.cos(a) * 40, Math.sin(a) * 40, -120 - Math.random() * 200, 0.45 + Math.random() * 0.15, 8, 2, tr, tg, tb, -900, 0.6, -0.08)
    }
    // re-forming: glowing motes converge into the silhouette
    const q = ps.budget(26)
    for (let i = 0; i < q; i++) {
      const a = Math.random() * Math.PI * 2
      const rr = 70 + Math.random() * 40
      const hh = h1 + Math.random() * 130
      const life = 0.2
      ps.spawn(tx + Math.cos(a) * rr, ty + Math.sin(a) * rr, hh, (-Math.cos(a) * (rr - 15)) / life, (-Math.sin(a) * (rr - 15)) / life, 0, life, 9, 3, 3, 3, 3.4, 0, 0, -0.08)
    }
    // power tiers: an extra outer rune ring and denser spark rain (tier 1), a
    // taller pillar and a second shockwave (tier 2)
    if (tier >= 1) {
      this.ground.spawn(RING_CHEVRON, tx, ty, h1, 96, 118, 0.55, 4, r * 0.8, g * 0.8, b * 0.8)
      const extra = ps.budget(20 * tier)
      for (let i = 0; i < extra; i++) {
        const a = Math.random() * Math.PI * 2
        const rr = Math.random() * 120
        ps.spawn(tx + Math.cos(a) * rr, ty + Math.sin(a) * rr, h1 + 220 + Math.random() * 120, Math.cos(a) * 50, Math.sin(a) * 50, -160 - Math.random() * 200, 0.5, 9, 2, tr * 1.2, tg * 1.2, tb * 1.2, -900, 0.6, -0.08)
      }
    }
    if (tier >= 2) {
      this.ghosts.push({ x: tx, y: ty, h: h1 + 180, born: t, life: 0.45, r: 2.4, g: 2.9, b: 3.6, pillar: true })
      this.ground.spawn(RING_EXPAND, tx, ty, h1, 60, 420, 0.6, 6, r * 0.6, g * 0.6, b * 0.6)
    }
    this.flash(tx, ty, h1 + 60, 0.3, 320, 240, tr, tg, tb)
    pawn?.materialize(t)
    if (this.opts.mode === 'match' && pawn && pawn.owner === this.opts.source.buf.localPlayer) {
      cameraRig.kick(tx - fx, ty - fy, 280)
    }
  }

  private scourgeBlast(x: number, y: number, radius: number): void {
    const [r, g, b] = SCOURGE_COLOR
    const onTile = isLocationSafe(x, y, this.arena.currentLayer)
    const floor = onTile ? TILE_TOP_H + 1 : LAVA_H + 2
    // the blast front sweeps out and stops INSIDE the hit radius; the
    // authoritative edge is the crisp aoeRing at exactly `radius`
    const thick = 14
    this.ground.spawn(RING_EXPAND, x, y, floor, 30, radius - thick, 0.3, thick, r, g, b)
    this.aoeRing(x, y, radius, r * 1.1, g * 1.1, b * 1.1, 0.5)
    if (onTile) this.scorches.spawn(x, y, TILE_TOP_H + 0.6, radius * 0.5, 3.5)
    const ps = this.particles
    const n = ps.budget(48)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.1
      // travel = sp * (1 - e^(-k*life)) / k stays below ~0.85 * radius
      const life = 0.32
      const k = 3.5
      const reach = radius * (0.55 + Math.random() * 0.3)
      const sp = (reach * k) / (1 - Math.exp(-k * life))
      ps.spawn(x, y, floor + 30 + Math.random() * 40, Math.cos(a) * sp, Math.sin(a) * sp, Math.random() * 120, life, 14, 4, r, g, b, -300, k, -0.08)
    }
    // flash light and sprite fully inside the radius
    this.flash(x, y, 80, 0.25, radius * 0.9, radius * 1.1, r, g, b)
    if (this.opts.mode === 'match') this.shakeNear(x, y, 0.25)
  }

  private genericBlast(x: number, y: number, radius: number, c: readonly [number, number, number]): void {
    const floor = isLocationSafe(x, y, this.arena.currentLayer) ? TILE_TOP_H + 1 : LAVA_H + 2
    const thick = 14
    this.ground.spawn(RING_EXPAND, x, y, floor, 20, radius - thick, 0.4, thick, c[0], c[1], c[2])
    this.aoeRing(x, y, radius, c[0], c[1], c[2], 0.45)
    this.flash(x, y, 80, 0.25, radius * 0.9, radius * 1.1, c[0], c[1], c[2])
  }

  /** Death, big and readable, by cause. Leftovers (scorch, smoulder) live <= 3 s. */
  private deathBurst(v: PawnView, cause: string, kb: number): void {
    const ps = this.particles
    const h = v.h + 50
    const c = v.color
    const floor = v.onLava ? LAVA_H + 2 : TILE_TOP_H + 1
    // push direction from the pawn's last knockback velocity
    let dx = v.knockX
    let dy = v.knockY
    const dl = Math.hypot(dx, dy)
    if (dl > 1) {
      dx /= dl
      dy /= dl
    }
    const kk = Math.min(2, Math.max(0.5, kb / 900))
    if (cause === 'lava') {
      // molten splash, smoke plume, a burning ring on the lava
      const n = ps.budget(60)
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2
        const sp = 120 + Math.random() * 260
        ps.spawn(v.x, v.y, LAVA_H + 4, Math.cos(a) * sp, Math.sin(a) * sp, 300 + Math.random() * 500, 0.7 + Math.random() * 0.5, 14, 5, 3.6, 1.2, 0.2, -1500, 0.6, -0.05)
      }
      const ns = this.smoke.budget(20)
      for (let i = 0; i < ns; i++) {
        this.smoke.spawn(v.x + (Math.random() - 0.5) * 60, v.y + (Math.random() - 0.5) * 60, LAVA_H + 30 + i * 8, (Math.random() - 0.5) * 50, (Math.random() - 0.5) * 50, 140 + Math.random() * 120, 2 + Math.random(), 50, 200, 0.05, 0.03, 0.025, 30, 0.4, 20)
      }
      this.ground.spawn(RING_EXPAND, v.x, v.y, LAVA_H + 2, 20, 150, 1.2, 26, 3.2, 1.0, 0.15)
      this.ground.spawn(RING_EXPAND, v.x, v.y, LAVA_H + 2, 60, 280, 0.7, 14, 2.0, 0.6, 0.1)
      this.flash(v.x, v.y, h, 0.5, 420, 320, 3, 1.1, 0.25)
      this.smoulder(v.x, v.y, LAVA_H + 20, 2.2, true)
      return
    }
    if (cause === 'fireball') {
      // blown apart into burning embers along the hit; charred mark that smoulders
      const n = ps.budget(70)
      for (let i = 0; i < n; i++) {
        const a = Math.atan2(dy, dx) + (Math.random() - 0.5) * 1.4
        const sp = (250 + Math.random() * 650) * kk
        ps.spawn(v.x, v.y, h, Math.cos(a) * sp, Math.sin(a) * sp, 100 + Math.random() * 350, 0.6 + Math.random() * 0.7, 22 + Math.random() * 20, -5, 3.4, 1.0, 0.16, -900, 2, 0)
      }
      const nd = this.debris.budget(24)
      for (let i = 0; i < nd; i++) {
        const a = Math.atan2(dy, dx) + (Math.random() - 0.5) * 1.6
        const sp = 150 + Math.random() * 450
        this.debris.spawn(v.x, v.y, h, Math.cos(a) * sp, Math.sin(a) * sp, 200 + Math.random() * 300, 0.8 + Math.random() * 0.6, 7 + Math.random() * 6, 4, 0.03, 0.025, 0.02, -1700, 0.6, 0)
      }
      if (!v.onLava) this.scorches.spawn(v.x, v.y, TILE_TOP_H + 0.6, 90, 3)
      this.flash(v.x, v.y, h, 0.4, 420, 300, 3.2, 1.2, 0.3)
      this.ground.spawn(RING_EXPAND, v.x, v.y, floor, 20, 240, 0.55, 20, 2.6, 0.8, 0.15)
      this.smoulder(v.x, v.y, floor + 10, 2.5, false)
      return
    }
    if (cause === 'scourge') {
      // shadow-burn: the body is eaten by violet-black flame from the inside
      const [r, g, b] = SCOURGE_COLOR
      const n = ps.budget(50)
      for (let i = 0; i < n; i++) {
        ps.spawn(v.x + (Math.random() - 0.5) * 40, v.y + (Math.random() - 0.5) * 40, v.h + Math.random() * 110, (Math.random() - 0.5) * 80, (Math.random() - 0.5) * 80, 160 + Math.random() * 200, 0.8 + Math.random() * 0.6, 16, 3, r, g, b, 60, 1, 14)
      }
      const ns = this.smoke.budget(18)
      for (let i = 0; i < ns; i++) {
        this.smoke.spawn(v.x, v.y, v.h + 40 + Math.random() * 60, (Math.random() - 0.5) * 70, (Math.random() - 0.5) * 70, 80 + Math.random() * 80, 1.6 + Math.random(), 50, 170, 0.015, 0.005, 0.02, 20, 0.6, 16)
      }
      this.ground.spawn(RING_EXPAND, v.x, v.y, floor, 10, 200, 0.6, 18, r, g, b)
      this.flash(v.x, v.y, h, 0.35, 360, 260, r, g, b)
      return
    }
    if (cause === 'obstacle') {
      // thrown into stone: crumbles to dust
      const nd = this.debris.budget(40)
      for (let i = 0; i < nd; i++) {
        const a = Math.random() * Math.PI * 2
        const sp = 100 + Math.random() * 300
        const gr = 0.09 + Math.random() * 0.05
        this.debris.spawn(v.x, v.y, v.h + Math.random() * 100, Math.cos(a) * sp, Math.sin(a) * sp, 150 + Math.random() * 200, 0.7 + Math.random() * 0.5, 6 + Math.random() * 8, 3, gr, gr * 0.95, gr * 0.9, -1600, 0.8, 0)
      }
      const ns = this.smoke.budget(16)
      for (let i = 0; i < ns; i++) {
        this.smoke.spawn(v.x, v.y, v.h + 30, (Math.random() - 0.5) * 140, (Math.random() - 0.5) * 140, 40, 1.4 + Math.random(), 50, 190, 0.14, 0.12, 0.1, 10, 0.9, 18)
      }
      this.flash(v.x, v.y, h, 0.3, 300, 220, 2.2, 1.9, 1.6)
      return
    }
    // generic: crumble into an ash pile that blows away
    const n = ps.budget(40)
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 120 + Math.random() * 380
      ps.spawn(v.x, v.y, h, Math.cos(a) * sp, Math.sin(a) * sp, 120 + Math.random() * 380, 0.5 + Math.random() * 0.7, 26, 6, 3.4, 1.0, 0.18, -350, 2.2, 8)
    }
    const n2 = ps.budget(26)
    for (let i = 0; i < n2; i++) {
      ps.spawn(v.x + (Math.random() - 0.5) * 40, v.y + (Math.random() - 0.5) * 40, h, 0, 0, 200 + Math.random() * 300, 1.2 + Math.random(), 10, 2, c.r * 3, c.g * 3, c.b * 3, 30, 0.8, 30)
    }
    const ns = this.smoke.budget(14)
    for (let i = 0; i < ns; i++) {
      this.smoke.spawn(v.x, v.y, h, 60 + Math.random() * 80, (Math.random() - 0.5) * 60, 50 + Math.random() * 60, 1.8 + Math.random(), 50, 200, 0.12, 0.11, 0.1, 20, 0.6, 20)
    }
    this.ground.spawn(RING_EXPAND, v.x, v.y, floor, 20, 260, 0.6, 22, c.r * 2 + 1, c.g * 2 + 0.4, c.b * 2 + 0.1)
    if (!v.onLava) this.scorches.spawn(v.x, v.y, TILE_TOP_H + 0.6, 80, 3)
    this.flash(v.x, v.y, h, 0.4, 420, 320, 3, 1.3, 0.4)
  }

  /** Short-lived smouldering corpse leftovers (embers + smoke wisps), <= 3 s. */
  private smoulders: { x: number; y: number; h: number; until: number; lava: boolean; acc: number }[] = []

  private smoulder(x: number, y: number, h: number, secs: number, lava: boolean): void {
    if (this.smoulders.length > 12) this.smoulders.shift()
    this.smoulders.push({ x, y, h, until: this.ctx.uTime.value + Math.min(3, secs), lava, acc: 0 })
  }

  private tickSmoulders(dt: number, t: number): void {
    let w = 0
    for (let i = 0; i < this.smoulders.length; i++) {
      const s = this.smoulders[i]
      if (t > s.until) continue
      this.smoulders[w++] = s
      s.acc += dt * (s.lava ? 10 : 6) * this.ctx.tier.particles
      while (s.acc >= 1) {
        s.acc -= 1
        this.smoke.spawn(s.x + (Math.random() - 0.5) * 40, s.y + (Math.random() - 0.5) * 40, s.h, 0, 0, 70 + Math.random() * 60, 1.2, 20, 80, 0.05, 0.035, 0.03, 20, 0.6, 12)
        this.particles.spawn(s.x + (Math.random() - 0.5) * 50, s.y + (Math.random() - 0.5) * 50, s.h, 0, 0, 60 + Math.random() * 90, 0.8, 6, 2, 3.2, 1.0, 0.2, 20, 0.4, 10)
      }
    }
    this.smoulders.length = w
  }

  private roundStart(curr: SimState, t: number): void {
    // FIGHT: a pale arcane white-gold pulse (never lava-coloured), subtle
    // (no flash sprite at the centre: it read as a white ball over the origin)
    const R = layerRadius(curr.arena.layer) + 300
    this.ground.spawn(RING_EXPAND, 0, 0, TILE_TOP_H + 2, 160, R, 1.1, 14, 0.42, 0.4, 0.55)
    this.ground.spawn(RING_EXPAND, 0, 0, TILE_TOP_H + 2, 260, R * 0.6, 0.8, 7, 0.5, 0.44, 0.3)
    this.arena.shock(0, 0, t, 0.5)
    this.ctx.glow.add(0, 0, 500, 0.25, 0.4, 0.38, 0.5)
    if (this.opts.mode === 'match') cameraRig.shake(0.3)
  }

  // ---------------------------------------------------------------- pawns

  private warlockVersion = warlockParams.version
  private warlockAsset = warlockReady()
  /** sim events consumed this frame (all pawns), for the warlock animators */
  private frameEvents: SimEvent[] = []
  /** pawn ids whose damage this frame was claimed by a VFX module */
  private claimedHits = new Set<number>()

  private updatePawns(prev: SimState | null, curr: SimState, alpha: number, t: number, dt: number): void {
    const ready = warlockReady()
    if (this.warlockVersion !== warlockParams.version || ready !== this.warlockAsset) {
      // style/staff switched, or the CC0 asset finished loading: rebuild every warlock
      this.warlockVersion = warlockParams.version
      this.warlockAsset = ready
      for (const v of this.views.values()) {
        this.root.remove(v.root)
        v.dispose()
      }
      this.views.clear()
    }
    const seen = this.ctx.uTime.value
    const layer = this.arena.currentLayer
    for (const p of curr.pawns) {
      let v = this.views.get(p.id)
      if (!v) {
        v = new PawnView(this.ctx)
        v.setSlot(this.slotOf(curr, p.owner), p.owner)
        v.onFizzle = (pv) => this.fizzleFx(pv)
        v.spellClaimed = (spell) => this.modulesOn && !!vfxForSpell(spell)
        v.hideArrow = (spell) => {
          if (!this.modulesOn) return false
          const st = vfxForSpell(spell)?.windupStyle?.(spell)
          return !!st?.hide?.includes('arrow')
        }
        v.setShadows(this.opts.tier.shadowMap > 0)
        this.views.set(p.id, v)
        this.root.add(v.root)
      }
      let pp: PawnState | undefined
      if (prev) {
        for (const q of prev.pawns) {
          if (q.id === p.id) {
            pp = q
            break
          }
        }
      }
      // team identity (Shuffle re-teams every round): ring, trims, plate fill
      v.name = this.slotOf(curr, p.owner)?.name ?? ''
      v.setIdentity(colorForPawn(curr, p.owner), slotColorOf(curr, p.owner))
      v.setCosmetics(this.slotOf(curr, p.owner)?.cosmetics)
      v.combat = curr.phase === 'fight'
      samplePawn(pp, p, alpha, this.sample)
      // shop-phase ward (combat off): full until the 3-2-1, easing down through it
      if (curr.phase === 'shop' || curr.phase === 'warmup') {
        const left = curr.phaseTicksLeft
        v.wardTarget = left < 0 || left > 180 ? 1 : 0.35 + 0.65 * (left / 180)
      } else v.wardTarget = 0
      const view = v
      view.beginRound(curr.round)
      this.safe('pawn:update', () => view.update(p, this.sample, layer, t, dt, this.frameEvents))
      let pawnEvents: readonly SimEvent[] = this.frameEvents
      if (view.justSnapped) {
        // round-start reposition / respawn: no lingering trails or dust from the
        // old spot, the character's cloth settles at once (its blink path), and
        // the camera snaps for the local warlock instead of gliding across
        this.lingers.delete(p.id)
        pawnEvents = this.frameEvents.concat({ type: 'teleport', pawn: p.id, fromX: p.x, fromY: p.y, toX: p.x, toY: p.y })
        if (this.opts.mode === 'match' && p.owner === this.opts.source.buf.localPlayer) cameraRig.recenter()
      }
      if (v.usesWarlock) {
        // cast glow colour = the spell's hue (sleeve runes, palm, crystal)
        let castHex: number | null = null
        if (p.cast) {
          castHex = spellPalette(p.cast.spell).accent
        }
        // driveWarlock catches character errors itself and falls back to the
        // built-in body after repeated failures
        const pawnIn = !view.combat && p.lavaTicks > 0 ? { ...p, lavaTicks: 0 } : p
        view.detail = this.detailFor(p.x, p.y)
        view.driveWarlock(pawnIn, view.justSnapped ? undefined : pp, alpha, dt, pawnEvents, castHex, this.claimedHits.has(p.id))
      }
      v.seen = seen
      v.kbPoints = p.kbPoints
      this.safe('pawn:ambient', () => this.pawnAmbient(view, p, dt))
    }
    for (const [id, v] of this.views) {
      if (v.seen === seen) continue
      // gone from state: let the dissolve finish, then drop the view
      if (!v.dead) v.forceDeath(t)
      v.tick(t)
      if (v.deathDone) {
        this.root.remove(v.root)
        v.dispose()
        this.views.delete(id)
      }
    }
  }

  /**
   * Character detail for a warlock at game (x, y), from last frame's camera:
   * 2 when its bounds (with room for cloth and the shadow it casts) are
   * outside the view frustum, 1 when it is small on screen (zoomed out),
   * else 0. The character runs secondary motion at half rate on 1 and a
   * ~15 Hz skeleton without cloth on 2.
   */
  private detailFor(x: number, y: number): 0 | 1 | 2 {
    const cam = this.lastCamera
    if (!cam || this.opts.mode !== 'match') return 0
    if (this.detailFrame !== this.clock) {
      // once per frame; the camera's matrices are last frame's (bounds have margin)
      this.detailFrame = this.clock
      this.detailMat.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
      this.frustum.setFromProjectionMatrix(this.detailMat)
    }
    this.detailSphere.center.set(x * S, (TILE_TOP_H + DETAIL_CENTER_H) * S, -y * S)
    this.detailSphere.radius = DETAIL_RADIUS * S
    if (!this.frustum.intersectsSphere(this.detailSphere)) return 2
    // on-screen height as a fraction of the viewport height
    const dist = cam.position.distanceTo(this.detailSphere.center)
    const frac = (WARLOCK_HEIGHT * S) / Math.max(1e-3, dist) / (2 * Math.tan((cam.fov * Math.PI) / 360))
    return frac < DETAIL_FAR_FRAC ? 1 : 0
  }
  private frustum = new THREE.Frustum()
  private detailMat = new THREE.Matrix4()
  private detailSphere = new THREE.Sphere()
  private detailFrame = -1

  private lastMoveTarget = { x: NaN, y: NaN }
  private lastUiMarker = -10
  private lastMoveSeq = inputViz.move.seq

  /** Move markers and targeting preview for the local player. */
  private updateLocalHelpers(curr: SimState): void {
    if (this.opts.mode !== 'match') return
    const buf = this.opts.source.buf
    const t = this.ctx.uTime.value
    // move orders straight from the input layer (zero latency)
    const mv = inputViz.move
    if (mv.seq !== this.lastMoveSeq) {
      this.lastMoveSeq = mv.seq
      if (mv.at > 0 && performance.now() - mv.at < 500) {
        this.moveMarker(mv.x, mv.y)
        this.lastUiMarker = t
        this.lastMoveTarget.x = mv.x
        this.lastMoveTarget.y = mv.y
        this.noteClick(mv.x, mv.y, t, curr)
      }
    }
    // UI-requested markers (showMoveMarker)
    while (moveMarkers.length > 0) {
      const m = moveMarkers.shift()!
      this.moveMarker(m.x, m.y)
      this.lastUiMarker = t
      this.lastMoveTarget.x = m.x
      this.lastMoveTarget.y = m.y
      this.noteClick(m.x, m.y, t, curr)
    }
    let local: PawnState | undefined
    for (const p of curr.pawns) if (p.owner === buf.localPlayer) local = p
    this.updateDestination(local, t)
    if (local && local.alive && local.moveTarget && inputViz.move.seq === 0) {
      const mt = local.moveTarget
      const moved = Math.hypot(mt.x - this.lastMoveTarget.x, mt.y - this.lastMoveTarget.y)
      if (!(moved < 1)) {
        // state-derived marker unless the UI just drew one near it
        if (!(t - this.lastUiMarker < 0.6 && moved < 80)) this.moveMarker(mt.x, mt.y)
        this.lastMoveTarget.x = mt.x
        this.lastMoveTarget.y = mt.y
      }
    }
    // targeting preview from the input layer: range ring + aim line
    const aim = inputViz.aim
    for (const v of this.views.values()) {
      const ap = v.aimPreview
      const mine = v.owner === buf.localPlayer
      ap.active = !!(mine && aim && aim.range > 0 && buf.cursor.valid)
      if (ap.active && aim) {
        ap.range = aim.range
        ap.radius = 0
        ap.tx = buf.cursor.x
        ap.ty = buf.cursor.y
      }
    }
  }

  /** last move order from the input layer, until the sim's move target catches up */
  private click: DestClick | null = null
  private destShow = { x: 0, y: 0, alpha: 0, since: -10, queued: false }

  private noteClick(x: number, y: number, t: number, curr: SimState): void {
    const buf = this.opts.source.buf
    let local: PawnState | undefined
    for (const p of curr.pawns) if (p.owner === buf.localPlayer) local = p
    // "Move cancels cast" off: a move issued during a windup is held by the
    // input layer and sent when the windup ends (game/input.ts)
    const holds = useGame.getState().settings.moveCancelsCast === false
    this.click = { x, y, at: t, queued: holds && !!local?.cast }
    // the old destination goes at once; the new one fades in after the burst
    this.destShow.alpha = 0
    this.destShow.since = t
  }

  /**
   * Persistent destination: the sim's move target for the local pawn (so it
   * follows prediction / rollback and stays through knockback), bridged by
   * the last click until the order lands. Clears on arrival, stop, a cast,
   * death and round end (the sim drops the target in all of those).
   */
  private updateDestination(local: PawnState | undefined, t: number): void {
    const d = this.destShow
    const r = resolveDestination(local, this.click, t)
    this.click = r.click
    const { show, x, y, queued } = r
    if (show) {
      // a moved target that did not come from a click (rollback, scripted): no fade
      if (d.alpha > 0 && Math.hypot(x - d.x, y - d.y) > 2 && t - d.since > 0.6) d.since = t - 0.6
      d.x = x
      d.y = y
      d.queued = queued
      // after the click burst (~0.4 s): fade in, then stay
      d.alpha = Math.max(0, Math.min(1, (t - d.since - 0.3) / 0.25))
    } else d.alpha = Math.max(0, d.alpha - 1 / 8)
    const v = local ? this.views.get(local.id) : undefined
    if (d.alpha <= 0 || !v) {
      this.dest.set(0, 0, 0, 0, this.white, false)
      return
    }
    const floor = isLocationSafe(d.x, d.y, this.arena.currentLayer) ? TILE_TOP_H : LAVA_H
    this.dest.set(d.x, d.y, floor, d.alpha * DEST_ALPHA, v.identityColor, d.queued)
  }
  private white = new THREE.Color(1, 1, 1)

  /**
   * Dota-style move marker, local player only: one quick chevron burst that
   * converges and fades (~0.4 s), lifted with a soft shadow. Single slot: a
   * new order kills the previous marker instantly.
   */
  private moveMarker(x: number, y: number): void {
    const floor = isLocationSafe(x, y, this.arena.currentLayer) ? TILE_TOP_H : LAVA_H
    const lift = 12
    const ox = (-this.moonDir.x / this.moonDir.y) * lift
    const oy = (this.moonDir.z / this.moonDir.y) * lift
    this.marker.spawn(RING_CHEVRON, x, y, floor + lift, 10, 44, 0.4, 4, 0.3, 1.4, 0.4)
    this.markerShadow.spawn(RING_CHEVRON, x + ox, y + oy, floor + 0.7, 10, 44, 0.4, 7, 0, 0, 0)
  }

  private pawnAmbient(v: PawnView, p: PawnState, dt: number): void {
    const ps = this.particles
    const amb = this.visOverrides.get(p.id)?.ambient !== false
    if (v.onLava && p.alive && amb && v.combat) {
      // burning: flames licking up the robe and dark smoke
      const n = ps.budget(dt * 70)
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2
        const rr = 18 + Math.random() * 18
        ps.spawn(v.x + Math.cos(a) * rr, v.y + Math.sin(a) * rr, v.h + 10 + Math.random() * 40, Math.cos(a) * 30, Math.sin(a) * 30, 160 + Math.random() * 160, 0.3 + Math.random() * 0.25, 30, 6, 3.2, 1.0, 0.18, 120, 1.5, 6)
      }
      if (Math.random() < dt * 6 * this.ctx.tier.particles) {
        this.smoke.spawn(v.x, v.y, v.h + 80, 0, 0, 90, 1.1, 30, 110, 0.04, 0.025, 0.02, 30, 0.8, 14)
      }
    }
    if (v.dead && !v.deathDone && amb && !v.customDeath && v.deathCauseId !== 'disconnect') {
      const n = ps.budget(dt * 90)
      for (let i = 0; i < n; i++) {
        ps.spawn(v.x + (Math.random() - 0.5) * 50, v.y + (Math.random() - 0.5) * 50, v.h + Math.random() * 100, 0, 0, 120 + Math.random() * 160, 0.8 + Math.random() * 0.6, 9, 2, 3.4, 1.1, 0.25, 40, 1, 18)
      }
    }
    if (p.cast && p.cast.started !== false && p.alive) {
      this.drawWindup(v, p)
    } else {
      v.setCastRing(0, this.windCol, Math.max(0, this.castRingFade(v) - dt * 6))
    }
  }

  /** Draw after pose + camera updates, so marks cannot lag a moving hand or camera. */
  private drawCastMarks(state: SimState | null, camera: THREE.PerspectiveCamera): void {
    this.castMarks.begin(camera)
    if (!state) return
    for (const p of state.pawns) {
      const v = this.views.get(p.id)
      if (!v || !p.alive) continue
      if (p.cast && p.cast.started !== false) {
        if (!hasHandMark(p.cast.spell)) continue
        v.castOrigin(this.wO)
        this.castMarks.charge(p.cast.spell, this.wO, Math.min(1, v.castFraction))
      } else if (!p.cast && v.castCancelFraction >= 0 && !windupHiddenFrom(v.canceledCastSpell, p.owner, this.opts.source.buf.localPlayer)) {
        v.castOrigin(this.wO)
        this.castMarks.cancel(this.wO, v.castCancelFraction)
      }
    }
  }

  private windCol = new THREE.Color()
  private windHot = new THREE.Color()
  private ringFades = new Map<PawnView, number>()
  private wO = new THREE.Vector3()
  private armA: CastArm = { shoulder: new THREE.Vector3(), elbow: new THREE.Vector3(), wrist: new THREE.Vector3(), palm: new THREE.Vector3(), dir: new THREE.Vector3() }
  private armB: CastArm = { shoulder: new THREE.Vector3(), elbow: new THREE.Vector3(), wrist: new THREE.Vector3(), palm: new THREE.Vector3(), dir: new THREE.Vector3() }

  /** Fallback arm chain from the cast origin and facing (procedural body). */
  private approxArm(v: PawnView, p: PawnState, out: CastArm): void {
    const fx = Math.cos(p.facing)
    const fy = Math.sin(p.facing)
    const ox = this.wO.x / S
    const oy = -this.wO.z / S
    const rx = fy
    const ry = -fx
    const side = (ox - v.x) * rx + (oy - v.y) * ry >= 0 ? 1 : -1
    const sx = v.x + rx * side * 17 + fx * 4
    const sy = v.y + ry * side * 17 + fy * 4
    out.shoulder.set(sx * S, (v.h + 118) * S, -sy * S)
    out.palm.copy(this.wO)
    out.elbow.copy(out.shoulder).lerp(out.palm, 0.5)
    out.elbow.y -= 10 * S
    out.wrist.copy(out.elbow).lerp(out.palm, 0.8)
    out.dir.copy(out.palm).sub(out.wrist).normalize()
  }

  private castRingFade(v: PawnView): number {
    const a = this.ringFades.get(v) ?? 0
    const n = Math.max(0, a - 0.1)
    if (n === 0) this.ringFades.delete(v)
    else this.ringFades.set(v, n)
    return n
  }

  /**
   * Shared hand-cast windup (readable across the screen at any facing):
   * rune rings travel shoulder -> hand, tightening and brightening with the
   * charge; an attached energy spiral wraps the forearm; a compact palm glow
   * brightens without forming a projectile; a ground ring fills under the
   * caster. Colour = spell palette accent; modules flavour it via windupStyle.
   */
  private drawWindup(v: PawnView, p: PawnState): void {
    const spell = p.cast!.spell
    const marked = hasHandMark(spell)
    const mod = this.modulesOn ? vfxForSpell(spell) : undefined
    const style = mod?.windupStyle?.(spell, p) ?? null
    const hide = style?.hide ?? []
    const pal = spellPalette(spell)
    this.windCol.setHex(style?.color ?? pal.accent)
    this.windHot.setHex(pal.core)
    const c = this.windCol
    const h = this.windHot
    const k = Math.min(1, v.castFraction)
    const gather = k * k
    const motion = !this.reducedMotion.matches
    const fx = this.ctx.uFx.value
    const t = this.ctx.uTime.value
    // geometry: the character's real arm bones (castArm), else an approximation
    // from the cast origin and facing; two-handed casts draw both arms
    v.castOrigin(this.wO)
    const nArms = v.castArms(this.armA, this.armB)
    if (nArms === 0) this.approxArm(v, p, this.armA)
    const arms = nArms === 2 ? 2 : 1
    const B = this.billboardsTop
    // A steady gathering cue replaces the old six-Hz flicker. Most energy arrives
    // late in the windup; the spell palette keeps the hand readable through bloom.
    const flick = 1 + (motion ? Math.sin(t * 7) * 0.04 * fx : 0)
    for (let ai = 0; ai < arms; ai++) {
      const arm = ai === 0 ? this.armA : this.armB
      // arm chain in game units (x, y ground, h height)
      const sx = arm.shoulder.x / S
      const sy = -arm.shoulder.z / S
      const sh = arm.shoulder.y / S
      const ox = arm.palm.x / S
      const oy = -arm.palm.z / S
      const oh = arm.palm.y / S
      const ex = arm.elbow.x / S
      const ey = -arm.elbow.z / S
      const eh = arm.elbow.y / S
      const rx = -(oy - ey)
      const ry = ox - ex
      const rl = Math.hypot(rx, ry) || 1
      if (!marked && !mod && !hide.includes('rings')) {
        const n = style?.ringCount ?? 3
        for (let i = 0; i < n; i++) {
          const ph = ((motion ? t * 0.75 : 0) + i / n + k * 0.22) % 1
          // shoulder -> elbow -> palm
          const seg = ph < 0.5 ? ph * 2 : (ph - 0.5) * 2
          const ax = ph < 0.5 ? sx : ex
          const ay = ph < 0.5 ? sy : ey
          const ah = ph < 0.5 ? sh : eh
          const bx = ph < 0.5 ? ex : ox
          const by = ph < 0.5 ? ey : oy
          const bh = ph < 0.5 ? eh : oh
          const px = ax + (bx - ax) * seg
          const py = ay + (by - ay) * seg
          const ph2 = ah + (bh - ah) * seg
          const size = (70 - 34 * ph) * (1.05 - 0.22 * k)
          const br = (0.7 + 2.1 * gather) * (0.7 + 0.3 * ph) * flick
          B.add(px * S, ph2 * S, -py * S, size * S, (c.r + h.r * 0.12) * br, (c.g + h.g * 0.12) * br, (c.b + h.b * 0.12) * br, -2.6)
        }
      }
      if (!marked && !mod && motion && !hide.includes('spiral')) {
        const ns = Math.ceil(4 * fx)
        for (let i = 0; i < ns; i++) {
          const u = (i + 0.5) / ns
          const th = t * 10 + u * 14
          const cx = ex + (ox - ex) * u
          const cy = ey + (oy - ey) * u
          const ch = eh + (oh - eh) * u
          const r = (13 - u * 8) * (1 - gather * 0.3)
          const px = cx + Math.cos(th) * r * (rx / rl)
          const py = cy + Math.cos(th) * r * (ry / rl)
          const pz = ch + Math.sin(th) * r
          B.add(px * S, pz * S, -py * S, 7 * S, c.r * 2.4, c.g * 2.4, c.b * 2.4, 1.4)
        }
      }
    }
    // A soft hand glow must never resemble an airborne projectile. It is
    // rebuilt at the current hand position and disappears with the windup.
    if (!marked && !mod && !hide.includes('orb')) {
      const os = style?.orbScale ?? 1
      B.add(this.wO.x, this.wO.y, this.wO.z, (24 + k * 20) * os * S, c.r * (0.85 + gather * 2.1) * flick, c.g * (0.85 + gather * 2.1) * flick, c.b * (0.85 + gather * 2.1) * flick, 1.4)
    }
    if (!hide.includes('ground')) {
      v.setCastRing(k, c, 0.8 + gather * 0.2)
      this.ringFades.set(v, 1)
    }
    if (!hide.includes('light')) this.ctx.glow.add(v.x, v.y, 150 + k * 110, 0.25 + k * 0.6, c.r * 0.6, c.g * 0.6, c.b * 0.6)
  }

  // ---------------------------------------------------------------- ambient

  private ambient(dt: number, t: number): void {
    const ps = this.particles
    const cx = cameraRig.fx
    const cy = cameraRig.fy
    const layer = this.arena.currentLayer
    // embers rising from the lava around the view
    this.emberAcc += dt * 55 * this.ctx.tier.particles
    let guard = 0
    while (this.emberAcc >= 1 && guard++ < 40) {
      this.emberAcc -= 1
      const a = Math.random() * Math.PI * 2
      const rr = Math.sqrt(Math.random()) * 1700
      const x = cx + Math.cos(a) * rr
      const y = cy + Math.sin(a) * rr
      if (isLocationSafe(x, y, layer)) continue
      const hot = 0.6 + Math.random() * 0.8
      ps.spawn(x, y, 4, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, 50 + Math.random() * 110, 2.4 + Math.random() * 2.4, 5 + Math.random() * 6, 1.5, 3.2 * hot, 1.0 * hot, 0.22 * hot, 18, 0.25, 26)
    }
    // lava bubbles popping near the shore
    this.bubbleAcc += dt * 2.2
    while (this.bubbleAcc >= 1) {
      this.bubbleAcc -= 1
      const a = Math.random() * Math.PI * 2
      const R = layerRadius(layer) + 60 + Math.random() * 500
      const x = Math.cos(a) * R
      const y = Math.sin(a) * R
      if (isLocationSafe(x, y, layer)) continue
      const n = ps.budget(9)
      for (let i = 0; i < n; i++) {
        const b = Math.random() * Math.PI * 2
        const sp = 60 + Math.random() * 120
        ps.spawn(x, y, 2, Math.cos(b) * sp, Math.sin(b) * sp, 250 + Math.random() * 250, 0.6 + Math.random() * 0.4, 8, 3, 3.6, 1.4, 0.3, -900, 0.5, -0.05)
      }
      this.ground.spawn(RING_EXPAND, x, y, 2, 4, 55, 0.5, 6, 2.0, 0.7, 0.12)
    }
    void t
  }

  // ---------------------------------------------------------------- camera

  private updateCamera(camera: THREE.PerspectiveCamera, curr: SimState | null, dt: number, aspect: number, t: number): void {
    if (this.opts.externalCamera) return
    if (this.opts.mode === 'menu') {
      this.orbit += dt * 0.05
      const R = 1900
      const a = this.orbit
      camera.position.set(Math.cos(a) * R * S, 820 * S, Math.sin(a) * R * S)
      camera.lookAt(0, 0, 0)
      if (camera.fov !== 50) {
        camera.fov = 50
        camera.updateProjectionMatrix()
      }
      return
    }
    let fx = 0
    let fy = 0
    const lp = this.opts.source.buf.localPlayer
    let local: PawnView | undefined
    if (curr && lp >= 0) {
      for (const v of this.views.values()) if (v.owner === lp) local = v
    }
    if (cameraRig.recenterSeq !== this.reachSeq) {
      // Space: back on the warlock at once, no pan left over
      this.reachSeq = cameraRig.recenterSeq
      this.reach.reset()
    }
    if (local && local.alive && !local.dead) {
      this.deathFocus = null
      const arenaR = curr ? layerRadius(curr.arena.layer) : 1500
      const o = this.reach.step({
        dt,
        pointer: this.pointer,
        peek: (inputViz as { peek?: boolean }).peek === true,
        aiming: !!inputViz.aim,
        cursor: this.opts.source.buf.cursor,
        pawn: local,
        arenaR,
        reach: reachFor(renderPrefs.cameraReach, arenaR),
        edgeSpeed: EDGE_SPEED * renderPrefs.edgePanSpeed,
        edgePan: renderPrefs.edgePan,
      })
      fx = local.x + o.x
      fy = local.y + o.y
    } else if (this.deathFocus && t - this.deathFocus.at < 1.6) {
      fx = this.deathFocus.x
      fy = this.deathFocus.y
    } else {
      // spectate: the player the UI picked (spectateTarget), else keep the current target
      // if alive, else the first living pawn
      let target: PawnView | undefined
      if (spectateTarget.owner >= 0) {
        for (const [id, v] of this.views) {
          if (v.owner === spectateTarget.owner && v.alive && !v.dead) {
            target = v
            this.spectateId = id
          }
        }
      }
      if (!target) target = this.views.get(this.spectateId)
      if (!target || !target.alive || target.dead) {
        target = undefined
        for (const [id, v] of this.views) {
          if (v.alive && !v.dead) {
            target = v
            this.spectateId = id
            break
          }
        }
      }
      // spectators (no warlock of their own) follow too
      if (target) {
        fx = target.x
        fy = target.y
      }
    }
    if (devCamera.focus) {
      fx = devCamera.focus.x
      fy = devCamera.focus.y
    }
    // A forward replay seek can skip the phase that would release the old shot.
    if (this.victoryShot && curr && curr.round !== this.victoryShot.round && (curr.phase === 'roundEnd' || curr.phase === 'gameOver')) this.victoryShot = null
    const shot = this.victoryShot
    if (shot && curr) {
      const celebrating = curr.phase === 'roundEnd' || curr.phase === 'gameOver'
      if (!celebrating && shot.releasedAt === null) shot.releasedAt = t
      const winner = this.views.get(shot.pawn)
      if (celebrating && shot.releasedAt === null && winner) {
        shot.x = winner.x
        shot.y = winner.y
        shot.floorH = winner.floorH
      }
    }
    // screen shake and kick scale with the screen-shake setting only (not fx intensity)
    cameraRig.update(camera, fx, fy, dt, aspect, renderPrefs.shake)
    if (shot && curr && !devCamera.focus && !this.reducedMotion.matches) {
      const weight = victoryCameraWeight(t - shot.at, shot.releasedAt === null ? null : t - shot.releasedAt)
      const offset = victoryCameraOffset(shot.facing, aspect)
      this.tmpV.set((shot.x + offset.x) * S, (shot.floorH + 90 + offset.height) * S, -(shot.y + offset.y) * S)
      camera.position.lerp(this.tmpV, weight)
      this.victoryAim.position.copy(camera.position)
      this.victoryAim.lookAt(shot.x * S, (shot.floorH + 100) * S, -shot.y * S)
      camera.quaternion.slerp(this.victoryAim.quaternion, weight)
      camera.fov += (offset.fov - camera.fov) * weight
      camera.updateProjectionMatrix()
      if (weight === 0 && shot.releasedAt !== null) this.victoryShot = null
    }
    // matrices now, not at render: the cursor pick and the locator below use them
    camera.updateMatrixWorld()
    if (this.locator) {
      const show = !!(local && local.alive && !local.dead)
      this.locator.update(camera, local?.x ?? 0, local?.y ?? 0, (local?.floorH ?? 0) + 90, local ? `#${local.identityColor.getHexString()}` : '#fff', show)
    }
    // haze range follows the zoom
    this.uFogNear.value = Math.max(24, (cameraRig.dist + 1300) * S)
    this.uFogFar.value = this.uFogNear.value + 71
  }

  private updateCursor(camera: THREE.PerspectiveCamera): void {
    if (!this.opts.source.writesCursor) return
    const cur = this.opts.source.buf.cursor
    if (!this.pointer.inside) {
      cur.valid = false
      return
    }
    this.ndc.set(this.pointer.x, this.pointer.y)
    this.raycaster.setFromCamera(this.ndc, camera)
    const p = this.raycaster.ray.intersectPlane(this.plane, this.hit)
    if (!p) {
      cur.valid = false
      return
    }
    cur.x = p.x / S
    cur.y = -p.z / S
    cur.valid = true
  }

  dispose(): void {
    this.endPrewarm()
    for (const m of this.inited) m.dispose?.()
    this.inited.clear()
    for (const v of this.views.values()) v.dispose()
    this.views.clear()
    this.lava.dispose()
    this.env.dispose()
    this.arena.dispose()
    this.particles.dispose()
    this.smoke.dispose()
    this.ground.dispose()
    this.groundShadow.dispose()
    this.marker.dispose()
    this.markerShadow.dispose()
    this.scorches.dispose()
    this.obstacles.dispose()
    this.debris.dispose()
    this.billboards.dispose()
    this.billboardsTop.dispose()
    this.castMarks.batch.dispose()
    this.chevrons.dispose()
    this.dest.dispose()
    this.locator?.dispose()
    this.contact.dispose()
    this.projectiles.dispose()
    this.ctx.field.dispose()
    this.overlay?.dispose()
    if (postState.sdf === this.ctx.field.texture) postState.sdf = null
  }
}

const claimedProjectile = (spell: string): boolean => !!vfxForSpell(spell)?.drawProjectile
