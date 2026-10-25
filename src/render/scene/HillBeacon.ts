import * as THREE from 'three/webgpu'
import { float, fract, positionGeometry, sin, smoothstep, uniform, uv } from 'three/tsl'
import { S } from '../coords'
import type { WorldCtx } from './world'

/** column radius and height (game units) */
const RADIUS = 70
const HEIGHT = 900

/**
 * King of the Hill: a column of light over the hill's centre, so the objective reads from
 * anywhere on screen. Faint gold while the hill is empty, a brighter shaft in the holder's
 * colour while held (bands rising through it), a stuttering flicker while contested. Kept faint:
 * from the top-down camera the column lies over the hill's own tiles.
 * Additive and depth-tested, never writing depth, so warlocks inside it stay visible.
 */
export class HillBeacon {
  readonly mesh: THREE.Mesh
  private uColor = uniform(new THREE.Color(1, 0.7, 0.3))
  /** overall strength, eased in update() */
  private uLevel = uniform(0)
  /** band speed: faster while held */
  private uSpeed = uniform(0.5)
  private material: THREE.MeshBasicNodeMaterial
  private level = 0

  constructor(time: WorldCtx['uTime']) {
    const v = uv().y
    // bright at the floor, gone at the top; soft at the rim of the open cylinder
    const fall = float(1).sub(v).pow(3.2)
    const bands = sin(v.mul(26).sub(time.mul(this.uSpeed).mul(6))).mul(0.5).add(0.5).pow(4)
    const shimmer = sin(fract(uv().x.mul(3)).mul(Math.PI * 2).add(time.mul(1.7))).mul(0.12).add(0.88)
    const base = smoothstep(0, 0.04, v)
    const m = new THREE.MeshBasicNodeMaterial()
    m.transparent = true
    m.depthWrite = false
    m.blending = THREE.AdditiveBlending
    m.side = THREE.DoubleSide
    m.fog = false
    m.colorNode = this.uColor.mul(fall.mul(bands.mul(0.6).add(0.4)).mul(shimmer).mul(base).mul(this.uLevel))
    m.opacityNode = float(1)
    m.positionNode = positionGeometry
    m.name = 'HillBeacon'
    this.material = m
    const geo = new THREE.CylinderGeometry(RADIUS * S, RADIUS * 1.35 * S, HEIGHT * S, 24, 1, true)
    geo.translate(0, (HEIGHT / 2) * S, 0)
    this.mesh = new THREE.Mesh(geo, m)
    this.mesh.name = 'hill-beacon'
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 4
    this.mesh.visible = false
  }

  /**
   * mode: null = no hill, 0 empty, 1 held, 2 contested. colour: linear rgb (holder identity).
   * dt in seconds; t is the clock for the contested flicker.
   */
  update(mode: 0 | 1 | 2 | null, color: THREE.Color, floorH: number, t: number, dt: number): void {
    const target = mode === null ? 0 : mode === 1 ? 0.5 : mode === 2 ? (Math.sin(t * 22) > 0 ? 0.35 : 0.1) : 0.12
    this.level += (target - this.level) * Math.min(1, dt * (mode === 2 ? 30 : 5))
    this.mesh.visible = this.level > 0.01
    if (!this.mesh.visible) return
    this.mesh.position.set(0, floorH * S, 0)
    this.uLevel.value = this.level
    this.uSpeed.value = mode === 1 ? 1 : 0.4
    this.uColor.value.copy(color)
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
