import * as THREE from 'three/webgpu'
import { CORNER_NN, CORNER_NP, CORNER_PN, CORNER_PP, TILE_SIZE } from '../arenaGeom'
import { S, TILE_BOTTOM_H, TILE_TOP_H } from '../coords'

/**
 * Procedural tile slab for one corner mask: rounded footprint, chamfered top
 * edge, straight sides into the lava. Built in world scale with the origin at
 * the tile centre on the lava surface, so instances only need a translation.
 *
 * Visual-only rounding radius is larger than the original's 9.65 units so the
 * soft edge silhouette reads at gameplay zoom; which corners round follows the
 * original rule exactly (arenaGeom.cornerMask).
 */
const GAP = 4 // grout between neighbouring tiles (game units)
const HALF = TILE_SIZE / 2 - GAP / 2
const RADIUS = 30
const BEVEL = 6
const ARC_SEGS = 6

/** CCW outline in game (u, v), corners +x+y, -x+y, -x-y, +x-y. */
function outline(half: number, radius: number, mask: number): [number, number][] {
  const corners: [number, number, number, number][] = [
    [1, 1, 0, CORNER_PP],
    [-1, 1, Math.PI / 2, CORNER_NP],
    [-1, -1, Math.PI, CORNER_NN],
    [1, -1, (Math.PI * 3) / 2, CORNER_PN],
  ]
  const pts: [number, number][] = []
  for (const [sx, sy, a0, bit] of corners) {
    if (mask & bit) {
      const cx = sx * (half - radius)
      const cy = sy * (half - radius)
      for (let k = 0; k <= ARC_SEGS; k++) {
        const a = a0 + (k / ARC_SEGS) * (Math.PI / 2)
        pts.push([cx + Math.cos(a) * radius, cy + Math.sin(a) * radius])
      }
    } else {
      pts.push([sx * half, sy * half])
    }
  }
  return pts
}

export function buildTileGeometry(mask: number): THREE.BufferGeometry {
  const outer = outline(HALF, RADIUS, mask)
  const inner = outline(HALF - BEVEL, RADIUS - BEVEL, mask)
  const pos: number[] = []
  const nrm: number[] = []
  const top = TILE_TOP_H
  const bevelY = TILE_TOP_H - BEVEL
  const bottom = TILE_BOTTOM_H

  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const e1 = new THREE.Vector3()
  const e2 = new THREE.Vector3()
  const n = new THREE.Vector3()

  // game (u, v, h) -> three local (u, h, -v) in world scale
  const tri = (p0: number[], p1: number[], p2: number[], normal: THREE.Vector3) => {
    a.set(p0[0] * S, p0[2] * S, -p0[1] * S)
    b.set(p1[0] * S, p1[2] * S, -p1[1] * S)
    c.set(p2[0] * S, p2[2] * S, -p2[1] * S)
    e1.subVectors(b, a)
    e2.subVectors(c, a)
    n.crossVectors(e1, e2)
    const flip = n.dot(normal) < 0
    const list = flip ? [a, c, b] : [a, b, c]
    for (const v of list) {
      pos.push(v.x, v.y, v.z)
      nrm.push(normal.x, normal.y, normal.z)
    }
  }

  const up = new THREE.Vector3(0, 1, 0)
  // top face: fan around the centre (inner outline is convex)
  for (let i = 0; i < inner.length; i++) {
    const p = inner[i]
    const q = inner[(i + 1) % inner.length]
    tri([0, 0, top], [p[0], p[1], top], [q[0], q[1], top], up)
  }
  const sideN = new THREE.Vector3()
  const bevN = new THREE.Vector3()
  for (let i = 0; i < outer.length; i++) {
    const o0 = outer[i]
    const o1 = outer[(i + 1) % outer.length]
    const i0 = inner[i]
    const i1 = inner[(i + 1) % inner.length]
    // outward edge normal in game space (CCW polygon): (dv, -du)
    const du = o1[0] - o0[0]
    const dv = o1[1] - o0[1]
    const len = Math.hypot(du, dv) || 1
    const nu = dv / len
    const nv = -du / len
    sideN.set(nu, 0, -nv)
    bevN.set(nu, 1, -nv).normalize()
    // chamfer
    tri([i0[0], i0[1], top], [o0[0], o0[1], bevelY], [o1[0], o1[1], bevelY], bevN)
    tri([i0[0], i0[1], top], [o1[0], o1[1], bevelY], [i1[0], i1[1], top], bevN)
    // side wall
    tri([o0[0], o0[1], bevelY], [o0[0], o0[1], bottom], [o1[0], o1[1], bottom], sideN)
    tri([o0[0], o0[1], bevelY], [o1[0], o1[1], bottom], [o1[0], o1[1], bevelY], sideN)
  }

  // uv matching the shader's world-planar mapping (before the per-tile
  // rotation): tops/bevels (x, -z) / 192, walls (x - z, y) / 192. The
  // derivative tangent frame for normal maps is built from this attribute.
  const uvs: number[] = []
  const k = 1 / (TILE_SIZE * S)
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i]
    const y = pos[i + 1]
    const z = pos[i + 2]
    if (Math.abs(nrm[i + 1]) > 0.3) uvs.push(x * k, -z * k)
    else uvs.push((x - z) * k, y * k)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  g.computeBoundingSphere()
  return g
}
