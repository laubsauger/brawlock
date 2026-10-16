import * as THREE from 'three/webgpu'
import { float, instancedBufferAttribute, length, positionGeometry, smoothstep, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import { asV4 } from './world'

/**
 * Soft contact shadows (dark radial discs) under anything standing on the
 * floor, on every tier. Rewritten each frame: begin(), add()..., commit().
 */
export class ContactShadows {
  readonly mesh: THREE.Mesh
  private a: THREE.InstancedBufferAttribute
  private b: THREE.InstancedBufferAttribute
  private n = 0
  private material: THREE.MeshBasicNodeMaterial

  constructor(private capacity = 48) {
    this.a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
    this.a.setUsage(THREE.StaticDrawUsage)
    this.b = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
    this.b.setUsage(THREE.StaticDrawUsage)
    const A = asV4(instancedBufferAttribute(this.a))
    const B = instancedBufferAttribute(this.b) as unknown as Node<'float'>
    const q = positionGeometry.xy
    const m = new THREE.MeshBasicNodeMaterial()
    m.transparent = true
    m.depthWrite = false
    m.positionNode = A.xyz.add(vec3(q.x, 0, q.y.negate()).mul(A.w))
    m.colorNode = vec3(0, 0, 0)
    // dense core hugging the base, soft skirt
    const r = length(q)
    const core = float(1).sub(smoothstep(0.35, 0.62, r))
    const skirt = float(1).sub(smoothstep(0.3, 1.0, r))
    m.opacityNode = core.mul(0.55).add(skirt.mul(0.45)).mul(B)
    m.name = 'ContactShadow'
    this.material = m
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3))
    g.setIndex([0, 1, 2, 2, 1, 3])
    this.mesh = new THREE.Mesh(g, m)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 1
    this.mesh.name = 'contact-shadows'
  }

  begin(): void {
    this.n = 0
  }

  /** World-space centre (three units), radius (three units), opacity 0..1. */
  add(x: number, y: number, z: number, r: number, strength = 0.62): void {
    if (this.n >= this.capacity) return
    const o = this.n * 4
    const a = this.a.array as Float32Array
    a[o] = x
    a[o + 1] = y
    a[o + 2] = z
    a[o + 3] = r
    ;(this.b.array as Float32Array)[this.n] = strength
    this.n++
  }

  commit(): void {
    this.mesh.count = this.n
    this.mesh.visible = this.n > 0
    if (this.n === 0) return
    this.a.clearUpdateRanges()
    this.a.addUpdateRange(0, this.n * 4)
    this.a.needsUpdate = true
    this.b.clearUpdateRanges()
    this.b.addUpdateRange(0, this.n)
    this.b.needsUpdate = true
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
