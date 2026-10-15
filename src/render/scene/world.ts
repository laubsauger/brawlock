import * as THREE from 'three/webgpu'
import { Fn, Loop, dot, float, max, positionWorld, texture, uniform, uniformArray, vec2, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import { SDF_EXTENT, SDF_RANGE, SDF_RES, writeArenaSdf } from '../arenaGeom'
import { S } from '../coords'
import type { TierConfig } from '../quality'
import { getNoiseTexture } from './noiseTexture'

/** Cast helpers for nodes the typings widen (uniform array elements, buffer attributes). */
export const asV4 = (n: unknown) => n as Node<'vec4'>
export const asV3 = (n: unknown) => n as Node<'vec3'>
export const asF = (n: unknown) => n as Node<'float'>

/** Fragment/vertex world position in game units (x, y). */
export const gamePos = (): Node<'vec2'> => vec2(positionWorld.x, positionWorld.z.negate()).div(S)

/**
 * Fake point lights: projectiles and blasts light the floor through a small
 * uniform array summed in the tile and pawn shaders. Far cheaper than real
 * point lights in a forward renderer.
 */
export const GLOW_N = 12

export class GlowLights {
  readonly pos: THREE.Vector4[] = []
  readonly col: THREE.Vector4[] = []
  readonly posNode
  readonly colNode
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
  }

  /** TSL: summed glow colour at a game-space position. */
  at(p: Node<'vec2'>): Node<'vec3'> {
    const posNode = this.posNode
    const colNode = this.colNode
    return Fn(() => {
      const acc = vec3(0).toVar()
      Loop(GLOW_N, ({ i }) => {
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
  noise: THREE.DataTexture
  field: ArenaField
  glow: GlowLights
  tier: TierConfig
}

export function createWorldCtx(tier: TierConfig, fx: number): WorldCtx {
  return {
    uTime: uniform(0),
    uFx: uniform(fx),
    noise: getNoiseTexture(),
    field: new ArenaField(),
    glow: new GlowLights(),
    tier,
  }
}
