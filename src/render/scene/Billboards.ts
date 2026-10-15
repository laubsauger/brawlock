import * as THREE from 'three/webgpu'
import { abs, exp, float, instancedBufferAttribute, length, mix, mrt, pow, saturate, step, uv, vec2, vec4 } from 'three/tsl'
import { asV4, spriteGroundFade, type ArenaField } from './world'

/**
 * Per-frame additive glow sprites (projectile halos and comet streaks, staff
 * flares, flashes). Rewritten from scratch every frame by the owners:
 * begin(), add()/addStreak()..., commit(). Streaks are stretched along a
 * screen-space angle (cheap motion blur). With heat haze on, sprites also
 * write distortion strength into the 'heat' MRT attachment.
 */
export class Billboards {
  readonly sprite: THREE.Sprite
  private p: THREE.InstancedBufferAttribute
  private c: THREE.InstancedBufferAttribute
  private e: THREE.InstancedBufferAttribute
  private n = 0
  private material: THREE.SpriteNodeMaterial

  constructor(
    private capacity = 128,
    heatHaze = false,
    field: ArenaField | null = null,
    /** draw over geometry (no depth test): telegraphs that must read through bodies */
    onTop = false,
  ) {
    const mk = () => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
      a.setUsage(THREE.DynamicDrawUsage)
      return a
    }
    this.p = mk()
    this.c = mk()
    this.e = mk()
    const P = asV4(instancedBufferAttribute(this.p))
    const C = asV4(instancedBufferAttribute(this.c))
    const E = asV4(instancedBufferAttribute(this.e))
    const d = length(uv().sub(0.5)).mul(2)
    const soft = saturate(float(1).sub(d))
    // C.w = falloff exponent: high = tight hot core, low = broad haze;
    // negative = ring sprite (halo / rune ring), |C.w| = ring sharpness
    const isRing = step(C.w, 0)
    const rx = d.sub(0.72).mul(abs(C.w).mul(4))
    const ringShape = exp(rx.mul(rx).negate()).mul(step(d, 1))
    const shape = mix(pow(soft, abs(C.w)), ringShape, isRing)
    const m = new THREE.SpriteNodeMaterial()
    m.transparent = true
    m.depthWrite = false
    m.blending = THREE.AdditiveBlending
    m.positionNode = P.xyz
    const scale = vec2(P.w.mul(E.y), P.w)
    m.scaleNode = scale
    m.rotationNode = E.x
    // soft-particle fade where a glow sprite cuts into the floor
    const ground = field ? spriteGroundFade(P.xyz, scale, E.x, field, 26) : float(1)
    m.colorNode = C.xyz.mul(shape).mul(ground)
    m.opacityNode = float(1)
    if (heatHaze) m.mrtNode = mrt({ heat: vec4(shape.mul(E.z), 0, 0, 1) })
    if (onTop) m.depthTest = false
    m.name = onTop ? 'BillboardsOnTop' : 'Billboards'
    this.material = m
    this.sprite = new THREE.Sprite(m)
    this.sprite.count = 0
    this.sprite.frustumCulled = false
    this.sprite.renderOrder = onTop ? 9 : 7
    this.sprite.name = onTop ? 'billboards-top' : 'billboards'
  }

  begin(): void {
    this.n = 0
  }

  /** World-space position (three units), size in three units, linear HDR colour. */
  add(x: number, y: number, z: number, size: number, r: number, g: number, b: number, falloff = 2, heat = 0): void {
    this.addStreak(x, y, z, size, 1, 0, r, g, b, falloff, heat)
  }

  /** Like add(), stretched by `stretch` along screen angle `rot` (radians). */
  addStreak(x: number, y: number, z: number, size: number, stretch: number, rot: number, r: number, g: number, b: number, falloff = 2, heat = 0): void {
    if (this.n >= this.capacity) return
    const o = this.n * 4
    const pa = this.p.array as Float32Array
    const ca = this.c.array as Float32Array
    const ea = this.e.array as Float32Array
    pa[o] = x
    pa[o + 1] = y
    pa[o + 2] = z
    pa[o + 3] = size
    ca[o] = r
    ca[o + 1] = g
    ca[o + 2] = b
    ca[o + 3] = falloff
    ea[o] = rot
    ea[o + 1] = stretch
    ea[o + 2] = heat
    ea[o + 3] = 0
    this.n++
  }

  commit(): void {
    this.sprite.count = this.n
    this.sprite.visible = this.n > 0
    if (this.n === 0) return
    upload(this.p, this.n)
    upload(this.c, this.n)
    upload(this.e, this.n)
  }

  dispose(): void {
    this.material.dispose()
  }
}

function upload(a: THREE.InstancedBufferAttribute, n: number): void {
  a.clearUpdateRanges()
  a.addUpdateRange(0, n * 4)
  a.needsUpdate = true
}
