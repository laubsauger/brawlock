import * as THREE from 'three/webgpu'
import { atan, exp, float, fract, length, positionGeometry, sin, smoothstep, step, uniform } from 'three/tsl'
import { S } from '../coords'
import { groundQuad, groundQuadPosition } from './Pawns'
import type { WorldCtx } from './world'

/** quad half-size (game units) */
const R = 28
/** destination ring radius / half line width (game units) */
const RING_R = 20
const RING_W = 2

/**
 * Persistent move destination for the local warlock: a small, dim,
 * identity-tinted dot inside a thin ring with a slow breathing pulse, shown
 * while the warlock walks there (the click itself keeps its chevron burst).
 * Queued moves ("Move cancels cast" off, held during a windup) draw hollow:
 * a dashed ring without the dot. Deliberately calm (half the pawn ring, no
 * burst, a slow pulse) so it never reads as a fresh order or a spell telegraph.
 */
export class MoveDestination {
  readonly mesh: THREE.Mesh
  private uColor = uniform(new THREE.Color(1, 1, 1))
  private uAlpha = uniform(0)
  private uQueued = uniform(0)
  private material: THREE.MeshBasicNodeMaterial

  constructor(time: WorldCtx['uTime']) {
    const q = positionGeometry.xy
    const rr = length(q).mul(R)
    const ringX = rr.sub(RING_R).div(RING_W)
    const ring = exp(ringX.mul(ringX).negate())
    const dot = float(1).sub(smoothstep(4, 7, rr))
    // queued: 8 dashes drifting slowly round the ring
    const ang = atan(q.y, q.x)
    const dashes = step(0.42, fract(ang.div(Math.PI * 2).mul(8).add(time.mul(0.06))))
    const pulse = sin(time.mul(2.4)).mul(0.12).add(0.88)
    const solid = ring.mul(0.75).add(dot.mul(0.55))
    const hollow = ring.mul(dashes).mul(0.8)
    const shape = solid.mul(float(1).sub(this.uQueued)).add(hollow.mul(this.uQueued))
    const m = new THREE.MeshBasicNodeMaterial()
    m.transparent = true
    m.depthWrite = false
    m.blending = THREE.AdditiveBlending
    m.fog = false
    m.colorNode = this.uColor.mul(shape.mul(pulse).mul(this.uAlpha))
    m.opacityNode = float(1)
    m.positionNode = groundQuadPosition(R)
    m.name = 'MoveDestination'
    this.material = m
    this.mesh = new THREE.Mesh(groundQuad(), m)
    this.mesh.name = 'move-destination'
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 3
    this.mesh.visible = false
  }

  /**
   * Place at game (x, y) on floor height h (game units). alpha 0 hides it.
   * colour: linear rgb (identity colour), queued: hollow look.
   */
  set(x: number, y: number, h: number, alpha: number, color: THREE.Color, queued: boolean): void {
    this.mesh.visible = alpha > 0.01
    if (!this.mesh.visible) return
    this.mesh.position.set(x * S, (h + 1.2) * S, -y * S)
    this.uAlpha.value = alpha
    this.uColor.value.copy(color)
    this.uQueued.value = queued ? 1 : 0
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
