import * as THREE from 'three/webgpu'
import type { PawnState, SimEvent } from '../../sim/types'
import { S, facingToYaw } from '../coords'
import { tierConfig } from '../quality'
import { MODEL_SCALE, STAFF_PIVOT, STAFF_TIP, createPawnMaterial, getBodyGeometry, getStaffGeometry, type PawnUniforms } from '../scene/pawnModel'
import { createWorldCtx, type WorldCtx } from '../scene/world'
import type { CastFrom } from './config'
import type { StaffVariant } from './geometry'
import type { CastArm, DeathKind, WarlockHandle } from './types'
import { syncFootprint } from './debug'

/**
 * The render agent's procedural placeholder warlock (scene/pawnModel.ts),
 * wrapped in the WarlockHandle API so both styles are switchable at runtime.
 * Body motion mirrors PawnView (lean, tumble spin, walk bob, cloth spring,
 * staff windup / release); decals, aim and world placement stay with the owner.
 */

const TAU = Math.PI * 2
function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a
  while (d > Math.PI) d -= TAU
  while (d < -Math.PI) d += TAU
  return a + d * t
}

let sharedCtx: WorldCtx | null = null

export class ProceduralWarlock implements WarlockHandle {
  readonly style = 'procedural' as const
  readonly object3d = new THREE.Group()
  private tilt = new THREE.Group()
  private yawG = new THREE.Group()
  private bob = new THREE.Group()
  private staffPivot = new THREE.Group()
  private body: THREE.Mesh
  private staff: THREE.Mesh
  private material: THREE.MeshStandardNodeMaterial
  private u: PawnUniforms
  private ownClock: boolean
  private ctx: WorldCtx
  private t = 0
  private yaw = 0
  private spin = 0
  private walkPhase = 0
  private clothX = 0
  private clothY = 0
  private clothVx = 0
  private clothVy = 0
  private flutter = 0
  private flutterKick = 0
  private flashAt = -10
  private deathAt = -1
  private releaseAt = -10
  private fizzleAt = -10
  private castTotal = 1
  private castProgress = 0
  private axis = new THREE.Vector3()
  private q = new THREE.Quaternion()
  private tip = new THREE.Vector3()
  private color = new THREE.Color()

  constructor(color: number, ctx?: WorldCtx) {
    this.ownClock = !ctx
    if (!ctx) sharedCtx ??= createWorldCtx(tierConfig('high'), 1)
    this.ctx = ctx ?? sharedCtx!
    const { material, u } = createPawnMaterial(this.ctx)
    this.material = material
    this.u = u
    u.phase.value = Math.random() * 100
    this.body = new THREE.Mesh(getBodyGeometry(), material)
    this.staff = new THREE.Mesh(getStaffGeometry(), material)
    this.body.castShadow = this.staff.castShadow = true
    this.staffPivot.position.copy(STAFF_PIVOT).multiplyScalar(S * MODEL_SCALE)
    this.staffPivot.add(this.staff)
    this.bob.add(this.body, this.staffPivot)
    this.yawG.add(this.bob)
    this.tilt.add(this.yawG)
    this.object3d.add(this.tilt)
    this.object3d.name = 'WarlockProcedural'
    this.setColor(color)
  }

  get castCharge(): number {
    return this.castProgress
  }

  readonly castHands = 'right' as const

  setColor(color: number): void {
    this.color.setHex(color)
    this.u.team.value.copy(this.color)
  }
  setCastColor(): void {}
  setStaff(_variant: StaffVariant | null): void {}
  setCastFrom(_from: CastFrom): void {}
  tumble(): void {}
  deathFx(_kind: DeathKind): void {
    if (this.deathAt < 0) this.deathAt = this.t
  }
  private footprint: THREE.Object3D | null = null

  castOrigin(out: THREE.Vector3): THREE.Vector3 {
    this.tip.copy(STAFF_TIP).multiplyScalar(S * MODEL_SCALE)
    return this.staff.localToWorld(out.copy(this.tip))
  }

  /** The placeholder has no arm: the chain runs from the staff pivot to the crystal. */
  castArm(out: CastArm): CastArm {
    this.staffPivot.getWorldPosition(out.shoulder)
    out.elbow.copy(out.shoulder)
    out.wrist.copy(out.shoulder)
    this.castOrigin(out.palm)
    out.dir.subVectors(out.palm, out.wrist).normalize()
    return out
  }

  impulse(dx: number, dy: number, kb: number): void {
    const l = Math.hypot(dx, dy) || 1
    const k = Math.min(1600, kb) * 0.22
    this.clothVx -= (dx / l) * k
    this.clothVy -= (dy / l) * k
    this.flutterKick = Math.min(1.5, this.flutterKick + kb / 1200)
  }

  update(p: PawnState, prev: PawnState | null, alpha: number, dtIn: number, events: readonly SimEvent[]): void {
    const dt = Math.min(Math.max(dtIn, 0), 0.1)
    this.t += dt
    const now = this.t
    if (this.ownClock) this.ctx.uTime.value = now
    this.footprint = syncFootprint(this.object3d, this.footprint)
    for (const e of events) {
      if (e.type === 'damage' && e.target === p.id) this.flashAt = now
      else if (e.type === 'cast' && e.pawn === p.id) this.releaseAt = now
      else if (e.type === 'castStart' && e.pawn === p.id) this.castTotal = Math.max(1, e.ticks)
      else if (e.type === 'castCancel' && e.pawn === p.id) this.fizzleAt = now
    }
    if (!p.alive && this.deathAt < 0) this.deathAt = now
    if (p.alive && this.deathAt >= 0) {
      this.deathAt = -1
      this.spin = 0
    }
    const facing = prev ? lerpAngle(prev.facing, p.facing, alpha) : p.facing
    const k = 1 - Math.exp(-dt * 14)

    const kx = p.vx - p.walkVx
    const ky = p.vy - p.walkVy
    const kmag = Math.hypot(kx, ky)
    const lean = Math.min(0.55, kmag / 1300)
    if (lean > 0.01) {
      this.axis.set(-ky / kmag, 0, -kx / kmag)
      this.q.setFromAxisAngle(this.axis, -lean)
      this.tilt.quaternion.slerp(this.q, k)
    } else this.tilt.quaternion.slerp(this.q.identity(), k)
    if (kmag > 850) this.spin += dt * Math.min(18, kmag / 110)
    else this.spin = lerpAngle(this.spin, Math.round(this.spin / TAU) * TAU, k * 0.5)
    this.yaw = lerpAngle(this.yaw, facingToYaw(facing), 1 - Math.exp(-dt * 30))
    this.yawG.rotation.y = this.yaw + this.spin

    // cloth spring (game units, world axes) -> model local
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
      const wx = this.clothX * S
      const wz = -this.clothY * S
      const yawT = this.yawG.rotation.y
      const c = Math.cos(yawT)
      const sn = Math.sin(yawT)
      this.u.sway.value.set(wx * c - wz * sn, 0, wx * sn + wz * c)
      const speed = Math.hypot(p.vx, p.vy)
      this.flutterKick *= Math.exp(-dt * 3)
      const fTarget = Math.max(Math.min(1, speed / 650), kmag > 850 ? 1.2 : 0, this.flutterKick)
      this.flutter += (fTarget - this.flutter) * (1 - Math.exp(-dt * 6))
      this.u.flutter.value = this.flutter
    }

    const walk = Math.hypot(p.walkVx, p.walkVy)
    this.walkPhase += dt * walk * 0.055
    const amp = Math.min(1, walk / 200)
    this.bob.position.y = Math.abs(Math.sin(this.walkPhase)) * 3.5 * S * amp
    this.bob.rotation.z = Math.sin(this.walkPhase) * 0.06 * amp
    this.bob.rotation.x = 0.08 * amp

    const running = !!p.cast && p.cast.started !== false
    if (p.cast && running) {
      this.castTotal = Math.max(this.castTotal, p.cast.ticksLeft)
      this.castProgress = 1 - p.cast.ticksLeft / this.castTotal
    } else {
      const fizzling = now - this.fizzleAt < 0.25
      this.castProgress = Math.max(0, this.castProgress - dt * (fizzling ? 14 : 6))
    }
    if (walk > 20 && !p.cast && now - this.releaseAt > 0.05) this.releaseAt = -10
    const relT = (now - this.releaseAt) / 0.35
    const rel = relT >= 0 && relT < 1 ? (relT < 0.2 ? relT / 0.2 : 1 - (relT - 0.2) / 0.8) : 0
    this.staffPivot.rotation.x = -this.castProgress * 0.75 + rel * 0.65
    this.staffPivot.rotation.z = -this.castProgress * 0.15 - rel * 0.1
    this.bob.rotation.x += rel * 0.12 - this.castProgress * 0.05
    this.u.cast.value = Math.min(1.5, this.castProgress + rel * 1.2)

    const u = this.u
    u.burn.value += ((p.alive && p.lavaTicks > 0 ? 1 : 0) - u.burn.value) * (1 - Math.exp(-dt * 8))
    u.invuln.value += ((p.invulnerable ? 1 : 0) - u.invuln.value) * k
    u.flash.value = Math.max(0, 1 - (now - this.flashAt) / 0.14)
    const dis = this.deathAt >= 0 ? Math.min(1, (now - this.deathAt) / 0.9) : 0
    u.dissolve.value = dis
    this.body.visible = this.staff.visible = dis < 1
  }

  dispose(): void {
    this.material.dispose()
    this.object3d.removeFromParent()
  }
}
