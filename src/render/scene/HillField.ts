import * as THREE from 'three/webgpu'
import { float, mix, sin, smoothstep, uniform, uv } from 'three/tsl'
import { TILE_SIZE, isTileAt } from '../../sim/arena'
import { ARENA_MAX_COORD } from '../../sim/config'
import { S } from '../coords'
import type { WorldCtx } from './world'

/** wall height (game units): over a warlock's head */
const HEIGHT = 230
/** pale arcane blue (linear), apart from the hill's gold and the lava's red */
const COLOR = new THREE.Color(0.38, 0.7, 1)

/**
 * The outline of a hill of `layer`: every edge of a hill tile's square cell that faces a cell
 * off the hill, as [x0, y0, x1, y1] in game units, wound so the hill is on each edge's left.
 */
export function hillOutline(layer: number): number[][] {
  const out: number[][] = []
  const h = TILE_SIZE / 2
  for (let gy = -ARENA_MAX_COORD; gy <= ARENA_MAX_COORD; gy++) {
    for (let gx = -ARENA_MAX_COORD; gx <= ARENA_MAX_COORD; gx++) {
      if (!isTileAt(layer, gx, gy)) continue
      const x = gx * TILE_SIZE
      const y = gy * TILE_SIZE
      if (!isTileAt(layer, gx + 1, gy)) out.push([x + h, y - h, x + h, y + h])
      if (!isTileAt(layer, gx, gy + 1)) out.push([x + h, y + h, x - h, y + h])
      if (!isTileAt(layer, gx - 1, gy)) out.push([x - h, y + h, x - h, y - h])
      if (!isTileAt(layer, gx, gy - 1)) out.push([x - h, y - h, x + h, y - h])
    }
  }
  return out
}

/**
 * King of the Hill: the force field over the hill for the first seconds of a fight (sim
 * hillSealed). A translucent wall on the hill's outline with energy bands rising through it; it
 * flickers in its last second and sinks into the floor when the hill opens. Additive, never
 * writing depth, so warlocks pressed against it stay visible.
 */
export class HillField {
  readonly mesh: THREE.Mesh
  /** overall strength, eased in update() */
  private uLevel = uniform(0)
  /** 0..1: the last second's flicker */
  private uFlicker = uniform(0)
  private material: THREE.MeshBasicNodeMaterial
  private layer = -1
  private level = 0

  constructor(time: WorldCtx['uTime']) {
    const u = uv().x
    const v = uv().y
    // bright at the floor, fading out toward the top edge
    const fall = float(1).sub(v).pow(1.6).mul(float(1).sub(smoothstep(0.75, 1, v)))
    const base = smoothstep(0.06, 0, v).mul(1.4)
    const bands = sin(v.mul(22).sub(time.mul(2.6))).mul(0.5).add(0.5).pow(6)
    const ripple = sin(u.mul(0.06).add(time.mul(1.3))).mul(0.15).add(0.85)
    const flicker = mix(float(1), sin(time.mul(38)).mul(0.35).add(0.65), this.uFlicker)
    const m = new THREE.MeshBasicNodeMaterial()
    m.transparent = true
    m.depthWrite = false
    m.blending = THREE.AdditiveBlending
    m.side = THREE.DoubleSide
    m.fog = false
    m.colorNode = uniform(COLOR).mul(fall.mul(bands.mul(0.7).add(0.25)).add(base).mul(ripple).mul(flicker).mul(this.uLevel))
    m.opacityNode = float(1)
    m.name = 'HillField'
    this.material = m
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), m)
    this.mesh.name = 'hill-field'
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 4
    this.mesh.visible = false
  }

  /** One quad per outline edge, u = distance along the edge (game units), v = 0 floor .. 1 top. */
  private build(layer: number): void {
    const edges = hillOutline(layer)
    const pos = new Float32Array(edges.length * 4 * 3)
    const uvs = new Float32Array(edges.length * 4 * 2)
    const index: number[] = []
    edges.forEach(([x0, y0, x1, y1], i) => {
      const len = Math.hypot(x1 - x0, y1 - y0)
      const corners = [[x0, y0, 0, 0], [x1, y1, len, 0], [x1, y1, len, 1], [x0, y0, 0, 1]]
      corners.forEach(([x, y, cu, cv], k) => {
        pos.set([x * S, cv * HEIGHT * S, -y * S], (i * 4 + k) * 3)
        uvs.set([cu, cv], (i * 4 + k) * 2)
      })
      index.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3)
    })
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
    geo.setIndex(index)
    this.mesh.geometry.dispose()
    this.mesh.geometry = geo
    this.layer = layer
  }

  /**
   * layer: the hill's layer now (0 = no hill). opensIn: seconds until the field drops, null when
   * it is down. dt in seconds.
   */
  update(layer: number, opensIn: number | null, floorH: number, dt: number): void {
    const up = layer > 1 && opensIn !== null && opensIn > 0
    // rises quickly at the fight start, sinks a little slower so the drop reads
    this.level += ((up ? 1 : 0) - this.level) * Math.min(1, dt * (up ? 8 : 5))
    this.mesh.visible = this.level > 0.01 && layer > 1
    if (!this.mesh.visible) return
    if (layer !== this.layer) this.build(layer)
    this.mesh.position.set(0, floorH * S, 0)
    this.mesh.scale.set(1, Math.max(0.001, this.level), 1)
    this.uLevel.value = this.level
    this.uFlicker.value = up && opensIn! < 1 ? 1 : 0
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
