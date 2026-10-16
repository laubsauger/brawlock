import * as THREE from 'three/webgpu'
import { abs, atan, exp, float, fract, instancedBufferAttribute, length, max, mix, positionGeometry, pow, saturate, select, step, varying, vec3 } from 'three/tsl'
import { S } from '../coords'
import { asV4, type WorldCtx } from './world'

export const RING_EXPAND = 0
export const RING_IMPLODE = 1
/** four chevrons converging on the centre (move marker) */
export const RING_CHEVRON = 2

/**
 * Ground-aligned additive ring decals (blasts, shockwaves, teleport flashes).
 * Same stateless ring-buffer scheme as Particles: written once at spawn,
 * animated entirely in the shader.
 */
export class GroundFx {
  readonly mesh: THREE.Mesh
  private b0: THREE.InstancedBufferAttribute
  private b1: THREE.InstancedBufferAttribute
  private b2: THREE.InstancedBufferAttribute
  private attrs: THREE.InstancedBufferAttribute[]
  private cursor = 0
  private dirty = false
  private material: THREE.MeshBasicNodeMaterial

  /** 'add' = glowing rings; 'shadow' = the same shapes as soft dark shadows under lifted markers */
  /** capacity 1 = a single slot: every spawn replaces the previous instantly (move marker) */
  constructor(
    private ctx: WorldCtx,
    mode: 'add' | 'shadow' = 'add',
    private readonly capacity = 48,
  ) {
    const mk = () => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4)
      a.setUsage(THREE.StaticDrawUsage)
      return a
    }
    this.b0 = mk()
    this.b1 = mk()
    this.b2 = mk()
    this.attrs = [this.b0, this.b1, this.b2]
    const arr0 = this.b0.array as Float32Array
    const arr1 = this.b1.array as Float32Array
    for (let i = 0; i < this.capacity; i++) {
      arr0[i * 4 + 3] = -1e4
      arr1[i * 4 + 2] = 1
    }

    const t = ctx.uTime
    const B0 = asV4(instancedBufferAttribute(this.b0))
    const B1 = asV4(instancedBufferAttribute(this.b1))
    const B2 = asV4(instancedBufferAttribute(this.b2))
    const age = t.sub(B0.w)
    // normalised age computed ONCE in the vertex stage and handed to the
    // fragment as a varying: the fragment's own copy of the clock uniform was
    // not tracking the frame clock, which froze rings/fades (persistent discs)
    const tn = varying(age.div(B1.z))
    const alive = step(0, tn).mul(step(tn, 1))
    const thick = B2.w
    const rMax = max(B1.x, B1.y).add(thick.mul(2.5))
    const geo = new THREE.PlaneGeometry(2, 2)
    // local quad corner (-1..1) from the plane geometry
    const q = positionGeometry.xy
    const positionNode = B0.xyz.add(vec3(q.x, 0, q.y.negate()).mul(rMax.mul(S).mul(alive)))

    const rr = length(q).mul(rMax)
    const isChevron = step(1.5, B1.w)
    const isImplode = step(0.5, B1.w)
    const eOut = float(1).sub(pow(float(1).sub(tn), 3))
    const eIn = tn.mul(tn)
    const radius = select(isImplode.greaterThan(0.5), mix(B1.y, B1.x, eIn), mix(B1.x, B1.y, eOut))
    // chevrons: four arrow heads pointing at the centre
    const sector = fract(atan(q.y, q.x).div(Math.PI / 2).add(0.5)).sub(0.5)
    const chevOff = abs(sector).mul(radius).mul(1.1)
    const cx = rr.sub(radius).sub(chevOff).div(thick)
    const chev = exp(cx.mul(cx).negate()).mul(step(abs(sector), 0.28))
    const x = rr.sub(radius).div(thick)
    const ring = mix(exp(x.mul(x).negate()), chev, isChevron)
    const fadeOut = pow(float(1).sub(tn), 1.6)
    const fadeIn = saturate(tn.mul(4)).mul(float(1).sub(step(0.97, tn)))
    const fade = mix(fadeOut, fadeIn, isImplode)
    const fill = saturate(float(1).sub(rr.div(max(radius, 1)))).mul(pow(float(1).sub(tn), 5)).mul(0.12).mul(float(1).sub(isChevron))
    const edgeCut = saturate(float(1).sub(abs(length(q)).sub(0.97).mul(30)))
    const intensity = ring.add(fill).mul(fade).mul(alive).mul(edgeCut)

    const m = new THREE.MeshBasicNodeMaterial()
    m.transparent = true
    m.depthWrite = false
    m.positionNode = positionNode
    if (mode === 'add') {
      m.blending = THREE.AdditiveBlending
      m.colorNode = B2.xyz.mul(intensity)
      m.opacityNode = float(1)
    } else {
      m.blending = THREE.NormalBlending
      m.colorNode = vec3(0, 0, 0)
      m.opacityNode = saturate(intensity.mul(0.55))
    }
    m.name = mode === 'add' ? 'GroundFx' : 'GroundFxShadow'
    this.material = m
    geo.computeBoundingSphere()
    this.mesh = new THREE.Mesh(geo, m)
    this.mesh.count = this.capacity
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = mode === 'add' ? 4 : 2
    this.mesh.name = mode === 'add' ? 'ground-fx' : 'ground-fx-shadow'
  }

  /**
   * x, y game units, h height (game units). r0 -> r1 radius over `life` seconds
   * (implode runs r1 -> r0). thickness in game units, colour linear HDR.
   */
  spawn(kind: number, x: number, y: number, h: number, r0: number, r1: number, life: number, thickness: number, r: number, g: number, b: number): void {
    const i = this.cursor
    this.cursor = (this.cursor + 1) % this.capacity
    const o = i * 4
    const b0 = this.b0.array as Float32Array
    const b1 = this.b1.array as Float32Array
    const b2 = this.b2.array as Float32Array
    b0[o] = x * S
    b0[o + 1] = h * S
    b0[o + 2] = -y * S
    b0[o + 3] = this.ctx.uTime.value
    b1[o] = r0
    b1[o + 1] = r1
    b1[o + 2] = Math.max(0.05, life)
    b1[o + 3] = kind
    b2[o] = r
    b2[o + 1] = g
    b2[o + 2] = b
    b2[o + 3] = Math.max(1, thickness)
    this.dirty = true
  }

  commit(): void {
    if (!this.dirty) return
    this.dirty = false
    for (const a of this.attrs) a.needsUpdate = true
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
