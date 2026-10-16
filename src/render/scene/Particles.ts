import * as THREE from 'three/webgpu'
import { abs, atan, cameraViewMatrix, cos, exp, float, instancedBufferAttribute, length, max, min, mix, pow, saturate, sin, smoothstep, step, uv, varying, vec2, vec3, vec4 } from 'three/tsl'
import { S } from '../coords'
import { asV4, spriteGroundFade, type WorldCtx } from './world'

export type ParticleMode = 'add' | 'smoke' | 'debris'

/**
 * Stateless GPU particles. Each particle is written once into a ring buffer
 * at spawn (position, velocity, colour, sizes, gravity, drag, sway) and the
 * vertex shader evaluates its motion analytically from the spawn time, so the
 * CPU never touches a live particle again: no per-frame integration, uploads
 * only for the slots spawned this frame.
 */
export class Particles {
  readonly sprite: THREE.Sprite
  readonly capacity: number
  private a0: THREE.InstancedBufferAttribute
  private a1: THREE.InstancedBufferAttribute
  private a2: THREE.InstancedBufferAttribute
  private a3: THREE.InstancedBufferAttribute
  private attrs: THREE.InstancedBufferAttribute[]
  private cursor = 0
  private written = 0
  private writeStart = 0
  private material: THREE.SpriteNodeMaterial

  constructor(
    private ctx: WorldCtx,
    capacity: number,
    mode: ParticleMode,
  ) {
    this.capacity = Math.max(16, Math.round(capacity))
    const mk = () => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4)
      // StaticDrawUsage on purpose: three's WebGPU path re-uploads a
      // DynamicDrawUsage attribute IN FULL every frame (and every pass);
      // static + needsUpdate + update ranges uploads only the spawned slots
      a.setUsage(THREE.StaticDrawUsage)
      return a
    }
    this.a0 = mk()
    this.a1 = mk()
    this.a2 = mk()
    this.a3 = mk()
    this.attrs = [this.a0, this.a1, this.a2, this.a3]
    // park every slot in the past so nothing renders before it is spawned
    const arr0 = this.a0.array as Float32Array
    const arr1 = this.a1.array as Float32Array
    for (let i = 0; i < this.capacity; i++) {
      arr0[i * 4 + 3] = -1e4
      arr1[i * 4 + 3] = 1
    }

    const t = ctx.uTime
    const A0 = asV4(instancedBufferAttribute(this.a0))
    const A1 = asV4(instancedBufferAttribute(this.a1))
    const A2 = asV4(instancedBufferAttribute(this.a2))
    const A3 = asV4(instancedBufferAttribute(this.a3))

    const age = t.sub(A0.w)
    // normalised age computed ONCE in the vertex stage and handed to the
    // fragment as a varying: the fragment's own copy of the clock uniform was
    // not tracking the frame clock, which froze rings/fades (persistent discs)
    const tn = varying(age.div(A1.w))
    const alive = step(0, tn).mul(step(tn, 1))
    const k = max(A3.z, 0.0001)
    const dragF = float(1).sub(exp(k.negate().mul(age))).div(k)
    // A3.w > 0: lazy sway amplitude (embers); A3.w < 0: velocity streak factor (sparks)
    const swayAmp = max(A3.w, 0)
    const streakK = max(A3.w.negate(), 0)
    const sway = vec3(sin(age.mul(2.1).add(A0.w.mul(31))), 0, cos(age.mul(1.7).add(A0.w.mul(17)))).mul(swayAmp.mul(min(age, 1)))
    const pos = A0.xyz.add(A1.xyz.mul(dragF)).add(vec3(0, A3.y.mul(age).mul(age).mul(0.5), 0)).add(sway)
    // size1 < 0 flags a cooling particle (fire): colour shifts to crimson with age
    const cooling = step(A3.x, 0)
    const size = mix(A2.w, abs(A3.x), tn).mul(alive)
    // current velocity in view space -> screen-aligned stretch (cheap motion blur)
    const vel = A1.xyz.mul(exp(k.negate().mul(age))).add(vec3(0, A3.y.mul(age), 0))
    const vv = cameraViewMatrix.mul(vec4(vel, 0)).xy
    const vlen = length(vv)
    const stretch = float(1).add(vlen.mul(streakK))

    const d = length(uv().sub(0.5)).mul(2)
    const soft = saturate(float(1).sub(d))

    const m = new THREE.SpriteNodeMaterial()
    m.transparent = true
    m.depthWrite = false
    m.positionNode = pos
    const scale = vec2(size.mul(stretch), size)
    const rotation = atan(vv.y, vv.x)
    m.scaleNode = scale
    m.rotationNode = rotation
    // soft particles: dissolve into the floor instead of a hard cut line
    const ground = spriteGroundFade(pos, scale, rotation, ctx.field, mode === 'smoke' ? 40 : 18)
    m.sizeAttenuation = true
    if (mode === 'add') {
      m.blending = THREE.AdditiveBlending
      const fade = pow(float(1).sub(tn), 1.4).mul(smoothstep(0, 0.04, tn))
      const coolCol = mix(A2.xyz, A2.xyz.mul(vec3(0.5, 0.1, 0.045)), smoothstep(0.0, 0.75, tn).mul(cooling))
      m.colorNode = coolCol.mul(soft.mul(soft).mul(1.4).add(pow(soft, 6).mul(2)))
      m.opacityNode = fade.mul(alive).mul(ground)
    } else if (mode === 'debris') {
      // solid chips: hard-edged, opaque, shrink out at the end of life
      m.blending = THREE.NormalBlending
      m.colorNode = A2.xyz.mul(float(1.15).sub(d.mul(0.4)))
      m.opacityNode = step(d, 0.85).mul(alive).mul(float(1).sub(smoothstep(0.8, 1, tn))).mul(step(0.5, ground))
      m.alphaTest = 0.5
      m.transparent = false
      m.depthWrite = true
    } else {
      m.blending = THREE.NormalBlending
      const fade = smoothstep(0, 0.12, tn).mul(float(1).sub(smoothstep(0.45, 1, tn)))
      m.colorNode = A2.xyz
      m.opacityNode = soft.mul(soft).mul(fade).mul(alive).mul(0.34).mul(ground)
    }
    m.name = `Particles-${mode}`
    this.material = m

    this.sprite = new THREE.Sprite(m)
    this.sprite.count = this.capacity
    this.sprite.frustumCulled = false
    this.sprite.renderOrder = mode === 'add' ? 6 : mode === 'debris' ? 4 : 5
    this.sprite.name = `particles-${mode}`
  }

  /** Scale a spawn count by the tier particle budget (fractional counts dither). */
  budget(n: number): number {
    const v = n * this.ctx.tier.particles
    const whole = Math.floor(v)
    return whole + (Math.random() < v - whole ? 1 : 0)
  }

  /**
   * Spawn one particle. Positions/velocities in game units (x, y ground plane,
   * h height above lava), sizes in game units, colour linear HDR.
   * gravity: game units / s^2 on height (negative falls), drag: 1/s,
   * sway: > 0 lazy drift amplitude (game units); < 0 velocity streak factor
   * (stretch = 1 + |screen velocity in world units/s| * -sway).
   */
  spawn(
    x: number,
    y: number,
    h: number,
    vx: number,
    vy: number,
    vh: number,
    life: number,
    size0: number,
    size1: number,
    r: number,
    g: number,
    b: number,
    gravity = 0,
    drag = 0,
    sway = 0,
  ): void {
    const i = this.cursor
    this.cursor = (this.cursor + 1) % this.capacity
    if (this.written === 0) this.writeStart = i
    this.written++
    const o = i * 4
    const now = this.ctx.uTime.value
    const a0 = this.a0.array as Float32Array
    const a1 = this.a1.array as Float32Array
    const a2 = this.a2.array as Float32Array
    const a3 = this.a3.array as Float32Array
    a0[o] = x * S
    a0[o + 1] = h * S
    a0[o + 2] = -y * S
    a0[o + 3] = now
    a1[o] = vx * S
    a1[o + 1] = vh * S
    a1[o + 2] = -vy * S
    a1[o + 3] = Math.max(0.01, life)
    a2[o] = r
    a2[o + 1] = g
    a2[o + 2] = b
    a2[o + 3] = size0 * S
    a3[o] = size1 * S
    a3[o + 1] = gravity * S
    a3[o + 2] = drag
    a3[o + 3] = sway > 0 ? sway * S : sway
  }

  /** Upload the slots written since the last commit. Call once per frame. */
  commit(): void {
    if (this.written === 0) return
    const n = Math.min(this.written, this.capacity)
    const start = this.writeStart
    for (const a of this.attrs) {
      a.clearUpdateRanges()
      if (start + n <= this.capacity) {
        a.addUpdateRange(start * 4, n * 4)
      } else {
        a.addUpdateRange(start * 4, (this.capacity - start) * 4)
        a.addUpdateRange(0, (start + n - this.capacity) * 4)
      }
      a.needsUpdate = true
    }
    this.written = 0
  }

  dispose(): void {
    // the sprite quad geometry is shared by all three.js sprites: never dispose it
    this.material.dispose()
  }
}
