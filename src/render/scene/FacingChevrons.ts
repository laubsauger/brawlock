import * as THREE from 'three/webgpu'
import { attribute, exp, float, vec3 } from 'three/tsl'
import { S } from '../coords'

/**
 * Facing chevrons: one small "^" per warlock on the floor just past its ring,
 * pointing along the smoothed visual yaw, in the identity colour. All pawns
 * share one draw (a small vertex buffer rewritten every frame).
 *
 * At the gameplay pitch the body hides the floor behind the pawn, so a
 * warlock facing away would hide a floor marker. Each vertex is pulled toward
 * the camera along its own view ray by DEPTH_BIAS: the chevron projects to
 * exactly the same pixels but tests depth as if it were that much closer, so
 * the pawn's own body (within ~160 units along the ray) never hides it, while
 * walls and pillars further in front still do.
 */

/** chevron shape in game units: arms from the ring (r, +-half angle) to the tip */
const BASE_R = 44
const TIP_R = 60
const HALF_ANGLE = 0.3
/** line half-thickness (game units) */
const HALF_W = 2.6
/** pull toward the camera along the view ray (game units): clears the pawn's own body */
const DEPTH_BIAS = 200
/** float above the floor (game units) */
const LIFT = 2

const VERTS = 8
const IDX = 12

export class FacingChevrons {
  readonly mesh: THREE.Mesh
  private pos: THREE.BufferAttribute
  private col: THREE.BufferAttribute
  private side: THREE.BufferAttribute
  private n = 0
  private world: Float32Array
  private material: THREE.MeshBasicNodeMaterial

  constructor(private capacity = 16) {
    const g = new THREE.BufferGeometry()
    this.world = new Float32Array(capacity * VERTS * 3)
    this.pos = new THREE.BufferAttribute(new Float32Array(capacity * VERTS * 3), 3)
    this.col = new THREE.BufferAttribute(new Float32Array(capacity * VERTS * 4), 4)
    this.side = new THREE.BufferAttribute(new Float32Array(capacity * VERTS), 1)
    for (const a of [this.pos, this.col, this.side]) a.setUsage(THREE.StaticDrawUsage)
    // -1 / +1 across each arm: soft line profile in the fragment shader
    for (let c = 0; c < capacity; c++) for (let v = 0; v < VERTS; v++) this.side.setX(c * VERTS + v, v % 2 === 0 ? -1 : 1)
    const index: number[] = []
    for (let c = 0; c < capacity; c++) {
      const o = c * VERTS
      // two arms, each a quad (0,1,2,3) / (4,5,6,7), counter-clockwise seen from above
      for (const a of [0, 4]) index.push(o + a, o + a + 2, o + a + 1, o + a + 2, o + a + 3, o + a + 1)
    }
    g.setIndex(index)
    g.setAttribute('position', this.pos)
    g.setAttribute('aCol', this.col)
    g.setAttribute('aSide', this.side)
    g.setDrawRange(0, 0)
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
    const m = new THREE.MeshBasicNodeMaterial()
    m.transparent = true
    m.depthWrite = false
    m.blending = THREE.AdditiveBlending
    m.fog = false
    const s = attribute('aSide', 'float')
    const c = attribute('aCol', 'vec4')
    const line = exp(s.mul(s).mul(-2.2))
    // same weight as the ring line (identity colour x 2.4 at its centre)
    m.colorNode = vec3(c.x, c.y, c.z).mul(float(2.2).mul(line).mul(c.w))
    m.opacityNode = float(1)
    m.name = 'FacingChevrons'
    this.material = m
    this.mesh = new THREE.Mesh(g, m)
    this.mesh.name = 'facing-chevrons'
    this.mesh.frustumCulled = false
    // after pawns and their decals
    this.mesh.renderOrder = 9
  }

  begin(): void {
    this.n = 0
  }

  /**
   * One chevron at game (x, y), floor height h (game units), pointing along
   * game angle `facing`, colour (linear rgb), alpha 0..1.
   */
  add(x: number, y: number, h: number, facing: number, r: number, g: number, b: number, alpha: number): void {
    if (this.n >= this.capacity || alpha <= 0.01) return
    const i = this.n++
    const w = this.world
    const fx = Math.cos(facing)
    const fy = Math.sin(facing)
    const tipX = x + fx * TIP_R
    const tipY = y + fy * TIP_R
    let o = i * VERTS * 3
    for (const sgn of [-1, 1]) {
      const a = facing + sgn * HALF_ANGLE
      const bx = x + Math.cos(a) * BASE_R
      const by = y + Math.sin(a) * BASE_R
      // arm direction and its normal on the floor
      let dx = tipX - bx
      let dy = tipY - by
      const l = Math.hypot(dx, dy) || 1
      dx /= l
      dy /= l
      const nx = -dy * HALF_W
      const ny = dx * HALF_W
      // extend the tip end a little so the two arms meet in a point
      const ex = dx * HALF_W
      const ey = dy * HALF_W
      const pts = [bx - nx, by - ny, bx + nx, by + ny, tipX - nx + ex, tipY - ny + ey, tipX + nx + ex, tipY + ny + ey]
      for (let k = 0; k < 4; k++) {
        // game (x, y, h) -> three (x, h, -y)
        w[o++] = pts[k * 2] * S
        w[o++] = (h + LIFT) * S
        w[o++] = -pts[k * 2 + 1] * S
      }
    }
    const ca = this.col.array as Float32Array
    for (let v = 0; v < VERTS; v++) {
      const k = (i * VERTS + v) * 4
      ca[k] = r
      ca[k + 1] = g
      ca[k + 2] = b
      ca[k + 3] = alpha
    }
  }

  /** Bias toward the camera and upload. */
  commit(camera: THREE.Camera): void {
    const n = this.n
    const geo = this.mesh.geometry
    geo.setDrawRange(0, n * IDX)
    // nothing to draw: hide (an empty draw costs a pass and warns on WebGPU)
    this.mesh.visible = n > 0
    if (n === 0) return
    const cp = camera.position
    const bias = DEPTH_BIAS * S
    const src = this.world
    const dst = this.pos.array as Float32Array
    const cnt = n * VERTS * 3
    for (let k = 0; k < cnt; k += 3) {
      const px = src[k]
      const py = src[k + 1]
      const pz = src[k + 2]
      const vx = cp.x - px
      const vy = cp.y - py
      const vz = cp.z - pz
      const d = Math.hypot(vx, vy, vz) || 1
      const t = Math.min(bias, d * 0.5) / d
      dst[k] = px + vx * t
      dst[k + 1] = py + vy * t
      dst[k + 2] = pz + vz * t
    }
    this.pos.clearUpdateRanges()
    this.pos.addUpdateRange(0, cnt)
    this.pos.needsUpdate = true
    this.col.clearUpdateRanges()
    this.col.addUpdateRange(0, n * VERTS * 4)
    this.col.needsUpdate = true
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
