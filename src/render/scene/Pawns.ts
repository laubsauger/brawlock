import * as THREE from 'three/webgpu'
import { abs, cos, exp, float, length, max, mix, positionGeometry, saturate, sin, smoothstep, step, uniform, vec2, vec3 } from 'three/tsl'
import type { PawnState, PlayerSlot } from '../../sim/types'
import { isLocationSafe } from '../arenaGeom'
import { LAVA_H, S, TILE_TOP_H, facingToYaw } from '../coords'
import { MODEL_SCALE, STAFF_PIVOT, STAFF_TIP, createPawnMaterial, getBodyGeometry, getStaffGeometry, type PawnUniforms } from './pawnModel'
import type { WorldCtx } from './world'

const DEATH_DUR = 0.9
const FLASH_DUR = 0.14
const DECAL_R = 70
const CHARGE_R = 250
const SCOURGE_RADIUS = 250

const makeF = () => uniform(0)
const makeC = () => uniform(new THREE.Color())

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}

/** Interpolated read of one pawn this frame (filled in place, no allocation). */
export interface PawnSample {
  x: number
  y: number
  facing: number
}

export function samplePawn(prev: PawnState | undefined, curr: PawnState, alpha: number, out: PawnSample): PawnSample {
  if (!prev) {
    out.x = curr.x
    out.y = curr.y
    out.facing = curr.facing
    return out
  }
  const dx = curr.x - prev.x
  const dy = curr.y - prev.y
  // teleports and respawns snap instead of sliding across the arena
  if (dx * dx + dy * dy > 300 * 300) {
    out.x = curr.x
    out.y = curr.y
    out.facing = curr.facing
    return out
  }
  out.x = prev.x + dx * alpha
  out.y = prev.y + dy * alpha
  out.facing = lerpAngle(prev.facing, curr.facing, alpha)
  return out
}

/** One warlock on screen. */
export class PawnView {
  readonly root = new THREE.Group()
  private tilt = new THREE.Group()
  private yawG = new THREE.Group()
  private bob = new THREE.Group()
  private staffPivot = new THREE.Group()
  private body: THREE.Mesh
  private staff: THREE.Mesh
  private decal: THREE.Mesh
  private charge: THREE.Mesh
  private u: PawnUniforms
  private material: THREE.MeshStandardNodeMaterial
  private decalMat: THREE.MeshBasicNodeMaterial
  private chargeMat: THREE.MeshBasicNodeMaterial
  private dTeam = makeC()
  private dKb = makeF()
  private dAlpha = makeF()
  private cProgress = makeF()
  private cAlpha = makeF()
  private cColor = makeC()

  // render state
  x = 0
  y = 0
  h = TILE_TOP_H
  alive = true
  hp = 0
  maxHp = 1
  owner = -1
  name = ''
  color = new THREE.Color()
  onLava = false
  kbPoints = 0
  private yaw = 0
  private walkPhase = 0
  private spin = 0
  private burn = 0
  private invuln = 0
  private flashAt = -10
  private deathAt = -1
  private castSpell = ''
  private castTotal = 1
  private castProgress = 0
  private releaseAt = -10
  private hadCast = false
  private fizzleAt = -10
  private castTarget = { x: 0, y: 0 }
  /** called once when a windup ends without a release (cancel / fake) */
  onFizzle: ((v: PawnView) => void) | null = null
  private aim: THREE.Mesh
  private aimMat: THREE.MeshBasicNodeMaterial
  private aR = makeF()
  private aDir = makeF()
  private aLen = makeF()
  private aWidth = makeF()
  private aRange = makeF()
  private aAoe = makeF()
  private aAlpha = makeF()
  private aColor = makeC()
  /** targeting preview for the local player (set by the world each frame) */
  readonly aimPreview = { active: false, range: 0, radius: 0, tx: 0, ty: 0 }
  // cloth spring state (game units, world axes)
  private clothX = 0
  private clothY = 0
  private clothVx = 0
  private clothVy = 0
  private flutter = 0
  private flutterKick = 0
  private axis = new THREE.Vector3()
  private q = new THREE.Quaternion()
  private tipW = new THREE.Vector3()
  seen = 0

  constructor(private ctx: WorldCtx) {
    const { material, u } = createPawnMaterial(ctx)
    this.material = material
    this.u = u
    u.phase.value = Math.random() * 100
    this.body = new THREE.Mesh(getBodyGeometry(), material)
    this.staff = new THREE.Mesh(getStaffGeometry(), material)
    this.staffPivot.position.copy(STAFF_PIVOT).multiplyScalar(S * MODEL_SCALE)
    this.staffPivot.add(this.staff)
    this.bob.add(this.body, this.staffPivot)
    this.yawG.add(this.bob)
    this.tilt.add(this.yawG)
    this.root.add(this.tilt)

    // ground decal: soft contact shadow + team ring + knockback aura
    {
      const q = positionGeometry.xy
      const rr = length(q).mul(DECAL_R)
      // contact shadow: dense core right under the feet + a soft skirt
      const shadowA = float(1).sub(smoothstep(6, 26, rr)).mul(0.45).add(float(1).sub(smoothstep(10, 50, rr)).mul(0.4))
      const ringX = rr.sub(39).div(3)
      const ring = exp(ringX.mul(ringX).negate())
      const auraR = this.dKb.mul(14).add(48)
      const auraX = rr.sub(auraR).div(this.dKb.mul(8).add(4))
      const aura = exp(auraX.mul(auraX).negate()).mul(this.dKb)
      const glow = saturate(ring.add(aura.mul(0.7)))
      const pulse = sin(ctx.uTime.mul(6)).mul(0.15).add(0.85)
      // warm contact light just outside the shadow core: lava-lit floor around the hem
      const warmX = rr.sub(44).div(14)
      const warm = exp(warmX.mul(warmX).negate()).mul(0.22)
      const col = this.dTeam.mul(ring.mul(2.4).add(aura.mul(pulse).mul(this.dKb.mul(3).add(1)))).add(vec3(1.0, 0.42, 0.12).mul(warm))
      const a = max(shadowA.mul(float(1).sub(glow)), glow).mul(this.dAlpha)
      const m = new THREE.MeshBasicNodeMaterial()
      m.transparent = true
      m.depthWrite = false
      m.premultipliedAlpha = true
      m.colorNode = col.mul(this.dAlpha)
      m.opacityNode = a
      m.name = 'PawnDecal'
      m.positionNode = groundQuadPosition(DECAL_R)
      this.decalMat = m
      this.decal = new THREE.Mesh(groundQuad(), m)
      this.decal.renderOrder = 2
      this.decal.frustumCulled = false
    }

    // scourge windup: AoE edge plus a charge front sweeping out to it
    {
      const q = positionGeometry.xy
      const rr = length(q).mul(CHARGE_R + 40)
      const edgeX = rr.sub(SCOURGE_RADIUS).div(5)
      const edge = exp(edgeX.mul(edgeX).negate())
      const front = this.cProgress.mul(SCOURGE_RADIUS)
      const frontX = rr.sub(front).div(10)
      const frontRing = exp(frontX.mul(frontX).negate())
      const fill = float(1).sub(smoothstep(front.sub(4), front, rr)).mul(0.18)
      const flick = sin(ctx.uTime.mul(40)).mul(0.1).add(0.9)
      const inten = edge.mul(this.cProgress.mul(1.2).add(0.5)).add(frontRing.mul(1.4)).add(fill).mul(flick).mul(this.cAlpha)
      const m = new THREE.MeshBasicNodeMaterial()
      m.transparent = true
      m.depthWrite = false
      m.blending = THREE.AdditiveBlending
      m.colorNode = mix(this.cColor, vec3(1.4, 1.2, 2.6), 0.4).mul(inten)
      m.opacityNode = float(1)
      m.name = 'ScourgeCharge'
      m.positionNode = groundQuadPosition(CHARGE_R + 40)
      this.chargeMat = m
      this.charge = new THREE.Mesh(groundQuad(), m)
      this.charge.renderOrder = 3
      this.charge.frustumCulled = false
      this.charge.visible = false
    }
    // aim decal: windup telegraph arrow (every pawn) and the local targeting
    // preview (range ring, aim line, AoE circle at the end)
    {
      const q = positionGeometry.xy
      const pg = q.mul(this.aR)
      const c = cos(this.aDir)
      const sn = sin(this.aDir)
      const px = pg.x.mul(c).add(pg.y.mul(sn))
      const py = pg.y.mul(c).sub(pg.x.mul(sn))
      const along = saturate(px.div(max(this.aLen, 1)))
      const inLine = step(0, px).mul(step(px, this.aLen))
      const halfW = this.aWidth.mul(float(1).sub(along.mul(0.35)))
      const line = float(1).sub(smoothstep(halfW.mul(0.6), halfW, abs(py))).mul(inLine).mul(along.mul(0.6).add(0.4))
      // arrowhead at the tip
      const tipX = this.aLen.sub(px)
      const head = float(1)
        .sub(smoothstep(0, 6, abs(abs(py).sub(tipX.mul(0.8)))))
        .mul(step(0, tipX))
        .mul(step(tipX, this.aWidth.mul(3)))
      const rr = length(pg)
      const ringX = rr.sub(this.aRange).div(4)
      const ring = exp(ringX.mul(ringX).negate()).mul(step(1, this.aRange))
      const end = vec2(c.mul(this.aLen), sn.mul(this.aLen))
      const ae = length(pg.sub(end)).sub(this.aAoe).div(4)
      const aoe = exp(ae.mul(ae).negate()).mul(step(1, this.aAoe))
      const inten = max(max(line.mul(0.55), head), max(ring.mul(0.7), aoe)).mul(this.aAlpha)
      const m = new THREE.MeshBasicNodeMaterial()
      m.transparent = true
      m.depthWrite = false
      m.blending = THREE.AdditiveBlending
      m.colorNode = this.aColor.mul(inten).mul(1.8)
      m.opacityNode = float(1)
      m.name = 'AimDecal'
      m.positionNode = vec3(positionGeometry.x.mul(this.aR).mul(S), 0, positionGeometry.y.mul(this.aR).mul(-S))
      this.aimMat = m
      this.aim = new THREE.Mesh(groundQuad(), m)
      this.aim.renderOrder = 3
      this.aim.frustumCulled = false
      this.aim.visible = false
    }
    this.root.add(this.decal, this.charge, this.aim)
  }

  setShadows(on: boolean): void {
    this.body.castShadow = on
    this.staff.castShadow = on
  }

  setSlot(slot: PlayerSlot | undefined, owner: number): void {
    this.owner = owner
    const c = slot ? slot.color : 0xcccccc
    this.color.setHex(c)
    this.u.team.value.copy(this.color)
    this.dTeam.value.copy(this.color)
    this.cColor.value.copy(this.color)
    this.name = slot?.name ?? ''
  }

  hit(now: number): void {
    this.flashAt = now
  }

  /** Damage impulse along the knockback direction: the robe snaps back against it. */
  impulse(dx: number, dy: number, kb: number): void {
    const k = Math.min(1600, kb) * 0.22
    this.clothVx -= dx * k
    this.clothVy -= dy * k
    this.flutterKick = Math.min(1.5, this.flutterKick + kb / 1200)
  }

  castStart(spell: string, ticks: number): void {
    this.castSpell = spell
    this.castTotal = Math.max(1, ticks)
  }

  castRelease(now: number): void {
    this.releaseAt = now
    this.hadCast = false
  }

  /** Sim told us the windup was cancelled (castCancel event). */
  castCancel(now: number): void {
    if (now - this.fizzleAt > 0.3) this.fizzle(now)
    this.hadCast = false
  }

  private fizzle(now: number): void {
    this.fizzleAt = now
    this.releaseAt = -10
    this.onFizzle?.(this)
  }

  /** World position of the staff crystal (for flares). */
  tipWorld(out: THREE.Vector3): THREE.Vector3 {
    this.tipW.copy(STAFF_TIP).multiplyScalar(S * MODEL_SCALE)
    return this.staff.localToWorld(out.copy(this.tipW))
  }

  /** 0..1 progress of the current windup (for flares). */
  get castFraction(): number {
    return this.castProgress
  }

  /** The pawn vanished from state without a death event: dissolve it out. */
  forceDeath(now: number): void {
    if (this.deathAt < 0) this.deathAt = now
  }

  /** Advance only the death dissolve (pawn no longer in state). */
  tick(now: number): void {
    const dis = this.deathAt >= 0 ? Math.min(1, (now - this.deathAt) / DEATH_DUR) : 0
    this.u.dissolve.value = dis
    this.dAlpha.value = 1 - dis
    this.body.visible = this.staff.visible = dis < 1
    this.charge.visible = false
  }

  get dead(): boolean {
    return this.deathAt >= 0
  }

  get deathDone(): boolean {
    return this.deathAt >= 0 && this.ctx.uTime.value - this.deathAt > DEATH_DUR
  }

  update(p: PawnState, s: PawnSample, layer: number, now: number, dt: number): void {
    this.x = s.x
    this.y = s.y
    this.hp = p.hp
    this.maxHp = p.maxHp
    this.alive = p.alive
    const safe = isLocationSafe(s.x, s.y, layer)
    this.onLava = !safe
    const k = 1 - Math.exp(-dt * 14)

    if (!p.alive && this.deathAt < 0) this.deathAt = now
    if (p.alive && this.deathAt >= 0) {
      // respawn
      this.deathAt = -1
      this.spin = 0
    }

    const targetH = safe ? TILE_TOP_H : LAVA_H - 16
    this.h += (targetH - this.h) * (safe ? 1 - Math.exp(-dt * 30) : k * 0.6)
    this.root.position.set(s.x * S, this.h * S, -s.y * S)

    // knockback lean and tumble (physics velocity without the walk part)
    const kx = p.vx - p.walkVx
    const ky = p.vy - p.walkVy
    const kmag = Math.hypot(kx, ky)
    const lean = Math.min(0.55, kmag / 1300)
    if (lean > 0.01) {
      // lean back against the push: rotate about the horizontal axis perpendicular to it
      this.axis.set(-ky / kmag, 0, -kx / kmag)
      this.q.setFromAxisAngle(this.axis, -lean)
      this.tilt.quaternion.slerp(this.q, k)
    } else {
      this.tilt.quaternion.slerp(this.q.identity(), k)
    }
    if (kmag > 850) this.spin += dt * Math.min(18, kmag / 110)
    else this.spin = lerpAngle(this.spin, Math.round(this.spin / (Math.PI * 2)) * Math.PI * 2, k * 0.5)
    this.yaw = lerpAngle(this.yaw, facingToYaw(s.facing), 1 - Math.exp(-dt * 30))
    this.yawG.rotation.y = this.yaw + this.spin

    // cloth: hem trails opposite to velocity through an underdamped spring,
    // so knockback snaps it back and stopping makes it swing past and settle
    {
      const cdt = Math.min(dt, 1 / 30)
      let tx = -p.vx * 0.024
      let ty = -p.vy * 0.024
      const tl = Math.hypot(tx, ty)
      if (tl > 16) {
        tx *= 16 / tl
        ty *= 16 / tl
      }
      this.clothVx += ((tx - this.clothX) * 110 - this.clothVx * 9) * cdt
      this.clothVy += ((ty - this.clothY) * 110 - this.clothVy * 9) * cdt
      this.clothX += this.clothVx * cdt
      this.clothY += this.clothVy * cdt
      // world (game) -> three world -> model-local (undo yaw)
      const wx = this.clothX * S
      const wz = -this.clothY * S
      const yawT = this.yawG.rotation.y
      const c = Math.cos(yawT)
      const sn = Math.sin(yawT)
      this.u.sway.value.set(wx * c - wz * sn, 0, wx * sn + wz * c)
      const speed = Math.hypot(p.vx, p.vy)
      const tumbling = kmag > 850 ? 1.2 : 0
      this.flutterKick *= Math.exp(-dt * 3)
      const fTarget = Math.max(Math.min(1, speed / 650), tumbling, this.flutterKick)
      this.flutter += (fTarget - this.flutter) * (1 - Math.exp(-dt * 6))
      this.u.flutter.value = this.flutter
    }

    // walk cycle
    const walk = Math.hypot(p.walkVx, p.walkVy)
    this.walkPhase += dt * walk * 0.055
    const amp = Math.min(1, walk / 200)
    this.bob.position.y = Math.abs(Math.sin(this.walkPhase)) * 3.5 * S * amp
    this.bob.rotation.z = Math.sin(this.walkPhase) * 0.06 * amp
    this.bob.rotation.x = 0.08 * amp

    // casting, three visual phases (Dota feel):
    //  windup   - staff lifts, crystal charges, telegraph decal
    //  release  - on the 'cast' event: thrust + flash, then a short backswing
    //  cancel   - backswing is cut the instant the pawn walks or casts again;
    //             a windup that ends without a release fizzles out fast
    const walking = walk > 20
    // a cast that is still turning to face its target has not started its windup
    const running = !!p.cast && p.cast.started !== false
    if (p.cast && running) {
      if (p.cast.spell !== this.castSpell || !this.hadCast) {
        this.castStart(p.cast.spell, p.cast.ticksLeft)
        this.releaseAt = -10 // a new cast cuts any backswing
      }
      this.castTotal = Math.max(this.castTotal, p.cast.ticksLeft)
      this.castProgress = 1 - p.cast.ticksLeft / this.castTotal
      this.castTarget.x = p.cast.x
      this.castTarget.y = p.cast.y
    } else {
      if (this.hadCast && now - this.releaseAt > 0.08 && now - this.fizzleAt > 0.3) this.fizzle(now)
      const fizzling = now - this.fizzleAt < 0.25
      this.castProgress = Math.max(0, this.castProgress - dt * (fizzling ? 14 : 6))
      if (this.castProgress === 0) this.castSpell = ''
    }
    this.hadCast = running
    if (walking && !p.cast && now - this.releaseAt > 0.05) this.releaseAt = -10
    const relT = (now - this.releaseAt) / 0.35
    const rel = relT >= 0 && relT < 1 ? (relT < 0.2 ? relT / 0.2 : 1 - (relT - 0.2) / 0.8) : 0
    this.staffPivot.rotation.x = -this.castProgress * 0.75 + rel * 0.65
    this.staffPivot.rotation.z = -this.castProgress * 0.15 - rel * 0.1
    this.bob.rotation.x += rel * 0.12 - this.castProgress * 0.05
    this.u.cast.value = Math.min(1.5, this.castProgress + rel * 1.2)

    // scourge windup decal (fades fast on cancel instead of popping)
    const scourge = running && p.cast!.spell.startsWith('scourge')
    if (scourge) {
      this.cProgress.value = this.castProgress
      this.cAlpha.value = 1
    } else {
      this.cAlpha.value = Math.max(0, this.cAlpha.value - dt * 7)
    }
    this.charge.visible = this.cAlpha.value > 0.01
    this.charge.position.y = (TILE_TOP_H - this.h + 1.5) * S

    // aim decal: local targeting preview wins over the windup arrow
    const ap = this.aimPreview
    if (ap.active && p.alive) {
      const dx = ap.tx - s.x
      const dy = ap.ty - s.y
      const d = Math.min(Math.hypot(dx, dy), ap.range)
      this.aDir.value = Math.atan2(dy, dx)
      this.aLen.value = d
      this.aWidth.value = 10
      this.aRange.value = ap.range
      this.aAoe.value = ap.radius
      this.aAlpha.value = 0.55
      this.aColor.value.setRGB(0.55, 0.9, 0.6)
      this.aR.value = Math.max(ap.range, d + ap.radius) + 40
      this.aim.visible = true
    } else if (running && !scourge && p.alive) {
      const dx = this.castTarget.x - s.x
      const dy = this.castTarget.y - s.y
      this.aDir.value = Math.atan2(dy, dx)
      this.aLen.value = 90 + this.castProgress * 190
      this.aWidth.value = 13
      this.aRange.value = 0
      this.aAoe.value = 0
      this.aAlpha.value = 0.5 + this.castProgress * 0.5
      this.aColor.value.copy(this.color)
      this.aR.value = 330
      this.aim.visible = true
    } else {
      this.aim.visible = false
    }
    this.aim.position.y = ((safe ? TILE_TOP_H : LAVA_H) - this.h + 1.2) * S

    this.burn += ((this.onLava && p.alive ? 1 : 0) - this.burn) * (1 - Math.exp(-dt * 8))
    this.invuln += ((p.invulnerable ? 1 : 0) - this.invuln) * k
    this.u.burn.value = this.burn
    this.u.invuln.value = this.invuln
    this.u.flash.value = Math.max(0, 1 - (now - this.flashAt) / FLASH_DUR)

    const dying = this.deathAt >= 0
    const dis = dying ? Math.min(1, (now - this.deathAt) / DEATH_DUR) : 0
    this.u.dissolve.value = dis
    this.body.visible = this.staff.visible = dis < 1

    this.dKb.value = Math.min(1, p.kbPoints / 1500)
    this.dAlpha.value = dying ? 1 - dis : 1
    this.decal.visible = !dying || dis < 1
    // decal sits on the floor even while the body sinks into lava
    this.decal.position.y = ((safe ? TILE_TOP_H : LAVA_H) - this.h + 1) * S
  }

  dispose(): void {
    this.material.dispose()
    this.decalMat.dispose()
    this.chargeMat.dispose()
    this.aimMat.dispose()
    this.decal.geometry.dispose()
    this.charge.geometry.dispose()
    this.aim.geometry.dispose()
  }
}

/**
 * Ground-aligned quad: positionGeometry.xy spans -1..1 (shaders use it as the
 * radial coordinate) and the material scales it to radius r in the xz plane.
 */
export function groundQuad(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3))
  g.setIndex([0, 1, 2, 2, 1, 3])
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e3)
  return g
}

export function groundQuadPosition(radiusGame: number) {
  return vec3(positionGeometry.x.mul(radiusGame * S), 0, positionGeometry.y.mul(-radiusGame * S))
}
