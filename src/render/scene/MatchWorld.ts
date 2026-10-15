import * as THREE from 'three/webgpu'
import { fog, rangeFogFactor, vec3 } from 'three/tsl'
import type { PawnState, PlayerSlot, SimEvent, SimState } from '../../sim/types'
import { TICK_HZ } from '../../sim/types'
import { TILE_SIZE, isLocationSafe, layerRadius } from '../arenaGeom'
import { inputViz } from '../../game/input'
import { cameraRig, moveMarkers } from '../cameraRig'
import { LAVA_H, PROJECTILE_H, S, TILE_TOP_H } from '../coords'
import { WorldOverlay, type PlateInput } from '../overlay/WorldOverlay'
import type { TierConfig } from '../quality'
import type { RenderSource } from '../source'
import { Arena } from './Arena'
import { ContactShadows } from './ContactShadows'
import { Billboards } from './Billboards'
import { GroundFx, RING_CHEVRON, RING_EXPAND, RING_IMPLODE } from './GroundFx'
import { Environment } from './Environment'
import { Lava } from './Lava'
import { Obstacles } from './Obstacles'
import { Particles } from './Particles'
import { PawnView, samplePawn, type PawnSample } from './Pawns'
import { Projectiles, spellLook } from './Projectiles'
import { Scorches } from './Scorches'
import { createWorldCtx, type WorldCtx } from './world'

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

const SCOURGE_COLOR = [1.5, 0.55, 2.4] as const
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
  private particles: Particles
  private smoke: Particles
  private ground: GroundFx
  private groundShadow: GroundFx
  private scorches: Scorches
  private obstacles: Obstacles
  private debris: Particles
  private billboards: Billboards
  private projectiles: Projectiles
  private overlay: WorldOverlay | null
  private views = new Map<number, PawnView>()
  private sample: PawnSample = { x: 0, y: 0, facing: 0 }
  private plates: PlateInput[] = []
  private flashes: Flash[] = []
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
  private hemi: THREE.HemisphereLight
  private moon: THREE.DirectionalLight
  private contact = new ContactShadows(48)
  /** key light direction (toward the light), from the camera's left-back, high */
  private moonDir = new THREE.Vector3(-0.42, 0.86, 0.3).normalize()

  constructor(private opts: MatchWorldOptions) {
    this.ctx = createWorldCtx(opts.tier, opts.fx)
    const ctx = this.ctx
    this.root.name = 'MatchWorld'
    this.lava = new Lava(ctx)
    this.arena = new Arena(ctx)
    this.env = new Environment(ctx)
    this.fogNode = fog(vec3(0.045, 0.014, 0.009), rangeFogFactor(24, 95))
    this.particles = new Particles(ctx, 4096 * Math.max(0.5, opts.tier.particles), 'add')
    this.smoke = new Particles(ctx, 768 * Math.max(0.5, opts.tier.particles), 'smoke')
    this.ground = new GroundFx(ctx)
    this.groundShadow = new GroundFx(ctx, 'shadow')
    this.scorches = new Scorches(ctx)
    this.obstacles = new Obstacles(ctx)
    this.obstacles.onHit = (x, y, r, hpFrac) => this.obstacleChips(x, y, r, hpFrac, null)
    this.debris = new Particles(ctx, 512, 'debris')
    this.billboards = new Billboards(160, opts.tier.heatHaze)
    this.projectiles = new Projectiles(ctx, this.particles, this.smoke, this.billboards)
    // night: low cool ambient from the sky, warm bounce from the lava below,
    // a cool moon key from high behind the camera's left (lights the faces the
    // camera sees; shadows fall up-right on screen)
    this.hemi = new THREE.HemisphereLight(0x221c3a, 0xff4a12, 0.85)
    this.moon = new THREE.DirectionalLight(0x9fb2ff, 1.7)
    this.moon.position.copy(this.moonDir).multiplyScalar(30)
    if (opts.tier.shadowMap > 0) {
      const sh = this.moon.shadow
      this.moon.castShadow = true
      sh.mapSize.set(opts.tier.shadowMap, opts.tier.shadowMap)
      const ext = 17
      const cam = sh.camera as THREE.OrthographicCamera
      cam.left = -ext
      cam.right = ext
      cam.top = ext
      cam.bottom = -ext
      cam.near = 1
      cam.far = 70
      sh.bias = -0.0006
      sh.normalBias = 0.02
      sh.radius = 3
    }
    this.root.add(this.hemi, this.moon, this.moon.target, this.contact.mesh)
    this.root.add(this.lava.mesh, this.env.group, this.arena.group, this.obstacles.group, this.debris.sprite, this.scorches.mesh, this.groundShadow.mesh, this.ground.mesh, this.smoke.sprite, this.particles.sprite, this.billboards.sprite, this.projectiles.mesh)
    this.overlay = opts.mode === 'match' && opts.overlayParent ? new WorldOverlay(opts.overlayParent) : null
    for (let i = 0; i < 12; i++) {
      this.plates.push({ x: 0, y: 0, h: 0, name: '', color: 0, hp: 0, maxHp: 1, kbPoints: 0, visible: false, local: false })
    }
    postState.sdf = ctx.field.texture
    postState.hurt = 0
    this.arena.setLayer(14, 0, false)
    if (opts.mode === 'match') cameraRig.reset()
  }

  setFx(fx: number): void {
    this.ctx.uFx.value = fx
    this.opts.fx = fx
  }

  update(dtReal: number, camera: THREE.PerspectiveCamera, aspect: number): void {
    // hit-stop: freeze the world (sim reads, particles, anims) for a few frames
    if (this.hitStop > 0) {
      this.hitStop -= dtReal
      cameraRig.update(camera, cameraRig.fx, cameraRig.fy, dtReal, aspect, this.opts.fx)
      return
    }
    const dt = dtReal
    this.clock += dt
    const t = this.clock
    this.ctx.uTime.value = t
    this.ctx.glow.begin()
    this.billboards.begin()
    this.contact.begin()
    const src = this.opts.source
    const buf = src.buf
    const curr = buf.curr

    if (curr) {
      // a new match restarts tick numbering: drop everything tied to the old one
      if (curr.tick < this.lastStateTick) this.resetMatch()
      const first = this.lastStateTick < 0
      this.lastStateTick = curr.tick
      const span = buf.currAt - buf.prevAt
      const alpha = !buf.prev || span <= 0 ? 1 : Math.max(0, Math.min(1, (performance.now() - buf.currAt) / span))
      const prev = buf.prev && buf.prev.tick <= curr.tick ? buf.prev : null

      this.updateArena(curr, t, first, alpha)
      this.consumeEvents(curr, t, first)
      this.updatePawns(prev, curr, alpha, t, dt)
      this.obstacles.setTheme(curr.arena.theme)
      this.obstacles.update(curr.obstacles, t, !first)
      for (const o of curr.obstacles) this.blobShadow(o.x, o.y, o.radius * 1.5)
      this.updateLocalHelpers(curr)
      this.projectiles.update(prev ? prev.projectiles : null, curr.projectiles, alpha, t, (owner) => this.colorOf(curr, owner), camera, aspect)
    }

    this.ambient(dt, t)
    this.drawFlashes(t)
    this.updateCamera(camera, curr, dt, aspect, t)
    // key light + its shadow frustum follow the camera focus (texel-snapped)
    {
      const fx = this.opts.mode === 'menu' ? 0 : cameraRig.fx * S
      const fz = this.opts.mode === 'menu' ? 0 : -cameraRig.fy * S
      const snap = (34 / Math.max(512, this.opts.tier.shadowMap || 512)) * 4
      const sx = Math.round(fx / snap) * snap
      const sz = Math.round(fz / snap) * snap
      this.moon.target.position.set(sx, 0, sz)
      this.moon.position.set(sx + this.moonDir.x * 30, this.moonDir.y * 30, sz + this.moonDir.z * 30)
    }
    this.updateCursor(camera)
    if (this.overlay) {
      let n = 0
      for (const v of this.views.values()) {
        if (n >= this.plates.length) break
        const pl = this.plates[n++]
        pl.x = v.x
        pl.y = v.y
        pl.h = v.h + 150
        pl.name = v.name
        pl.color = v.color.getHex()
        pl.hp = v.hp
        pl.maxHp = v.maxHp
        pl.kbPoints = v.kbPoints
        pl.visible = v.alive && !v.dead
        pl.local = v.owner === buf.localPlayer
      }
      this.overlay.update(camera, t, this.plates, n)
    }
    postState.hurt = Math.max(0, postState.hurt - dt * 3.2)

    this.ctx.glow.end()
    this.arena.update(t)
    this.particles.commit()
    this.smoke.commit()
    this.ground.commit()
    this.groundShadow.commit()
    this.scorches.commit()
    this.debris.commit()
    this.billboards.commit()
    this.contact.commit()
  }

  /** Contact shadow disc on the floor at a game position (skipped over lava). */
  private blobShadow(x: number, y: number, radius: number): void {
    if (!isLocationSafe(x, y, this.arena.currentLayer)) return
    this.contact.add(x * S, (TILE_TOP_H + 0.8) * S, -y * S, radius * S)
  }

  private resetMatch(): void {
    for (const v of this.views.values()) {
      this.root.remove(v.root)
      v.dispose()
    }
    this.views.clear()
    this.lastEventTick = -1
    this.lastStateTick = -1
    this.lastLayer = -1
    this.deathFocus = null
    if (this.opts.mode === 'match') cameraRig.recenter()
  }

  private colorOf(s: SimState, owner: number): number {
    for (const sl of s.slots) if (sl.id === owner) return sl.color
    return 0xffffff
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
    if (this.opts.mode === 'match') cameraRig.shake(0.22 * this.opts.fx)
  }

  // ---------------------------------------------------------------- events

  private consumeEvents(curr: SimState, t: number, first: boolean): void {
    if (first || this.lastEventTick < 0) {
      // skip history older than half a second when (re)attaching mid-match
      this.lastEventTick = Math.max(this.lastEventTick, curr.tick - 30)
    }
    const batches = this.opts.source.eventsSince(this.lastEventTick)
    for (const b of batches) {
      for (const e of b.events) this.handleEvent(e, b.events, curr, t)
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
    switch (e.type) {
      case 'projectileHit':
      case 'projectileExpire':
        this.explodeProjectile(e.x, e.y, e.spell, e.type === 'projectileHit')
        if (e.type === 'projectileHit' && e.target !== null) {
          const ob = this.obstacles.get(e.target)
          if (ob) this.obstacleChips(e.x, e.y, 40, ob.hp / 400, spellLook(e.spell).trail)
        }
        break
      case 'obstacleDestroyed':
        this.obstacleBlast(e.x, e.y)
        break
      case 'damage': {
        const v = this.viewOfPawn(e.target)
        v?.hit(t)
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
          this.hitImpact(e.x, e.y, e.kb, dx, dy, v)
          v?.impulse(dx, dy, e.kb)
        } else {
          this.lavaHiss(e.x, e.y, v)
        }
        this.overlay?.number(e.target, e.x, e.y, (v?.h ?? TILE_TOP_H) + 120, e.amount, 'dmg', t)
        if (match && this.isLocalPawn(curr, e.target)) {
          cameraRig.shake(Math.min(1, 0.12 + e.kb / 1600) * fx)
          if (e.kb > 0) cameraRig.kick(dx, dy, Math.min(900, 250 + e.kb * 0.5) * fx)
          postState.hurt = Math.min(1, postState.hurt + (e.kb > 0 ? 0.35 + Math.min(0.5, e.kb / 2000) : 0.12))
          // 2-4 frames of hit-stop on big hits
          if (e.kb >= 700 && fx > 0.05) this.hitStop = Math.min(4, 2 + Math.floor((e.kb - 700) / 500)) / 60
        }
        if (e.kb >= 1300 && t - this.lastCallout > 2.5 && e.source !== null) {
          this.lastCallout = t
          this.overlay?.callout('Smash!', e.x, e.y, (v?.h ?? TILE_TOP_H) + 120, t)
        }
        break
      }
      case 'heal': {
        const v = this.viewOfPawn(e.target)
        this.overlay?.number(e.target, e.x, e.y, (v?.h ?? TILE_TOP_H) + 120, e.amount, 'heal', t)
        const n = this.particles.budget(10)
        for (let i = 0; i < n; i++) {
          this.particles.spawn(e.x + (Math.random() - 0.5) * 50, e.y + (Math.random() - 0.5) * 50, TILE_TOP_H + 20 + Math.random() * 60, 0, 0, 90, 0.7, 10, 2, 0.4, 2.2, 0.5, 40, 1, 8)
        }
        break
      }
      case 'teleport':
        this.teleportFx(e.fromX, e.fromY, e.toX, e.toY)
        break
      case 'explosion':
        if (e.spell.startsWith('scourge')) this.scourgeBlast(e.x, e.y, e.radius)
        else this.genericBlast(e.x, e.y, e.radius, spellLook(e.spell).trail)
        if (match) this.shakeNear(e.x, e.y, 0.3 * fx)
        break
      case 'castStart': {
        this.viewOfPawn(e.pawn)?.castStart(e.spell, e.ticks)
        break
      }
      case 'cast': {
        const v = this.viewOfPawn(e.pawn)
        v?.castRelease(t)
        if (e.spell.startsWith('scourge') && !tickEvents.some((x) => x.type === 'explosion' && x.spell.startsWith('scourge'))) {
          if (v) this.scourgeBlast(v.x, v.y, 250)
        }
        if (v && !e.spell.startsWith('scourge')) {
          // muzzle flash at the staff tip
          v.tipWorld(this.tmpV)
          this.flash(this.tmpV.x / S, -this.tmpV.z / S, this.tmpV.y / S, 0.16, 160, 70, 2.2, 1.0, 0.35)
        }
        break
      }
      case 'death': {
        const v = this.viewOfPawn(e.pawn)
        if (v) {
          this.deathBurst(v)
          if (v.onLava && t - this.lastCallout > 1) {
            this.lastCallout = t
            this.overlay?.callout('Melted', v.x, v.y, v.h + 120, t)
          }
          if (match && v.owner === this.opts.source.buf.localPlayer) {
            cameraRig.shake(0.9 * fx)
            this.deathFocus = { x: v.x, y: v.y, at: t }
          }
        }
        break
      }
      case 'arenaShrink':
        // tiles are diffed from state; the event only adds a rumble when the
        // diff already happened this frame (removedRing filled in updateArena)
        break
      case 'phase':
        if (e.phase === 'fight') this.roundStart(curr, t)
        break
      case 'roundWin':
      case 'gameOver': {
        const winners = e.type === 'roundWin' ? e.players : e.winners
        for (const v of this.views.values()) {
          if (!winners.includes(v.owner) || !v.alive) continue
          const n = this.particles.budget(60)
          for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2
            const sp = 80 + Math.random() * 220
            this.particles.spawn(v.x, v.y, v.h + 60, Math.cos(a) * sp, Math.sin(a) * sp, 380 + Math.random() * 420, 1.2 + Math.random() * 0.8, 9, 3, 3.2, 2.4, 0.9, -700, 0.6, 6)
          }
        }
        break
      }
      case 'castCancel':
        // only a cast point that was visibly running needs to fizzle
        if (e.started) this.viewOfPawn(e.pawn)?.castCancel(t)
        break
      case 'swap':
        this.teleportFx(e.fromX, e.fromY, e.toX, e.toY)
        if (e.other !== null) this.teleportFx(e.toX, e.toY, e.fromX, e.fromY)
        break
      case 'respawn': {
        const floor = isLocationSafe(e.x, e.y, this.arena.currentLayer) ? TILE_TOP_H + 1 : LAVA_H + 2
        this.ground.spawn(RING_IMPLODE, e.x, e.y, floor, 10, 160, 0.4, 12, 1.4, 1.2, 1.0)
        this.flash(e.x, e.y, 80, 0.35, 220, 200, 1.6, 1.4, 1.2)
        break
      }
      default:
        break
    }
  }

  /** A windup that never released: the charge gutters out in smoke and sparks. */
  private fizzleFx(v: PawnView): void {
    v.tipWorld(this.tmpV)
    const x = this.tmpV.x / S
    const y = -this.tmpV.z / S
    const h = this.tmpV.y / S
    const c = v.color
    const n = this.particles.budget(10)
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 40 + Math.random() * 90
      this.particles.spawn(x, y, h, Math.cos(a) * sp, Math.sin(a) * sp, -40 + Math.random() * 80, 0.25 + Math.random() * 0.2, 6, 1, c.r * 1.6, c.g * 1.6, c.b * 1.6, -700, 2, -0.05)
    }
    this.smoke.spawn(x, y, h, 0, 0, 60, 0.6, 14, 50, 0.08, 0.07, 0.07, 30, 1, 6)
  }

  private shakeNear(x: number, y: number, amount: number): void {
    const dx = x - cameraRig.fx
    const dy = y - cameraRig.fy
    const d = Math.hypot(dx, dy)
    if (d < 900) cameraRig.shake(amount * (1 - d / 900))
  }

  private flash(x: number, y: number, h: number, life: number, radius: number, size: number, r: number, g: number, b: number): void {
    if (this.flashes.length > 24) this.flashes.shift()
    this.flashes.push({ x, y, h, born: this.ctx.uTime.value, life, radius, size, r, g, b })
  }

  private drawFlashes(t: number): void {
    let w = 0
    for (let i = 0; i < this.flashes.length; i++) {
      const f = this.flashes[i]
      const k = 1 - (t - f.born) / f.life
      if (k <= 0) continue
      this.flashes[w++] = f
      const e = k * k
      this.ctx.glow.add(f.x, f.y, f.radius, 0.9 * e, f.r * 0.33, f.g * 0.33, f.b * 0.33)
      this.billboards.add(f.x * S, f.h * S, -f.y * S, f.size * S * (1.4 - k * 0.4), f.r * e, f.g * e, f.b * e, 1.8)
    }
    this.flashes.length = w
  }

  private explodeProjectile(x: number, y: number, spell: string, hit: boolean): void {
    const look = spellLook(spell)
    const ps = this.particles
    const h = PROJECTILE_H
    const nFire = ps.budget(hit ? 30 : 20)
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
    const onTile = isLocationSafe(x, y, this.arena.currentLayer)
    const floor = onTile ? TILE_TOP_H + 1 : LAVA_H + 2
    this.ground.spawn(RING_EXPAND, x, y, floor, 15, 170, 0.42, 16, look.trail[0], look.trail[1], look.trail[2])
    if (onTile) this.scorches.spawn(x, y, TILE_TOP_H + 0.6, 60 + Math.random() * 25)
    this.flash(x, y, h, 0.24, 340, 170, look.light[0] * 1.7, look.light[1] * 1.7, look.light[2] * 1.7)
    if (this.opts.mode === 'match') this.shakeNear(x, y, 0.12 * this.opts.fx)
  }

  /**
   * Hit impact scaled by knockback: directional spark cone along the push,
   * hot flash at the contact, ground shockwave, debris and a smoke puff.
   */
  private hitImpact(x: number, y: number, kb: number, dx: number, dy: number, v: PawnView | undefined): void {
    const ps = this.particles
    const k = Math.min(2.2, kb / 900)
    const h = (v?.h ?? TILE_TOP_H) + 55
    const baseA = Math.atan2(dy, dx)
    const hasDir = dx !== 0 || dy !== 0
    const cone = hasDir ? 0.55 : Math.PI
    const n = ps.budget(10 + k * 34)
    for (let i = 0; i < n; i++) {
      const a = baseA + (Math.random() - 0.5) * 2 * cone
      const sp = (420 + Math.random() * 900) * (0.6 + k * 0.5)
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
    this.flash(x - dx * 20, y - dy * 20, h, 0.09 + k * 0.04, 160 + k * 80, 70 + k * 50, 2.0, 1.7, 1.4)
    const floor = v && v.onLava ? LAVA_H + 2 : TILE_TOP_H + 1
    this.ground.spawn(RING_EXPAND, x, y, floor, 18, 70 + k * 70, 0.28 + k * 0.06, 8 + k * 4, 2.2, 1.6, 1.1)
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
      const g = 0.05 + Math.random() * 0.06
      this.debris.spawn(x + Math.cos(a) * radius * 0.6, y + Math.sin(a) * radius * 0.6, TILE_TOP_H + 40 + Math.random() * 90, Math.cos(a) * sp, Math.sin(a) * sp, 120 + Math.random() * 300, 0.6 + Math.random() * 0.5, 7 + Math.random() * 7, 5, g, g * 0.9, g * 0.85, -1700, 0.6, 0)
    }
    const ns = this.smoke.budget(3)
    for (let i = 0; i < ns; i++) {
      this.smoke.spawn(x, y, TILE_TOP_H + 60, (Math.random() - 0.5) * 100, (Math.random() - 0.5) * 100, 30, 0.9, 30, 100, 0.12, 0.1, 0.09, 10, 1, 8)
    }
    if (tint) this.flash(x, y, TILE_TOP_H + 70, 0.12, 160, 90, tint[0], tint[1], tint[2])
  }

  /** Pillar destroyed: blast, a shower of rock chunks, embers and dust. */
  private obstacleBlast(x: number, y: number): void {
    const nd = this.debris.budget(60)
    for (let i = 0; i < nd; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 120 + Math.random() * 520
      const g = 0.04 + Math.random() * 0.08
      this.debris.spawn(x + (Math.random() - 0.5) * 60, y + (Math.random() - 0.5) * 60, TILE_TOP_H + Math.random() * 180, Math.cos(a) * sp, Math.sin(a) * sp, 200 + Math.random() * 500, 0.8 + Math.random() * 0.7, 10 + Math.random() * 16, 8, g, g * 0.9, g * 0.8, -1800, 0.4, 0)
    }
    const ne = this.particles.budget(40)
    for (let i = 0; i < ne; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 200 + Math.random() * 600
      this.particles.spawn(x, y, TILE_TOP_H + 80, Math.cos(a) * sp, Math.sin(a) * sp, 100 + Math.random() * 400, 0.5 + Math.random() * 0.5, 9, 2, 3.4, 1.1, 0.2, -1400, 1.5, -0.08)
    }
    const ns = this.smoke.budget(14)
    for (let i = 0; i < ns; i++) {
      const a = Math.random() * Math.PI * 2
      this.smoke.spawn(x, y, TILE_TOP_H + 40, Math.cos(a) * 140, Math.sin(a) * 140, 60 + Math.random() * 60, 1.6 + Math.random(), 70, 220, 0.11, 0.09, 0.08, 15, 0.9, 20)
    }
    this.ground.spawn(RING_EXPAND, x, y, TILE_TOP_H + 1, 20, 260, 0.5, 20, 2.4, 1.3, 0.5)
    this.scorches.spawn(x, y, TILE_TOP_H + 0.6, 110, 6)
    this.flash(x, y, TILE_TOP_H + 80, 0.3, 380, 260, 2.4, 1.2, 0.4)
    if (this.opts.mode === 'match') this.shakeNear(x, y, 0.45 * this.opts.fx)
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

  private teleportFx(fx: number, fy: number, tx: number, ty: number): void {
    const [r, g, b] = TELEPORT_COLOR
    const h0 = isLocationSafe(fx, fy, this.arena.currentLayer) ? TILE_TOP_H + 1 : LAVA_H + 2
    const h1 = isLocationSafe(tx, ty, this.arena.currentLayer) ? TILE_TOP_H + 1 : LAVA_H + 2
    this.ground.spawn(RING_IMPLODE, fx, fy, h0, 8, 120, 0.3, 10, r, g, b)
    this.ground.spawn(RING_EXPAND, tx, ty, h1, 10, 180, 0.45, 14, r, g, b)
    const ps = this.particles
    const n = ps.budget(26)
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const rr = 70 + Math.random() * 40
      // implode: start on a circle, fly to the centre
      ps.spawn(fx + Math.cos(a) * rr, fy + Math.sin(a) * rr, h0 + 20 + Math.random() * 80, -Math.cos(a) * rr * 3.2, -Math.sin(a) * rr * 3.2, 0, 0.3, 12, 3, r, g, b, 0, 0, 0)
      // burst: outward plus a rising column
      const sp = 200 + Math.random() * 300
      ps.spawn(tx, ty, h1 + 10, Math.cos(a) * sp, Math.sin(a) * sp, 60 + Math.random() * 120, 0.45, 12, 2, r, g, b, -200, 3, -0.08)
      ps.spawn(tx + Math.cos(a) * 20, ty + Math.sin(a) * 20, h1, 0, 0, 260 + Math.random() * 300, 0.5, 9, 2, r * 1.2, g * 1.2, b * 1.2, 0, 1.5, 6)
    }
    this.flash(fx, fy, h0 + 60, 0.2, 220, 180, r, g, b)
    this.flash(tx, ty, h1 + 60, 0.3, 300, 240, r, g, b)
  }

  private scourgeBlast(x: number, y: number, radius: number): void {
    const [r, g, b] = SCOURGE_COLOR
    const onTile = isLocationSafe(x, y, this.arena.currentLayer)
    const floor = onTile ? TILE_TOP_H + 1 : LAVA_H + 2
    this.ground.spawn(RING_EXPAND, x, y, floor, 30, radius, 0.32, 18, r, g, b)
    if (onTile) this.scorches.spawn(x, y, TILE_TOP_H + 0.6, radius * 0.55, 3.5)
    this.ground.spawn(RING_EXPAND, x, y, floor, radius * 0.9, radius * 1.15, 0.5, 8, r * 0.6, g * 0.6, b * 0.6)
    const ps = this.particles
    const n = ps.budget(48)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.1
      const sp = radius * (2.6 + Math.random() * 1.2)
      ps.spawn(x, y, floor + 30 + Math.random() * 40, Math.cos(a) * sp, Math.sin(a) * sp, Math.random() * 120, 0.32, 14, 4, r, g, b, -300, 3.5, -0.08)
    }
    this.flash(x, y, 80, 0.25, radius * 1.4, 300, r, g, b)
    if (this.opts.mode === 'match') this.shakeNear(x, y, 0.25 * this.opts.fx)
  }

  private genericBlast(x: number, y: number, radius: number, c: readonly [number, number, number]): void {
    const floor = isLocationSafe(x, y, this.arena.currentLayer) ? TILE_TOP_H + 1 : LAVA_H + 2
    this.ground.spawn(RING_EXPAND, x, y, floor, 20, radius, 0.4, 16, c[0], c[1], c[2])
    this.flash(x, y, 80, 0.25, radius * 1.4, 260, c[0], c[1], c[2])
  }

  private deathBurst(v: PawnView): void {
    const ps = this.particles
    const h = v.h + 50
    const n = ps.budget(50)
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 120 + Math.random() * 380
      ps.spawn(v.x, v.y, h, Math.cos(a) * sp, Math.sin(a) * sp, 120 + Math.random() * 380, 0.5 + Math.random() * 0.7, 30 + Math.random() * 30, 6, 3.4, 1.0, 0.18, -350, 2.2, 8)
    }
    const c = v.color
    const n2 = ps.budget(30)
    for (let i = 0; i < n2; i++) {
      ps.spawn(v.x + (Math.random() - 0.5) * 40, v.y + (Math.random() - 0.5) * 40, h, 0, 0, 200 + Math.random() * 300, 1.2 + Math.random(), 10, 2, c.r * 3, c.g * 3, c.b * 3, 30, 0.8, 30)
    }
    const ns = this.smoke.budget(14)
    for (let i = 0; i < ns; i++) {
      this.smoke.spawn(v.x, v.y, h, (Math.random() - 0.5) * 120, (Math.random() - 0.5) * 120, 80 + Math.random() * 80, 1.6 + Math.random(), 60, 200, 0.05, 0.03, 0.03, 20, 0.8, 20)
    }
    const floor = v.onLava ? LAVA_H + 2 : TILE_TOP_H + 1
    this.ground.spawn(RING_EXPAND, v.x, v.y, floor, 20, 260, 0.6, 22, c.r * 2 + 1, c.g * 2 + 0.4, c.b * 2 + 0.1)
    if (!v.onLava) this.scorches.spawn(v.x, v.y, TILE_TOP_H + 0.6, 95, 6)
    this.flash(v.x, v.y, h, 0.4, 420, 320, 3, 1.3, 0.4)
  }

  private roundStart(curr: SimState, t: number): void {
    const R = layerRadius(curr.arena.layer) + 300
    this.ground.spawn(RING_EXPAND, 0, 0, TILE_TOP_H + 2, 40, R, 1.25, 70, 2.4, 1.2, 0.35)
    this.ground.spawn(RING_EXPAND, 0, 0, TILE_TOP_H + 2, 10, R * 0.7, 0.9, 30, 3.5, 2.4, 1.0)
    this.arena.shock(0, 0, t, 1)
    this.flash(0, 0, 120, 0.5, 900, 500, 2.6, 1.4, 0.5)
    if (this.opts.mode === 'match') cameraRig.shake(0.3 * this.opts.fx)
  }

  // ---------------------------------------------------------------- pawns

  private updatePawns(prev: SimState | null, curr: SimState, alpha: number, t: number, dt: number): void {
    const seen = this.ctx.uTime.value
    const layer = this.arena.currentLayer
    for (const p of curr.pawns) {
      let v = this.views.get(p.id)
      if (!v) {
        v = new PawnView(this.ctx)
        v.setSlot(this.slotOf(curr, p.owner), p.owner)
        v.onFizzle = (pv) => this.fizzleFx(pv)
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
      samplePawn(pp, p, alpha, this.sample)
      v.update(p, this.sample, layer, t, dt)
      v.seen = seen
      v.kbPoints = p.kbPoints
      this.pawnAmbient(v, p, dt)
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
      }
    }
    // UI-requested markers (showMoveMarker)
    while (moveMarkers.length > 0) {
      const m = moveMarkers.shift()!
      this.moveMarker(m.x, m.y)
      this.lastUiMarker = t
      this.lastMoveTarget.x = m.x
      this.lastMoveTarget.y = m.y
    }
    let local: PawnState | undefined
    for (const p of curr.pawns) if (p.owner === buf.localPlayer) local = p
    if (local && local.alive && local.moveTarget) {
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

  /** Dota-style move marker: green chevrons converge, lifted off the floor with a soft shadow. */
  private moveMarker(x: number, y: number): void {
    const floor = isLocationSafe(x, y, this.arena.currentLayer) ? TILE_TOP_H : LAVA_H
    const lift = 14
    // shadow offset away from the key light
    const ox = (-this.moonDir.x / this.moonDir.y) * lift
    const oy = (this.moonDir.z / this.moonDir.y) * lift
    this.ground.spawn(RING_CHEVRON, x, y, floor + lift, 10, 46, 0.42, 4, 0.35, 1.6, 0.45)
    this.ground.spawn(RING_EXPAND, x, y, floor + lift, 4, 30, 0.3, 3, 0.25, 1.2, 0.35)
    this.groundShadow.spawn(RING_CHEVRON, x + ox, y + oy, floor + 0.7, 10, 46, 0.42, 7, 0, 0, 0)
  }

  private pawnAmbient(v: PawnView, p: PawnState, dt: number): void {
    const ps = this.particles
    if (v.onLava && p.alive) {
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
    if (v.dead && !v.deathDone) {
      const n = ps.budget(dt * 90)
      for (let i = 0; i < n; i++) {
        ps.spawn(v.x + (Math.random() - 0.5) * 50, v.y + (Math.random() - 0.5) * 50, v.h + Math.random() * 100, 0, 0, 120 + Math.random() * 160, 0.8 + Math.random() * 0.6, 9, 2, 3.4, 1.1, 0.25, 40, 1, 18)
      }
    }
    if (p.cast && p.cast.started !== false && p.alive) {
      // staff crystal flare grows through the windup
      v.tipWorld(this.tmpV)
      const c = v.color
      const k = v.castFraction
      this.billboards.add(this.tmpV.x, this.tmpV.y, this.tmpV.z, (40 + k * 90) * S, c.r * (1 + k * 3) + k, c.g * (1 + k * 3) + k * 0.8, c.b * (1 + k * 3) + k * 0.6, 2.2)
      this.ctx.glow.add(v.x, v.y, 140 + k * 100, 0.2 + k * 0.5, c.r, c.g, c.b)
    }
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
    if (local && local.alive && !local.dead) {
      fx = local.x
      fy = local.y
      this.deathFocus = null
      const cur = this.opts.source.buf.cursor
      if (cur.valid) {
        // gentle look-ahead toward the cursor
        let dx = (cur.x - local.x) * 0.12
        let dy = (cur.y - local.y) * 0.12
        const l = Math.hypot(dx, dy)
        if (l > 160) {
          dx *= 160 / l
          dy *= 160 / l
        }
        fx += dx
        fy += dy
      }
    } else if (this.deathFocus && t - this.deathFocus.at < 1.6) {
      fx = this.deathFocus.x
      fy = this.deathFocus.y
    } else {
      // spectate: keep the current target if alive, else the first living pawn
      let target: PawnView | undefined = this.views.get(this.spectateId)
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
      if (target && lp >= 0) {
        fx = target.x
        fy = target.y
      }
    }
    cameraRig.update(camera, fx, fy, dt, aspect, this.opts.fx)
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
    for (const v of this.views.values()) v.dispose()
    this.views.clear()
    this.lava.dispose()
    this.env.dispose()
    this.arena.dispose()
    this.particles.dispose()
    this.smoke.dispose()
    this.ground.dispose()
    this.groundShadow.dispose()
    this.scorches.dispose()
    this.obstacles.dispose()
    this.debris.dispose()
    this.billboards.dispose()
    this.contact.dispose()
    this.projectiles.dispose()
    this.ctx.field.dispose()
    this.overlay?.dispose()
    if (postState.sdf === this.ctx.field.texture) postState.sdf = null
  }
}
