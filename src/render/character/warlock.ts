import * as THREE from 'three/webgpu'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import type { PawnState, SimEvent } from '../../sim/types'
import { S, facingToYaw } from '../coords'
import { Animator } from './animator'
import type { WarlockAsset } from './asset'
import { CC0_SCALE, facingUniform, type CastFrom } from './config'
import type { StaffVariant } from './geometry'
import { WarlockGpu } from './gpuState'
import { applyBuild, newBuildCache, startLevelUp, tickLevelUp } from './progression'
import { stepEnvelope, type EnvelopeState } from './frontEnvelope'
import { clothParams } from './materials'
import type { CastArm, DeathKind, WarlockHandle } from './types'
import { CAST_HANDS, castCategory, windupHiddenFrom, type CastCategory, type CastHands } from './castStyles'
import { frame } from '../../game/frame'
import { syncFootprint } from './debug'
import { DeathMotion, LaunchMotion, deathHop } from './impactMotion'
import { newVictoryPose, sampleVictoryPose, type VictoryStyle } from './victoryPose'

const TAU = Math.PI * 2
function angDiff(a: number, b: number): number {
  let d = b - a
  while (d > Math.PI) d -= TAU
  while (d < -Math.PI) d += TAU
  return d
}
const lerpAngle = (a: number, b: number, t: number) => a + angDiff(a, b) * t
const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt)
const ramp = (t: number, a: number, b: number) => Math.min(1, Math.max(0, (t - a) / (b - a)))

/** Native forward speed of the in-place clips (model metres / s at timeScale 1). */
const RUN_SPEED = 3.1
const WALK_SPEED = 1.15
/** Clip lengths used to fit windups (s). */
const ENTER_LEN = 0.53
/** OverhandThrow: arm at its highest (s) */
const THROW_PEAK = 0.34
type CastPhase = 'none' | 'windup' | 'release' | 'backswing'

/** sim death cause -> look */
export function deathKindFor(cause: string | undefined, kb: number): DeathKind {
  switch (cause) {
    case 'lava':
      return 'lava'
    case 'fireball':
    case 'splitter':
    case 'cluster':
      return 'fireball'
    case 'lightning':
      return 'lightning'
    case 'meteor':
      return 'meteor'
    case 'snowball':
      return 'freeze'
    case 'gravity':
      return 'gravity'
    case 'drain':
      return 'drain'
    case 'scourge':
      return 'shadow'
    case 'disconnect':
      return 'fade'
    default:
      return kb > 500 ? 'fireball' : 'ash'
  }
}

/** Spring that trails the hem behind body motion (model-local metres, x/z). */
class HemSpring {
  x = 0
  z = 0
  vx = 0
  vz = 0
  constructor(
    private k: number,
    private c: number,
    private drag: number,
    private max: number,
    readonly couple: number,
  ) {}

  /** Rotate the stored offset (body turned under the cloth). */
  rotate(a: number): void {
    const c = Math.cos(a)
    const s = Math.sin(a)
    let x = this.x
    this.x = x * c + this.z * s
    this.z = -x * s + this.z * c
    x = this.vx
    this.vx = x * c + this.vz * s
    this.vz = -x * s + this.vz * c
  }

  step(dt: number, velX: number, velZ: number): void {
    let tx = -velX * this.drag
    let tz = -velZ * this.drag
    const tl = Math.hypot(tx, tz)
    if (tl > this.max) {
      tx *= this.max / tl
      tz *= this.max / tl
    }
    const n = Math.max(1, Math.ceil(dt / (1 / 120)))
    const h = dt / n
    for (let i = 0; i < n; i++) {
      this.vx += ((tx - this.x) * this.k - this.vx * this.c) * h
      this.vz += ((tz - this.z) * this.k - this.vz * this.c) * h
      this.x += this.vx * h
      this.z += this.vz * h
    }
    const l = Math.hypot(this.x, this.z)
    if (l > this.max * 1.4) {
      this.x *= (this.max * 1.4) / l
      this.z *= (this.max * 1.4) / l
    }
  }

  reset(): void {
    this.x = this.z = this.vx = this.vz = 0
  }
}

export class CC0Warlock implements WarlockHandle {
  readonly style = 'cc0' as const
  readonly object3d = new THREE.Group()
  private tilt = new THREE.Group()
  private yawG = new THREE.Group()
  private model: THREE.Object3D
  private anim: Animator
  private gpu = new WarlockGpu()
  private bone: Record<string, THREE.Bone> = {}
  private palm = { l: new THREE.Object3D(), r: new THREE.Object3D() }
  private eyeSocket = new THREE.Object3D()
  private staffMesh: THREE.Mesh | null = null
  private staffTip = new THREE.Object3D()
  private staffBelow = 0
  private castFrom: CastFrom = 'palm'
  private castColorOverride: number | null = null
  private footprint: THREE.Object3D | null = null
  private build = newBuildCache()
  private hitFlashOn = true

  // motion state
  private t = 0
  private yaw = 0
  private yawInit = false
  private svx = 0
  private svy = 0
  private lastSvx = 0
  private lastSvy = 0
  private lastVx = 0
  private lastVy = 0
  private tipX = 0
  private tipZ = 0
  private tipVx = 0
  private tipVz = 0
  private twist = 0
  private coat = new HemSpring(55, 6, 0.085, 0.42, 0.45)
  private cape = new HemSpring(24, 3.1, 0.16, 0.75, 0.75)
  private flutterKick = 0

  // state machine
  private castPhase: CastPhase = 'none'
  private castCat: CastCategory = 'directional'
  private hands: CastHands = 'left'
  /** smoothed procedural cast poses (0..1) */
  private pose = { overhead: 0, cross: 0, flare: 0, beam: 0, ground: 0, sky: 0 }
  private castSpell = ''
  private castTotal = 1
  private castT = 0
  private releaseT = 0
  private castFullBody = false
  /** this viewer must not see the windup (another player's Scourge): no pose, no cast glow */
  private hidden = false
  private tumbling = false
  private launch = new LaunchMotion()
  private tumbleDirX = 0
  private tumbleDirY = 0
  private death = new DeathMotion()
  private get dead(): boolean { return this.death.active }
  private thrownDeath = false
  private deathKind: DeathKind = 'ash'
  private deathSpin = 0
  private victory = false
  private victoryFacing: number | null = null
  private victoryStyle: VictoryStyle = 'summon'
  private victoryAge = 0
  private victoryPose = newVictoryPose()
  private motionIntensity = 1
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  private recoilT = 1
  private recoilK = 0
  private hitToggle = false
  private locomotion = ''

  // scratch
  private v3 = new THREE.Vector3()
  private axis = new THREE.Vector3()
  private qb = new THREE.Quaternion()
  private qt = new THREE.Quaternion()
  private vel = { x: 0, z: 0 }
  private dvel = { x: 0, z: 0 }

  constructor(
    private asset: WarlockAsset,
    color: number,
    staff: StaffVariant | null,
    castFrom: CastFrom,
  ) {
    this.model = cloneSkinned(asset.template)
    this.model.scale.set(CC0_SCALE.xz, CC0_SCALE.y, CC0_SCALE.xz)
    // one skeleton for every skinned part (clone() gives each mesh its own copy)
    let shared: THREE.Skeleton | null = null
    this.model.traverse((o) => {
      o.userData.wl = this.gpu
      const sm = o as THREE.SkinnedMesh
      if (sm.isSkinnedMesh) {
        if (!shared) shared = sm.skeleton
        else sm.bind(shared, sm.bindMatrix)
      }
      if ((o as THREE.Bone).isBone) this.bone[o.name] = o as THREE.Bone
    })
    this.yawG.add(this.model)
    this.tilt.add(this.yawG)
    this.object3d.add(this.tilt)
    this.object3d.name = 'Warlock'

    // sockets: rest offsets (model metres) expressed in their bones' frames
    this.model.updateMatrixWorld(true)
    const socket = (bone: THREE.Bone, restModel: THREE.Vector3, o: THREE.Object3D) => {
      const w = this.v3.copy(restModel).applyMatrix4(this.model.matrixWorld)
      o.position.copy(bone.worldToLocal(w))
      bone.add(o)
    }
    socket(this.bone.hand_l, asset.rest.palmL, this.palm.l)
    socket(this.bone.hand_r, asset.rest.palmR, this.palm.r)
    socket(this.bone.Head, asset.rest.eyes, this.eyeSocket)

    // bigger hands read better from the gameplay camera (the casting hand most)
    this.bone.hand_l.scale.setScalar(1.18)
    this.bone.hand_r.scale.setScalar(1.18)
    this.anim = new Animator(this.model, asset.clips, asset.additive)
    this.anim.full('idle', { fade: 0.001 })
    this.gpu.phase = Math.random() * 100
    this.setColor(color)
    this.setStaff(staff)
    this.castFrom = castFrom
  }

  get castCharge(): number {
    return this.gpu.castCharge
  }

  setRobe(item: 'robe-cinder' | 'robe-moon' | null): void {
    // Near-unit luminance palettes affect untrimmed cloth only. Player-colored
    // trims, the woven shoulder cue and cast effects are composed afterward.
    this.gpu.clothBlend = item === null ? 0 : 1
    if (item === 'robe-cinder') this.gpu.clothTint.setRGB(1.22, 0.96, 0.8)
    else if (item === 'robe-moon') this.gpu.clothTint.setRGB(0.76, 1.01, 1.55)
    else this.gpu.clothTint.setRGB(1, 1, 1)
  }

  setColor(color: number): void {
    this.gpu.team.setHex(color)
    if (this.castColorOverride === null) this.gpu.castColor.copy(this.gpu.team)
  }

  setCastColor(color: number | null): void {
    this.castColorOverride = color
    if (color === null) this.gpu.castColor.copy(this.gpu.team)
    else this.gpu.castColor.setHex(color)
  }

  setCastFrom(from: CastFrom): void {
    this.castFrom = from
  }

  setStaff(variant: StaffVariant | null): void {
    if (this.staffMesh) {
      this.staffMesh.removeFromParent()
      this.staffMesh = null
    }
    if (!variant) return
    const s = this.asset.staffs[variant]
    const mesh = new THREE.Mesh(s.geometry, this.asset.staffMaterial)
    mesh.name = 'WarlockStaff'
    mesh.castShadow = true
    mesh.userData.wl = this.gpu
    mesh.add(this.staffTip)
    this.staffTip.position.copy(s.tip)
    this.staffBelow = s.below
    this.model.add(mesh)
    this.staffMesh = mesh
  }

  /** Hand(s) of the current / last cast: 'both' for aoe, buff and beam spells. */
  get castHands(): CastHands {
    return this.hands
  }

  /** world position of a node under the model: model-space matrix (this frame) x the model's world matrix */
  private worldPos(o: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 {
    this.model.updateWorldMatrix(true, false)
    return out.setFromMatrixPosition(this.modelMatrixOf(o)).applyMatrix4(this.model.matrixWorld)
  }

  castOrigin(out: THREE.Vector3): THREE.Vector3 {
    if (this.castFrom === 'staff' && this.staffMesh) return this.staffTip.getWorldPosition(out)
    if (this.hands === 'both') {
      this.worldPos(this.palm.l, out)
      return out.add(this.worldPos(this.palm.r, this.v3)).multiplyScalar(0.5)
    }
    return this.worldPos(this.hands === 'right' ? this.palm.r : this.palm.l, out)
  }

  castArm(out: CastArm, hand?: 'left' | 'right'): CastArm {
    const l = (hand ?? (this.hands === 'right' ? 'right' : 'left')) === 'left'
    const b = this.bone
    this.worldPos(l ? b.upperarm_l : b.upperarm_r, out.shoulder)
    this.worldPos(l ? b.lowerarm_l : b.lowerarm_r, out.elbow)
    this.worldPos(l ? b.hand_l : b.hand_r, out.wrist)
    this.worldPos(l ? this.palm.l : this.palm.r, out.palm)
    out.dir.subVectors(out.palm, out.wrist).normalize()
    return out
  }

  impulse(dx: number, dy: number, strength: number): void {
    // game direction -> model local, metres/s of sudden cloth velocity (opposite to the push)
    const wx = dx * S
    const wz = -dy * S
    const c = Math.cos(this.yaw)
    const s = Math.sin(this.yaw)
    const lx = (wx * c - wz * s) / CC0_SCALE.xz
    const lz = (wx * s + wz * c) / CC0_SCALE.xz
    const l = Math.hypot(lx, lz) || 1
    const k = Math.min(1600, strength) * 0.0035
    this.coat.vx -= (lx / l) * k
    this.coat.vz -= (lz / l) * k
    this.cape.vx -= (lx / l) * k * 1.4
    this.cape.vz -= (lz / l) * k * 1.4
    this.flutterKick = Math.min(1.5, this.flutterKick + strength / 900)
  }

  /** false: damage events skip the hit flash (a VFX module draws its own); cloth kick and hit reaction stay */
  hitFlash(enabled: boolean): void {
    this.hitFlashOn = enabled
    if (!enabled) this.gpu.flash = 0
  }

  levelUp(color?: number | null): void {
    startLevelUp(this.gpu, color ?? null)
  }

  tumble(dx: number, dy: number): void {
    if (this.dead || this.tumbling) return
    const l = Math.hypot(dx, dy) || 1
    this.tumbleDirX = dx / l
    this.tumbleDirY = dy / l
    this.tumbling = true
    this.launch.start()
    this.castPhase = 'none'
    this.anim.full('knockback', { fade: 0.08, loop: false, restart: true, timeScale: 1.1 })
  }

  deathFx(kind: DeathKind, dx = 0, dy = 0, edge?: number | readonly number[]): void {
    this.die(kind, dx, dy, true)
    if (edge !== undefined) {
      const c = this.gpu.dissolveColor
      if (typeof edge === 'number') {
        c.setHex(edge, THREE.SRGBColorSpace)
        // a glowing edge: lift to a bright HDR luminance whatever the hue
        const l = Math.max(1e-3, 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b)
        c.multiplyScalar(2.2 / l)
      } else c.setRGB(edge[0], edge[1], edge[2])
    }
  }

  setMotionIntensity(intensity: number): void {
    this.motionIntensity = this.reducedMotion.matches ? 0 : Math.max(0, Math.min(1, intensity))
  }

  beginRound(round: number): void {
    if (this.death.beginRound(round)) this.revive()
  }

  celebrate(facing: number, style: VictoryStyle = 'summon'): void {
    if (this.dead) return
    this.victory = true
    this.victoryFacing = facing
    this.victoryStyle = style
    this.victoryAge = 0
    this.castPhase = 'none'
    this.gpu.castCharge = 0
    this.locomotion = ''
    // A survivor still airborne finishes the existing launch before posing.
    if (!this.tumbling) this.anim.full('castLoop', { fade: 0.35, loop: true, timeScale: this.motionIntensity > 0 ? 0.6 : 0, restart: true, at: 0.4 })
  }

  // ------------------------------------------------------------------ events

  private onEvent(e: SimEvent, p: PawnState): void {
    switch (e.type) {
      case 'castStart':
        if (e.pawn === p.id && !this.victory) this.beginWindup(e.spell, e.ticks)
        break
      case 'cast':
        if (e.pawn === p.id && !this.victory) this.release(e.spell)
        break
      case 'castCancel':
        if (e.pawn === p.id) this.fizzle()
        break
      case 'damage':
        if (e.target === p.id && !this.dead && e.amount > 0) {
          if (this.hitFlashOn) {
            this.gpu.flash = 1
            this.gpu.flashK = Math.min(1.5, Math.max(0.35, 0.35 + e.amount / 20 + e.kb / 1500))
          }
          const w = Math.min(0.85, 0.22 + e.amount / 55 + e.kb / 3500)
          this.anim.hit(this.hitToggle ? 'hitHead' : 'hit', w)
          this.hitToggle = !this.hitToggle
          this.recoilT = 0
          this.recoilK = Math.min(1, 0.3 + e.kb / 1300)
          if (e.kb > 0) this.flutterKick = Math.min(1.5, this.flutterKick + e.kb / 900)
        }
        break
      case 'death':
        if (e.pawn === p.id) {
          const kb = e.kb ?? Math.hypot(p.vx - p.walkVx, p.vy - p.walkVy)
          this.die(p.lavaTicks > 0 && !e.cause ? 'lava' : deathKindFor(e.cause, kb), p.vx - p.walkVx, p.vy - p.walkVy, true)
        }
        break
      case 'teleport':
      case 'swap':
        if (e.pawn === p.id) {
          // blink: the cloth arrives settled, with a small flutter
          this.coat.reset()
          this.cape.reset()
          this.flutterKick = Math.max(this.flutterKick, 0.6)
          this.lastVx = p.vx
          this.lastVy = p.vy
          this.svx = this.lastSvx = p.vx
          this.svy = this.lastSvy = p.vy
        }
        break
      case 'roundWin':
        if (e.players.includes(p.owner) && p.alive) this.victory = true
        break
      case 'phase':
        if (e.phase !== 'roundEnd' && e.phase !== 'gameOver') {
          if (this.victory) this.locomotion = ''
          this.victory = false
        }
        if (e.phase === 'shop' && p.alive && this.dead) this.revive()
        if (!this.victory) this.victoryFacing = null
        break
      case 'respawn':
        if (e.pawn === p.id) this.revive()
        break
    }
  }

  private standing(): boolean {
    return !this.tumbling && this.locomotion === 'idle'
  }

  /** play on the upper layer, or on both layers when the legs are planted */
  private castClip(name: string, o: Parameters<Animator['full']>[1]): void {
    if (this.castFullBody) this.anim.full(name, o)
    else this.anim.upper.play(name, o)
  }

  private setCategory(spell: string): void {
    this.castCat = castCategory(spell)
    this.hands = CAST_HANDS[this.castCat]
    this.gpu.castSide = this.hands === 'left' ? 1 : this.hands === 'right' ? -1 : 0
  }

  private beginWindup(spell: string, ticks: number): void {
    this.castSpell = spell
    this.castTotal = Math.max(1, ticks)
    this.castT = 0
    this.castPhase = 'windup'
    this.gpu.castFizzle = 0
    this.setCategory(spell)
    const dur = ticks / 60
    // standing casts use the clip's legs too (wide, planted stance)
    this.castFullBody = this.standing()
    switch (this.castCat) {
      case 'directional':
      case 'ground':
      case 'beam':
        this.castClip('castEnter', { fade: 0.07, loop: false, timeScale: ENTER_LEN / Math.max(0.12, dur * 0.95), restart: true })
        break
      case 'sky':
        // overhand throw wound up to its peak (arm high), held until release
        this.castClip('throw', { fade: 0.08, loop: false, timeScale: THROW_PEAK / Math.max(0.12, dur * 0.9), restart: true })
        break
      default:
        // aoe / buff / move: procedural poses over the current clip
        this.castFullBody = false
    }
  }

  private release(spell: string): void {
    const instant = this.castPhase !== 'windup' || spell !== this.castSpell
    if (instant) {
      this.castFullBody = this.standing()
      this.setCategory(spell)
    }
    this.castSpell = spell
    this.gpu.castFlare = 1
    this.gpu.castCharge = 0
    this.gpu.castFizzle = 0
    this.releaseT = 0
    this.castPhase = 'release'
    switch (this.castCat) {
      case 'aoe':
        this.anim.full('slam', { fade: 0.06, loop: false, at: 0.1, timeScale: 1.25, restart: true })
        break
      case 'sky': {
        const a = this.anim.upper.current
        if (!instant && a && this.anim.upper.currentName === 'throw') {
          a.paused = false
          a.timeScale = 1.5
          const lo = this.anim.lower.current
          if (this.castFullBody && lo && this.anim.lower.currentName === 'throw') {
            lo.paused = false
            lo.timeScale = 1.5
          }
        } else this.castClip('throw', { fade: 0.04, loop: false, at: THROW_PEAK, timeScale: 1.5, restart: true })
        break
      }
      case 'buff':
        // procedural cross -> flare (see the stance block)
        break
      case 'move':
        this.castClip('castShoot', { fade: 0.03, loop: false, at: 0.05, timeScale: 2.6, restart: true })
        // lunge: kick the body lean forward
        this.tipVx += Math.cos(this.lastFacing) * 2.2
        this.tipVz += -Math.sin(this.lastFacing) * 2.2
        break
      default:
        this.castClip('castShoot', { fade: instant ? 0.04 : 0.05, loop: false, at: instant ? 0.02 : 0.06, timeScale: instant ? 2 : 1.7, restart: true })
    }
  }

  private endCast(fade: number): void {
    this.castPhase = 'none'
    const legs = this.castFullBody || this.castCat === 'aoe'
    if (legs) this.locomotion = ''
    else this.anim.upperFollow(fade)
    this.castFullBody = false
  }

  private fizzle(): void {
    if (this.castPhase !== 'windup') return
    if (!this.hidden) this.gpu.castFizzle = 1
    this.gpu.castCharge = 0
    this.endCast(0.12)
  }

  private die(kind: DeathKind, dx: number, dy: number, confirmed = false): void {
    const first = this.death.begin(confirmed)
    this.setDeathLook(kind, dx, dy)
    if (!first) return
    const continuingFall = this.tumbling
    this.castPhase = 'none'
    this.gpu.castCharge = 0
    this.tumbling = false
    this.launch.reset()
    this.victory = false
    this.victoryFacing = null
    this.deathSpin = 0
    this.anim.clearHits()
    const blown = (kind === 'fireball' || kind === 'meteor' || kind === 'gravity') && Math.hypot(dx, dy) > 1e-3
    this.thrownDeath = blown && !continuingFall && kind !== 'gravity'
    // A launch already has a falling body. Keep its exact clip pose on death.
    if (kind !== 'fade' && !continuingFall) this.anim.full(blown ? 'knockback' : 'death', { fade: 0.08, loop: false, restart: true, timeScale: blown ? 1.25 : 1.2 })
  }

  private setDeathLook(kind: DeathKind, dx: number, dy: number): void {
    this.deathKind = kind
    const l = Math.hypot(dx, dy)
    if (l > 1e-3) {
      this.tumbleDirX = dx / l
      this.tumbleDirY = dy / l
    }
    const g = this.gpu
    g.dissolveMode = kind === 'shadow' ? 1 : kind === 'fade' ? 2 : 0
    switch (kind) {
      case 'shadow':
        g.dissolveColor.setRGB(3.2, 0.25, 0.35)
        break
      case 'fade':
        g.dissolveColor.setRGB(0.18, 0.18, 0.2)
        break
      case 'lightning':
        g.dissolveColor.setRGB(2.2, 3.2, 6)
        break
      case 'freeze':
        g.dissolveColor.setRGB(2.6, 3.6, 4.8)
        break
      case 'gravity':
        g.dissolveColor.setRGB(2.6, 1.0, 5)
        break
      case 'drain':
        g.dissolveColor.setRGB(1.4, 3.2, 0.9)
        break
      default:
        g.dissolveColor.setRGB(4.5, 1.3, 0.25)
    }
  }

  private revive(): void {
    this.death.reset()
    const g = this.gpu
    g.dissolve = g.char = g.freeze = g.xray = g.wither = g.shadow = 0
    g.dissolveMode = 0
    this.yawG.position.y = 0
    this.yawG.scale.setScalar(1)
    this.tumbling = false
    this.launch.reset()
    this.victory = false
    this.victoryFacing = null
    this.locomotion = ''
    this.coat.reset()
    this.cape.reset()
    this.anim.full('idle', { fade: 0.05, restart: true })
  }

  /** Death look timeline (material fx, sink / shrink); returns false when the clip should freeze. */
  private deathTimeline(dt: number): boolean {
    const g = this.gpu
    const t = this.death.advance(dt)
    let animate = true
    let sink = 0
    let scale = 1
    switch (this.deathKind) {
      case 'lava':
        g.burn = 1
        g.char = ramp(t, 0.1, 1.3)
        sink = 0.75 * Math.pow(ramp(t, 0.1, 1.9), 1.6)
        scale = 1 - 0.18 * ramp(t, 0.3, 1.9)
        g.dissolve = ramp(t, 1.2, 2.1)
        break
      case 'fireball':
      case 'meteor':
        g.char = ramp(t, 0, 0.35)
        g.burn = Math.max(0, 1 - t / 0.9)
        g.dissolve = ramp(t, 0.9, 1.75)
        break
      case 'lightning':
        g.xray = t < 0.32 ? (Math.sin(t * 70) > -0.2 ? 1 : 0.2) * (1 - t / 0.32) : 0
        g.char = ramp(t, 0.25, 0.5)
        g.dissolve = ramp(t, 0.8, 1.5)
        break
      case 'freeze':
        g.freeze = ramp(t, 0, 0.25)
        animate = t < 0.12
        g.dissolve = ramp(t, 0.95, 1.15)
        break
      case 'gravity':
        this.deathSpin += dt * (4 + t * 14)
        scale = 1 - Math.pow(ramp(t, 0.15, 1.0), 1.5)
        g.xray = 0.35 * ramp(t, 0, 0.3) * (1 - ramp(t, 0.6, 1.0))
        g.dissolve = ramp(t, 0.85, 1.1)
        break
      case 'drain':
        g.wither = ramp(t, 0, 0.8)
        scale = 1 - 0.1 * ramp(t, 0, 0.8)
        g.dissolve = ramp(t, 1.0, 1.8)
        break
      case 'shadow':
        g.shadow = ramp(t, 0, 0.5)
        g.dissolve = ramp(t, 0.35, 1.5)
        break
      case 'fade':
        g.dissolve = ramp(t, 0.1, 1.3)
        break
      default:
        g.char = 0.6 * ramp(t, 0, 1.0)
        g.dissolve = ramp(t, 1.0, 1.9)
    }
    const thrown = this.thrownDeath
    const hop = thrown ? deathHop(t) * this.motionIntensity : 0
    const splat = thrown ? Math.max(0, 1 - Math.abs(t - 0.48) / 0.12) * this.motionIntensity : 0
    this.yawG.position.y = -sink + hop
    this.yawG.scale.set(Math.max(0.001, scale * (1 + 0.12 * splat)), Math.max(0.001, scale * (1 - 0.18 * splat)), Math.max(0.001, scale * (1 + 0.12 * splat)))
    return animate
  }

  // ------------------------------------------------------------------ frame

  update(p: PawnState, prev: PawnState | null, alpha: number, dtIn: number, events: readonly SimEvent[]): void {
    const dt = Math.min(Math.max(dtIn, 0), 0.1)
    this.t += dt
    const g = this.gpu
    this.footprint = syncFootprint(this.object3d, this.footprint)
    applyBuild(p, g, this.build)
    tickLevelUp(g, dt)
    for (let i = 0; i < events.length; i++) this.onEvent(events[i], p)
    if (!p.alive && !this.dead) this.die(p.lavaTicks > 0 ? 'lava' : 'ash', p.vx - p.walkVx, p.vy - p.walkVy)
    if (p.alive && this.dead && !this.death.confirmed) this.revive()
    if (this.victory && !this.dead && !this.tumbling) {
      this.victoryAge += dt
      sampleVictoryPose(this.victoryStyle, this.victoryAge, this.motionIntensity, this.victoryPose)
    }

    // a windup we missed the event for (late join, skipped snapshot)
    const running = !!p.cast && p.cast.started !== false
    if (running && this.castPhase !== 'windup' && !this.dead && !this.victory) this.beginWindup(p.cast!.spell, p.cast!.ticksLeft)
    // the sim dropped the cast without telling us: treat as a cancel
    if (!running && this.castPhase === 'windup') this.fizzle()
    // re-read every frame: the POV can change while spectating (frame.localPlayer -1 = spectator)
    this.hidden = this.castPhase === 'windup' && windupHiddenFrom(this.castSpell, p.owner, frame.localPlayer)

    // ---- kinematics (game units / s)
    const facing = prev ? lerpAngle(prev.facing, p.facing, alpha) : p.facing
    this.lastFacing = facing
    const walk = Math.hypot(p.walkVx, p.walkVy)
    const kbx = p.vx - p.walkVx
    const kby = p.vy - p.walkVy
    const kb = Math.hypot(kbx, kby)
    const dvx = p.vx - this.lastVx
    const dvy = p.vy - this.lastVy
    this.lastVx = p.vx
    this.lastVy = p.vy
    // acceleration from a smoothed velocity (sim velocity changes in tick steps)
    this.svx += (p.vx - this.svx) * damp(10, dt)
    this.svy += (p.vy - this.svy) * damp(10, dt)
    let ax = (this.svx - this.lastSvx) / Math.max(dt, 1e-3)
    let ay = (this.svy - this.lastSvy) / Math.max(dt, 1e-3)
    this.lastSvx = this.svx
    this.lastSvy = this.svy
    const al = Math.hypot(ax, ay)
    if (al > 2500) {
      ax *= 2500 / al
      ay *= 2500 / al
    }

    // ---- tumble (thrown off the feet by a big knockback)
    const launch = this.launch.step(kb, dt, !this.dead && this.castPhase === 'none' && !this.victory)
    if (launch === 'start') this.tumble(kbx, kby)
    if (launch === 'recover') {
      this.tumbling = false
      this.locomotion = ''
    }
    if (this.tumbling) {
      if (kb > 60) {
        this.tumbleDirX = kbx / kb
        this.tumbleDirY = kby / kb
      }
    }

    // ---- yaw: facing, or falling backwards along the push
    let yawTarget = facingToYaw(this.victory && this.victoryFacing !== null ? this.victoryFacing : facing)
    const blownDeath = this.dead && (this.deathKind === 'fireball' || this.deathKind === 'meteor' || this.deathKind === 'gravity')
    if (this.tumbling || blownDeath) yawTarget = facingToYaw(Math.atan2(-this.tumbleDirY, -this.tumbleDirX))
    if (!this.yawInit) {
      this.yaw = yawTarget
      this.yawInit = true
    }
    const yawPrev = this.yaw
    this.yaw = lerpAngle(this.yaw, yawTarget, damp(this.tumbling || blownDeath ? 12 : 22, dt))
    const dYaw = angDiff(yawPrev, this.yaw)
    this.yawG.rotation.y = this.yaw + this.deathSpin

    // ---- locomotion layer
    const castLocksLegs = this.castPhase !== 'none' && (this.castFullBody || (this.castCat === 'aoe' && this.castPhase !== 'windup'))
    if (!this.dead && !this.tumbling && !castLocksLegs && !this.victory) {
      const speedM = (walk * S) / CC0_SCALE.xz
      let want = 'idle'
      if (walk > 140) want = 'run'
      else if (walk > 25) want = 'walk'
      if (this.locomotion === 'run' && walk > 110) want = 'run'
      const ts = want === 'run' ? speedM / RUN_SPEED : want === 'walk' ? Math.max(0.6, speedM / WALK_SPEED) : 1
      if (want !== this.locomotion) {
        this.anim.lower.play(want, { fade: want === 'idle' ? 0.22 : 0.14, timeScale: ts })
        this.locomotion = want
        if ((this.castPhase === 'none' || this.hidden) && !this.victory) this.anim.upperFollow(want === 'idle' ? 0.22 : 0.14)
      } else {
        const a = this.anim.lower.current
        if (a) a.timeScale = ts
      }
    }

    // ---- cast phases
    if (this.castPhase === 'windup') {
      this.castT += dt
      const cast = p.cast
      const left = cast ? Math.max(0, cast.ticksLeft - alpha) : 0
      // hidden windup: no palm / sleeve / gem glow (VFX draws the faint cue)
      g.castCharge = this.hidden ? 0 : Math.min(1, Math.max(g.castCharge, 1 - left / this.castTotal))
      const enter = this.anim.upper.current
      if (enter && this.anim.upper.currentName === 'castEnter' && enter.time >= ENTER_LEN - 0.02) {
        this.castClip('castLoop', { fade: 0.2, loop: true })
      }
      // sky: hold the overhand throw at its peak (arm raised) until release
      if (enter && this.anim.upper.currentName === 'throw' && enter.time >= THROW_PEAK) {
        enter.paused = true
        const lo = this.anim.lower.current
        if (lo && this.anim.lower.currentName === 'throw') lo.paused = true
      }
      // a windup that starts moving (knockback slide) drops the planted legs
      if (this.castFullBody && walk > 30) {
        this.castFullBody = false
        this.locomotion = ''
      }
    } else if (this.castPhase === 'release') {
      this.releaseT += dt
      const cat = this.castCat
      if ((cat === 'directional' || cat === 'ground' || cat === 'beam' || cat === 'move') && this.releaseT > 0.24) {
        this.castPhase = 'backswing'
        this.castClip('castExit', { fade: 0.12, loop: false, timeScale: 1.25, restart: true })
      } else if (cat === 'aoe' && this.releaseT > 0.95) this.endCast(0.25)
      else if (cat === 'sky' && this.releaseT > 0.62) this.endCast(0.25)
      else if (cat === 'buff' && this.releaseT > 0.5) this.endCast(0.2)
      // Dota cancel: walking or a new order cuts the follow-through at once
      if (walk > 30 && this.releaseT > 0.06) this.endCast(0.1)
    } else if (this.castPhase === 'backswing') {
      this.releaseT += dt
      if (walk > 30 || this.releaseT > 0.24 + 0.34) this.endCast(walk > 30 ? 0.08 : 0.25)
    } else if (this.victory && !this.dead && !this.tumbling) {
      this.anim.full('castLoop', { fade: 0.35, loop: true, timeScale: this.motionIntensity > 0 ? 0.6 : 0 })
    } else if (!this.dead && !this.tumbling && this.anim.upper.currentName !== this.anim.lower.currentName) {
      this.anim.upperFollow(0.2)
    }
    if (this.castPhase !== 'windup') g.castCharge = Math.max(0, g.castCharge - dt * 8)
    g.castFlare *= Math.exp(-dt * 7)
    g.castFizzle *= Math.exp(-dt * 6)
    this.anim.syncUpper()

    // undo last frame's stance offsets so the mixer sees (and keeps) the clip pose
    for (const b of this.touched) b.quaternion.copy(this.savedQ.get(b)!)
    this.touched.length = 0
    const animate = this.dead ? this.deathTimeline(dt) : true
    if (!this.dead) {
      this.recoilT += dt
      this.yawG.position.y = !this.tumbling && this.recoilT < 0.2 ? Math.sin(Math.PI * this.recoilT / 0.2) * 0.045 * this.recoilK * this.motionIntensity : 0
      if (this.victory && !this.tumbling) this.yawG.position.y += this.victoryPose.bounce
    }
    // detail 2 (offscreen): the skeleton advances at ~15 Hz with the summed dt
    this.animAcc += dt
    if (animate && (this.detail < 2 || this.animAcc >= 1 / 15)) {
      this.anim.update(this.animAcc)
      this.animAcc = 0
    } else if (!animate) this.animAcc = 0
    // detail >= 1 (far / offscreen): secondary motion (cloth springs, front
    // envelope, capsules) every other frame with the summed dt
    this.secAcc += dt
    this.secTick = this.detail === 0 || (this.frameNo & 1) === 0
    const secDt = this.secTick ? this.secAcc : 0
    if (this.secTick) this.secAcc = 0

    // ---- torso twist: coil the casting shoulder back on windup, drive it through on release
    {
      let tw = 0
      if (this.castCat === 'directional' || this.castCat === 'ground' || this.castCat === 'move') {
        if (this.castPhase === 'windup') tw = 0.22 * g.castCharge
        else if (this.castPhase === 'release') tw = -0.38 * Math.min(1, this.releaseT / 0.08)
        else if (this.castPhase === 'backswing') tw = -0.38 * Math.max(0, 1 - this.releaseT / 0.5)
      }
      this.twist += (tw - this.twist) * damp(this.castPhase === 'release' ? 30 : 12, dt)
    }

    // ---- body lean: into acceleration, runs and turns; back against knockback
    {
      const fx = Math.cos(facing)
      const fz = -Math.sin(facing)
      const rx = -fz
      const rz = fx
      const walkN = Math.min(1, walk / 210)
      // accel in three space (game y -> -z): lean into it
      let tx = fx * 0.13 * walkN + ax * S * 0.0065
      let tz = fz * 0.13 * walkN + -ay * S * 0.0065
      // bank into turns (turning left -> lean left)
      const yawRate = dYaw / Math.max(dt, 1e-3)
      const bank = Math.max(-0.22, Math.min(0.22, -yawRate * 0.05 * walkN))
      tx += rx * bank
      tz += rz * bank
      if (!this.tumbling && kb > 40) {
        // lean back against the push (top trails the feet)
        const k = Math.min(0.42, kb / 1500)
        tx -= (kbx / kb) * k
        tz -= (-kby / kb) * k
      }
      if (this.dead || this.tumbling) {
        tx *= 0.15
        tz *= 0.15
      }
      // second-order follow for weight and a little overshoot
      const K = 80
      const C = 10
      this.tipVx += ((tx - this.tipX) * K - this.tipVx * C) * dt
      this.tipVz += ((tz - this.tipZ) * K - this.tipVz * C) * dt
      this.tipX += this.tipVx * dt
      this.tipZ += this.tipVz * dt
      const ang = Math.min(0.5, Math.hypot(this.tipX, this.tipZ))
      if (ang > 1e-4) {
        this.axis.set(this.tipZ, 0, -this.tipX).normalize()
        this.tilt.quaternion.setFromAxisAngle(this.axis, ang)
      } else this.tilt.quaternion.identity()
    }

    if (this.detail >= 2) {
      // offscreen: nothing visible depends on pose offsets, capsules or cloth
      this.frameNo++
      this.fxTick(p, dt)
      return
    }
    // ---- stance layered on the clips: hunched, powerful shoulders, arms held a
    // little away from the robe (wider top-down silhouette), torso twist on casts.
    // Rotations work in model space on local quaternions (no matrix updates);
    // one model.updateMatrixWorld follows.
    {
      const upright = !this.dead && !this.tumbling
      const castL = this.castPhase !== 'none' && !this.hidden ? 1 : 0
      this.stanceK += ((upright ? 1 : 0) - this.stanceK) * damp(6, dt)
      this.castArmK += (castL - this.castArmK) * damp(12, dt)
      const k = this.stanceK
      const X = this.axisX.set(1, 0, 0)
      const Y = this.axisY.set(0, 1, 0)
      const Z = this.axisZ.set(0, 0, 1)
      if (k > 1e-3) {
        this.rotBone('spine_02', X, 0.08 * k)
        this.rotBone('spine_03', X, 0.07 * k)
        this.rotBone('neck_01', X, -0.1 * k)
      }
      if (Math.abs(this.twist) > 1e-3) {
        this.rotBone('spine_02', Y, this.twist * 0.5)
        this.rotBone('spine_03', Y, this.twist * 0.5)
      }
      // procedural cast poses (smoothed weights; the clip carries the rest)
      const P = this.pose
      const ph = this.castPhase
      const cat = this.castCat
      const ch = g.castCharge
      const rt = this.releaseT
      const live = !this.dead && !this.tumbling
      const victory = live && this.victory ? this.victoryPose : null
      const tOverhead = victory ? victory.overhead : live && cat === 'aoe' && ph === 'windup' && !this.hidden ? Math.pow(Math.max(ch, 0.25), 0.6) : 0
      const tCross = victory ? victory.cross : live && cat === 'buff' && (ph === 'windup' || (ph === 'release' && rt < 0.09)) ? 1 : 0
      const tFlare = victory ? victory.flare : live && cat === 'buff' && ph === 'release' && rt >= 0.06 ? Math.max(0, 1 - Math.max(0, rt - 0.25) / 0.25) : 0
      const tBeam = victory ? victory.beam : live && cat === 'beam' && ph !== 'none' ? 1 : 0
      const tGround = live && cat === 'ground' && (ph === 'release' || ph === 'backswing') ? Math.max(0, 1 - Math.max(0, rt - 0.2) / 0.35) : 0
      const tSky = live && cat === 'sky' && ph === 'windup' ? ch : 0
      const rate = ph === 'release' ? 28 : 12
      const kk = damp(rate, dt)
      P.overhead += (tOverhead - P.overhead) * kk
      P.cross += (tCross - P.cross) * kk
      P.flare += (tFlare - P.flare) * kk
      P.beam += (tBeam - P.beam) * kk
      P.ground += (tGround - P.ground) * kk
      P.sky += (tSky - P.sky) * kk
      // idle ready pose weight: standing still, not casting / tumbling / celebrating
      const readyT = facingUniform.value > 0.5 && live && (this.castPhase === 'none' || this.hidden) && !this.victory && this.locomotion === 'idle' ? 1 : 0
      g.idleHands += (readyT - g.idleHands) * damp(readyT > g.idleHands ? 4 : 10, dt)
      const useL = this.hands !== 'right' ? this.castArmK : 0
      const useR = this.hands !== 'left' ? this.castArmK : 0
      if (k > 1e-3) {
        // resting arms held a little away from the robe (wider top-down read)
        this.rotBone('upperarm_l', Z, 0.13 * k * (1 - useL))
        this.rotBone('upperarm_r', Z, -0.13 * k * (1 - useR))
      }
      if (P.overhead > 1e-3) {
        // both hands rise overhead (a V), slightly forward
        this.rotBone('upperarm_l', Z, 2.75 * P.overhead)
        this.rotBone('upperarm_r', Z, -2.75 * P.overhead)
        this.rotBone('upperarm_l', X, -0.45 * P.overhead)
        this.rotBone('upperarm_r', X, -0.45 * P.overhead)
        this.rotBone('spine_03', X, -0.12 * P.overhead)
      }
      if (P.cross > 1e-3) {
        this.rotBone('upperarm_l', X, -1.1 * P.cross)
        this.rotBone('upperarm_r', X, -1.1 * P.cross)
        this.rotBone('upperarm_l', Y, -0.6 * P.cross)
        this.rotBone('upperarm_r', Y, 0.6 * P.cross)
      }
      if (P.flare > 1e-3) {
        this.rotBone('upperarm_l', Z, 1.5 * P.flare)
        this.rotBone('upperarm_r', Z, -1.5 * P.flare)
        this.rotBone('upperarm_l', X, 0.35 * P.flare)
        this.rotBone('upperarm_r', X, 0.35 * P.flare)
        this.rotBone('spine_03', X, -0.15 * P.flare)
      }
      if (P.beam > 1e-3) {
        // right hand joins the left's forward thrust (the clip drives the left)
        this.rotBone('upperarm_r', X, -1.45 * P.beam)
        this.rotBone('upperarm_r', Y, 0.24 * P.beam)
      }
      if (P.ground > 1e-3) {
        this.rotBone('upperarm_l', X, 0.7 * P.ground)
        this.rotBone('spine_03', X, 0.16 * P.ground)
      }
      if (P.sky > 1e-3) this.rotBone('upperarm_r', Z, -0.4 * P.sky)
      if (victory) {
        this.rotBone('spine_02', X, victory.bow * 0.6)
        this.rotBone('spine_03', X, victory.bow * 0.4)
        this.rotBone('pelvis', Z, victory.sway)
        this.rotBone('spine_02', Y, victory.twist)
        this.rotBone('spine_03', Z, -victory.sway * 0.6)
        this.rotBone('thigh_l', X, victory.knee)
        this.rotBone('thigh_r', X, -victory.knee)
        this.rotBone('calf_l', X, Math.max(0, -victory.knee) * 0.8)
        this.rotBone('calf_r', X, Math.max(0, victory.knee) * 0.8)
        this.rotBone('upperarm_l', X, victory.armWave)
        this.rotBone('upperarm_r', X, -victory.armWave)
        this.rotBone('lowerarm_l', X, -victory.elbowL)
        this.rotBone('lowerarm_r', X, -victory.elbowR)
      }
      // facing cue: standing idle, both hands come up in front of the robe (a
      // ready stance) with a faint glow; from above they point the way
      const ih = g.idleHands
      if (ih > 1e-3) {
        this.rotBone('upperarm_l', X, -0.42 * ih)
        this.rotBone('upperarm_r', X, -0.42 * ih)
        this.rotBone('lowerarm_l', X, -0.75 * ih)
        this.rotBone('lowerarm_r', X, -0.75 * ih)
        this.rotBone('upperarm_l', Y, -0.18 * ih)
        this.rotBone('upperarm_r', Y, 0.18 * ih)
      }
    }

    // ---- bones -> capsules (model metres), from local matrices of just these
    // chains: the renderer does the one full matrix update of the hierarchy
    this.frameNo++
    this.boneModelPos('thigh_l', g.hipL)
    this.boneModelPos('calf_l', g.kneeL)
    this.boneModelPos('foot_l', g.footL)
    this.boneModelPos('thigh_r', g.hipR)
    this.boneModelPos('calf_r', g.kneeR)
    this.boneModelPos('foot_r', g.footR)
    this.boneModelPos('pelvis', g.pelvis)
    this.boneModelPos('spine_03', g.chest)
    this.boneModelPos('upperarm_l', g.armL0)
    this.boneModelPos('lowerarm_l', g.armL1)
    this.boneModelPos('upperarm_r', g.armR0)
    this.boneModelPos('lowerarm_r', g.armR1)
    g.eyes.setFromMatrixPosition(this.modelMatrixOf(this.eyeSocket))
    if (this.secTick) this.updateFrontEnvelope(secDt)

    // ---- cloth springs: world velocity -> model local
    {
      const c = Math.cos(this.yaw)
      const s = Math.sin(this.yaw)
      this.toLocalVel(p.vx, p.vy, c, s, this.vel)
      this.toLocalVel(dvx, dvy, c, s, this.dvel)
      this.accYaw += dYaw
      if (this.secTick) {
        this.stepSpring(this.coat, this.accYaw, secDt)
        this.stepSpring(this.cape, this.accYaw, secDt)
        this.accYaw = 0
      }
      g.swayCoat.set(this.coat.x, 0, this.coat.z)
      g.swayCape.set(this.cape.x, 0, this.cape.z)
      this.flutterKick *= Math.exp(-dt * 2.5)
      const speed = Math.hypot(p.vx, p.vy)
      const turn = Math.min(1, Math.abs(dYaw) / Math.max(dt, 1e-3) / 8)
      const fTarget = Math.max(0.12, Math.min(1, speed / 300), turn * 0.8, this.flutterKick, this.tumbling ? 1.2 : 0)
      g.flutter += (fTarget - g.flutter) * damp(5, dt)
    }

    // ---- staff: follows the right hand, stays upright-ish, leans out from the robe
    if (this.staffMesh) this.placeStaff()

    this.fxTick(p, dt)
  }

  private fxTick(p: PawnState, dt: number): void {
    const g = this.gpu
    g.flash = Math.max(0, g.flash - dt / 0.2)
    if (!this.dead) {
      g.burn += ((p.alive && p.lavaTicks > 0 ? 1 : 0) - g.burn) * damp(8, dt)
      g.invuln += ((p.invulnerable ? 1 : 0) - g.invuln) * damp(10, dt)
    }
    g.runeBoost += ((this.victory ? 2.4 : 1) - g.runeBoost) * damp(3, dt)
  }

  /**
   * Level of detail, set by the owner each frame or when it changes:
   * 0 = full (default), 1 = far (secondary motion at half rate),
   * 2 = offscreen (skeleton at ~15 Hz, no pose layer / capsules / cloth).
   */
  setDetail(level: 0 | 1 | 2): void {
    this.detail = level
  }
  private detail: 0 | 1 | 2 = 0
  private animAcc = 0
  private secAcc = 0
  private secTick = true
  private accYaw = 0

  private stanceK = 1
  private lastFacing = 0
  private castArmK = 0
  private axisX = new THREE.Vector3()
  private axisY = new THREE.Vector3()
  private axisZ = new THREE.Vector3()

  /** clip pose of bones the stance layer touched this frame (restored before the next mixer update) */
  private savedQ = new Map<THREE.Bone, THREE.Quaternion>()
  private touched: THREE.Bone[] = []

  /**
   * Rotate a bone about a model-space axis, after the clips. The bone's parent
   * orientation in model space comes from multiplying the local quaternions down
   * its chain (no matrix updates; ancestors rotated earlier this frame count).
   * The clip value is saved and put back before the next mixer update: the
   * mixer only writes bones whose value changed, so an offset left in place
   * would accumulate every frame (time frozen, held poses).
   */
  private rotBone(name: string, axisModel: THREE.Vector3, angle: number): void {
    const bone = this.bone[name]
    if (!this.touched.includes(bone)) {
      let q = this.savedQ.get(bone)
      if (!q) this.savedQ.set(bone, (q = new THREE.Quaternion()))
      q.copy(bone.quaternion)
      this.touched.push(bone)
    }
    this.modelQuat(bone.parent!, this.qb)
    this.axis.copy(axisModel).applyQuaternion(this.qb.invert()).normalize()
    bone.quaternion.premultiply(this.qt.setFromAxisAngle(this.axis, angle))
  }

  /** ancestors of a node below the model, root first (cached) */
  private chains = new Map<THREE.Object3D, THREE.Object3D[]>()
  private chainOf(o: THREE.Object3D): THREE.Object3D[] {
    let c = this.chains.get(o)
    if (!c) {
      c = []
      for (let n: THREE.Object3D | null = o; n && n !== this.model; n = n.parent) c.unshift(n)
      this.chains.set(o, c)
    }
    return c
  }

  /** orientation of a node in model space from the local quaternions */
  private modelQuat(o: THREE.Object3D, out: THREE.Quaternion): THREE.Quaternion {
    out.identity()
    const c = this.chainOf(o)
    for (let i = 0; i < c.length; i++) out.multiply(c[i].quaternion)
    return out
  }

  /** per-frame model-space matrices of the few nodes the cloth / sockets need (memoized) */
  private mm = new Map<THREE.Object3D, { m: THREE.Matrix4; f: number }>()
  private frameNo = 0
  private modelMatrixOf(o: THREE.Object3D): THREE.Matrix4 {
    let e = this.mm.get(o)
    if (!e) this.mm.set(o, (e = { m: new THREE.Matrix4(), f: -1 }))
    if (e.f === this.frameNo) return e.m
    e.m.compose(o.position, o.quaternion, o.scale)
    if (o.parent && o.parent !== this.model) e.m.premultiply(this.modelMatrixOf(o.parent))
    e.f = this.frameNo
    return e.m
  }

  private boneModelPos(name: string, out: THREE.Vector3): THREE.Vector3 {
    return out.setFromMatrixPosition(this.modelMatrixOf(this.bone[name]))
  }

  /** world (game) velocity -> model-local metres / s (no allocation) */
  private toLocalVel(gx: number, gy: number, c: number, s: number, out: { x: number; z: number }): void {
    const wx = gx * S
    const wz = -gy * S
    out.x = (wx * c - wz * s) / CC0_SCALE.xz
    out.z = (wx * s + wz * c) / CC0_SCALE.xz
  }

  private stepSpring(sp: HemSpring, dYaw: number, dt: number): void {
    // the body turned under the cloth: it keeps most of its world heading
    sp.rotate(-dYaw * 0.75)
    // sudden velocity change: cloth keeps going (impulses, stops, knockback)
    sp.vx -= this.dvel.x * sp.couple
    sp.vz -= this.dvel.z * sp.couple
    sp.step(dt, this.vel.x, this.vel.z)
  }

  /** knee / hem envelope springs per leg (L knee, L hem, R knee, R hem) */
  private env: EnvelopeState[] = [
    { x: 0, v: 0 },
    { x: 0, v: 0 },
    { x: 0, v: 0 },
    { x: 0, v: 0 },
  ]
  private envInit = false

  /**
   * How far forward the robe front must clear each leg at knee and hem height
   * (model metres), from the live bones, then spring-smoothed: the front
   * panels follow a striding leg like cloth (quick out, slower settle) instead
   * of snapping to it every frame.
   */
  private updateFrontEnvelope(dt: number): void {
    const g = this.gpu
    const r = clothParams.calfR.value + 0.035
    const HEM_Y = 0.12
    const leg = (knee: THREE.Vector3, foot: THREE.Vector3, out: THREE.Vector4, i: number) => {
      const kneeZ = knee.z + r
      // shin line extended to the hem height (the panel hangs off the shin / foot)
      const t = (knee.y - HEM_Y) / Math.max(0.05, knee.y - foot.y)
      const hemZ = Math.max(knee.z + (foot.z - knee.z) * Math.min(1.3, t) + r, kneeZ - 0.25)
      if (!this.envInit) {
        out.set(knee.y, kneeZ, hemZ, 0)
        return
      }
      out.x += (knee.y - out.x) * damp(25, dt)
      // substepped + clamped (frontEnvelope.ts): dt here can be a summed
      // half-rate step at reduced detail, where a plain explicit step diverged
      const ek = this.env[i * 2]
      const eh = this.env[i * 2 + 1]
      ek.x = out.y
      eh.x = out.z
      stepEnvelope(ek, kneeZ, dt)
      stepEnvelope(eh, hemZ, dt)
      out.y = ek.x
      out.z = eh.x
    }
    leg(g.kneeL, g.footL, g.frontL, 0)
    leg(g.kneeR, g.footR, g.frontR, 1)
    this.envInit = true
  }

  private grip = new THREE.Vector3()
  private up = new THREE.Vector3()
  private staffQ = new THREE.Quaternion()
  private Y = new THREE.Vector3(0, 1, 0)

  private placeStaff(): void {
    const m = this.staffMesh!
    // grip point in model-local metres (staff is a child of the model)
    this.grip.setFromMatrixPosition(this.modelMatrixOf(this.bone.hand_r))
    const pelvis = this.gpu.pelvis
    // outward from the body axis, upright, a little forward
    const ox = this.grip.x - pelvis.x
    const oz = this.grip.z - pelvis.z
    const ol = Math.hypot(ox, oz) || 1
    this.up.set((ox / ol) * 0.22, 1, (oz / ol) * 0.22 + 0.08).normalize()
    if (this.castFrom === 'staff' && this.castPhase !== 'none') {
      // staff casting: tip swings toward the target with the charge / release
      const k = Math.max(this.gpu.castCharge * 0.6, this.castPhase === 'release' ? 1 : 0)
      this.up.lerp(this.v3.set(0, 0.55, 1).normalize(), k).normalize()
    }
    // keep it at least 0.3 m off the body axis so it never cuts the coat
    if (ol < 0.3) {
      this.grip.x = pelvis.x + (ox / ol) * 0.3
      this.grip.z = pelvis.z + (oz / ol) * 0.3
    }
    // never below the floor: slide the staff up through the hand
    const footY = this.grip.y - this.up.y * this.staffBelow
    if (footY < 0.02) this.grip.addScaledVector(this.up, (0.02 - footY) / Math.max(0.2, this.up.y))
    this.staffQ.setFromUnitVectors(this.Y, this.up)
    // the staff is a child of the model: model-local metres, scaled with the rig
    m.position.copy(this.grip)
    m.quaternion.copy(this.staffQ)
  }

  dispose(): void {
    this.anim.mixer.stopAllAction()
    this.anim.mixer.uncacheRoot(this.model)
    this.object3d.removeFromParent()
  }
}
