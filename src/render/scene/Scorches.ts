import * as THREE from 'three/webgpu'
import { float, instancedBufferAttribute, length, mix, positionGeometry, saturate, smoothstep, step, texture, varying, vec3 } from 'three/tsl'
import { S } from '../coords'
import { asV4, type WorldCtx } from './world'

/**
 * Impact scorch marks on the floor: a ragged dark burn with ember speckles
 * that cool off, then the whole mark fades. Ring buffer, shader-animated.
 */
export class Scorches {
  readonly mesh: THREE.Mesh
  private a: THREE.InstancedBufferAttribute
  private b: THREE.InstancedBufferAttribute
  private cursor = 0
  private dirty = false
  private material: THREE.MeshBasicNodeMaterial
  private readonly capacity = 40

  constructor(private ctx: WorldCtx) {
    this.a = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4)
    this.b = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4)
    const aa = this.a.array as Float32Array
    const ba = this.b.array as Float32Array
    for (let i = 0; i < this.capacity; i++) {
      aa[i * 4 + 3] = -1e4
      ba[i * 4 + 1] = 1
    }
    const A = asV4(instancedBufferAttribute(this.a))
    const B = asV4(instancedBufferAttribute(this.b))
    const age = ctx.uTime.sub(A.w)
    // normalised age computed ONCE in the vertex stage and handed to the
    // fragment as a varying: the fragment's own copy of the clock uniform was
    // not tracking the frame clock, which froze rings/fades (persistent discs)
    const tn = varying(age.div(B.y))
    const alive = step(0, tn).mul(step(tn, 1))
    const q = positionGeometry.xy
    const R = B.x
    const positionNode = A.xyz.add(vec3(q.x, 0, q.y.negate()).mul(R.mul(S).mul(alive)))
    const rr = length(q)
    const n = texture(ctx.noise, q.mul(0.45).add(B.z)).r
    const shape = smoothstep(1.0, 0.45, rr.add(n.sub(0.5).mul(0.7)))
    const fade = float(1).sub(smoothstep(0.55, 1, tn))
    const sp = texture(ctx.noise, q.mul(1.7).add(B.z.mul(3.1))).g
    const embers = step(0.72, sp).mul(saturate(float(1).sub(tn.mul(3)))).mul(shape)
    const m = new THREE.MeshBasicNodeMaterial()
    m.transparent = true
    m.depthWrite = false
    m.positionNode = positionNode
    m.colorNode = mix(vec3(0.012, 0.008, 0.007), vec3(2.6, 0.7, 0.12), embers)
    m.opacityNode = shape.mul(0.82).mul(fade).mul(alive).add(embers.mul(0.3)).min(1)
    m.name = 'Scorch'
    this.material = m
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3))
    g.setIndex([0, 1, 2, 2, 1, 3])
    this.mesh = new THREE.Mesh(g, m)
    this.mesh.count = this.capacity
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 1
    this.mesh.name = 'scorches'
  }

  /** Game x, y; floor height h; radius game units; life seconds. */
  spawn(x: number, y: number, h: number, radius: number, life = 4.5): void {
    const i = this.cursor
    this.cursor = (this.cursor + 1) % this.capacity
    const aa = this.a.array as Float32Array
    const ba = this.b.array as Float32Array
    aa[i * 4] = x * S
    aa[i * 4 + 1] = h * S
    aa[i * 4 + 2] = -y * S
    aa[i * 4 + 3] = this.ctx.uTime.value
    ba[i * 4] = radius
    ba[i * 4 + 1] = life
    ba[i * 4 + 2] = Math.random() * 10
    ba[i * 4 + 3] = 0
    this.dirty = true
  }

  commit(): void {
    if (!this.dirty) return
    this.dirty = false
    this.a.needsUpdate = true
    this.b.needsUpdate = true
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
