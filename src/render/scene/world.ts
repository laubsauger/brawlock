import * as THREE from 'three/webgpu'
import { Fn, Loop, cameraWorldMatrix, cos, dot, float, int, max, mix, positionGeometry, positionWorld, sin, smoothstep, texture, uniform, uniformArray, varying, vec2, vec3, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import { SDF_EXTENT, SDF_RANGE, SDF_RES, writeArenaSdf } from '../arenaGeom'
import { LAVA_H, S, TILE_TOP_H } from '../coords'
import type { TierConfig } from '../quality'
import { getNoiseTexture } from './noiseTexture'

/** Key (moon) light direction, three world space, pointing TOWARD the light. */
// Moon at ~52 degrees elevation from the far upper-left of the view: cast
// shadows fall toward the lower-right of the screen, beside the body (~0.8x
// its height), like the original game. Toward the light, three world space.
export const KEY_LIGHT_ELEVATION = (52 * Math.PI) / 180
export const KEY_LIGHT_DIR = new THREE.Vector3(
  -0.33 * Math.cos(KEY_LIGHT_ELEVATION),
  Math.sin(KEY_LIGHT_ELEVATION),
  -0.944 * Math.cos(KEY_LIGHT_ELEVATION),
).normalize()

/** Cast helpers for nodes the typings widen (uniform array elements, buffer attributes). */
export const asV4 = (n: unknown) => n as Node<'vec4'>
export const asV3 = (n: unknown) => n as Node<'vec3'>
export const asF = (n: unknown) => n as Node<'float'>

/**
 * Smallest InstancedMesh capacity whose matrix array exceeds WebGPU's default
 * 64 KiB uniform-buffer limit (the renderer requests no higher limit).
 */
export const STATIC_INSTANCE_CAPACITY = 65536 / 64 + 1

/**
 * InstancedMesh for matrices set once. three keeps an instance-matrix array
 * that fits the uniform limit in a per-object uniform buffer and re-uploads
 * all of it every frame and every pass, moving or not; that buffer is also
 * declared per object, so every such mesh compiles its own shader and
 * pipeline. Above the limit the matrices live in a vertex attribute uploaded
 * only on change, and meshes sharing a material share one pipeline. The
 * padded capacity picks that path; `count` stays the real instance count.
 */
export function staticInstancedMesh(geometry: THREE.BufferGeometry, material: THREE.Material, count: number): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(count, STATIC_INSTANCE_CAPACITY))
  mesh.count = count
  return mesh
}

/** Fragment/vertex world position in game units (x, y). */
export const gamePos = (): Node<'vec2'> => vec2(positionWorld.x, positionWorld.z.negate()).div(S)

/**
 * Fake point lights: projectiles and blasts light the floor through a small
 * uniform array summed in the tile and pawn shaders. Far cheaper than real
 * point lights in a forward renderer.
 */
export const GLOW_N = 12
/** max summed intensity x brightness of all fake lights per frame */
const GLOW_BUDGET = 4

export class GlowLights {
  readonly pos: THREE.Vector4[] = []
  readonly col: THREE.Vector4[] = []
  readonly posNode
  readonly colNode
  /** lights in use this frame: the shader loop stops there (unused slots add exactly 0) */
  readonly countNode = uniform(0, 'int')
  private n = 0

  constructor() {
    for (let i = 0; i < GLOW_N; i++) {
      this.pos.push(new THREE.Vector4(0, 0, 1, 0))
      this.col.push(new THREE.Vector4(0, 0, 0, 0))
    }
    this.posNode = uniformArray(this.pos, 'vec4')
    this.colNode = uniformArray(this.col, 'vec4')
  }

  begin(): void {
    this.n = 0
  }

  /** x, y game units; radius game units; rgb linear; intensity multiplier. */
  add(x: number, y: number, radius: number, intensity: number, r: number, g: number, b: number): void {
    if (this.n >= GLOW_N || intensity <= 0) return
    this.pos[this.n].set(x, y, radius, intensity)
    this.col[this.n].set(r, g, b, 0)
    this.n++
  }

  end(): void {
    for (let i = this.n; i < GLOW_N; i++) this.pos[i].w = 0
    this.countNode.value = this.n
    // budget: stacked lights (many simultaneous blasts) are scaled down together
    let sum = 0
    for (let i = 0; i < this.n; i++) sum += this.pos[i].w * Math.max(this.col[i].x, this.col[i].y, this.col[i].z)
    if (sum > GLOW_BUDGET) {
      const k = GLOW_BUDGET / sum
      for (let i = 0; i < this.n; i++) this.pos[i].w *= k
    }
  }

  /** TSL: summed glow colour at a game-space position. */
  at(p: Node<'vec2'>): Node<'vec3'> {
    const posNode = this.posNode
    const colNode = this.colNode
    const count = this.countNode
    return Fn(() => {
      const acc = vec3(0).toVar()
      Loop({ start: int(0), end: count, type: 'int', condition: '<' }, ({ i }) => {
        const L = asV4(posNode.element(i))
        const d = p.sub(L.xy)
        const f = max(float(0), float(1).sub(dot(d, d).div(L.z.mul(L.z))))
        acc.addAssign(asV4(colNode.element(i)).xyz.mul(f.mul(f).mul(L.w)))
      })
      return acc
    })() as unknown as Node<'vec3'>
  }
}

/**
 * Platform signed distance field (positive over lava, game units) as a
 * texture, rebuilt when the arena layer changes.
 */
export class ArenaField {
  readonly texture: THREE.DataTexture
  private data: Uint8Array
  layer = -1

  constructor() {
    this.data = new Uint8Array(SDF_RES * SDF_RES * 4)
    this.texture = new THREE.DataTexture(this.data, SDF_RES, SDF_RES, THREE.RGBAFormat, THREE.UnsignedByteType)
    this.texture.magFilter = THREE.LinearFilter
    this.texture.minFilter = THREE.LinearFilter
    this.texture.wrapS = THREE.ClampToEdgeWrapping
    this.texture.wrapT = THREE.ClampToEdgeWrapping
    this.texture.colorSpace = THREE.NoColorSpace
    this.setLayer(1)
  }

  setLayer(layer: number): void {
    if (layer === this.layer) return
    this.layer = layer
    writeArenaSdf(layer, this.data)
    this.texture.needsUpdate = true
  }

  /** TSL: signed distance (game units) at a game-space position. */
  sample(p: Node<'vec2'>): Node<'float'> {
    const uvp = p.add(SDF_EXTENT).div(SDF_EXTENT * 2)
    return texture(this.texture, uvp).r.sub(0.5).mul(SDF_RANGE * 2)
  }

  dispose(): void {
    this.texture.dispose()
  }
}

const makeFloatUniform = () => uniform(0)
export type FloatUniform = ReturnType<typeof makeFloatUniform>

export interface WorldCtx {
  /** render clock, seconds since the world was created */
  uTime: FloatUniform
  /** 0..1 fx intensity setting */
  uFx: FloatUniform
  /** Decorative motion may be suppressed while cast progress remains readable. */
  motion: boolean
  noise: THREE.DataTexture
  field: ArenaField
  glow: GlowLights
  tier: TierConfig
}

export function createWorldCtx(tier: TierConfig, fx: number): WorldCtx {
  return {
    uTime: uniform(0),
    uFx: uniform(fx),
    motion: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    noise: getNoiseTexture(),
    field: new ArenaField(),
    glow: new GlowLights(),
    tier,
  }
}

/**
 * Soft-particle fade for camera-facing sprites: reconstructs each fragment's
 * world position from the sprite centre, its view-space corner offset and the
 * camera basis, then fades the sprite out as it approaches the floor (tile
 * top, or the lava surface where the arena SDF says lava). Removes the hard
 * straight edge where a sprite cuts into the ground. `soft` in game units.
 */
export function spriteGroundFade(
  center: Node<'vec3'>,
  scale: Node<'vec2'>,
  rotation: Node<'float'>,
  field: ArenaField,
  soft = 22,
): Node<'float'> {
  const corner = positionGeometry.xy.mul(scale)
  const c = cos(rotation)
  const s = sin(rotation)
  const rot = vec2(corner.x.mul(c).sub(corner.y.mul(s)), corner.x.mul(s).add(corner.y.mul(c)))
  const worldOff = cameraWorldMatrix.mul(vec4(rot, 0, 0)).xyz
  const wp = varying(center.add(worldOff))
  const sd = field.sample(vec2(wp.x, wp.z.negate()).div(S))
  // blend the floor height across the shore (no hard vertical cut on big sprites)
  const floorY = mix(float(TILE_TOP_H * S), float(LAVA_H * S), smoothstep(-25, 25, sd))
  return smoothstep(floorY, floorY.add(soft * S), wp.y)
}
