import * as THREE from 'three/webgpu'
import { OBSTACLE_RADII } from '../../../sim/config'
import { buildPillar, type PillarShape } from './pillars'

/**
 * Pillar shape cache. Every shape the sim can ask for (each theme's variant
 * radii, the Rockpillar) exists in SHAPE_SLOTS seeded versions; a pillar's
 * seed picks a slot and its own yaw, so a round never builds geometry.
 *
 * prefetchShapes() builds them all in a module worker (no main-thread cost);
 * a lookup before the worker delivered builds synchronously instead. Shapes
 * live for the page: their geometry is shared by every visual and never
 * disposed by one.
 */

export const SHAPE_SLOTS = 2
/** Rockpillar collision radius (sim spell data, consts.radius) */
const ROCKPILLAR_R = 90

export interface ShapeSpec {
  key: string
  theme: number
  variant: number
  radius: number
  seed: number
}

const cache = new Map<string, PillarShape>()
const listeners = new Set<(key: string) => void>()

export const slotOf = (seed: number): number => Math.abs(Math.floor(seed)) % SHAPE_SLOTS

export function shapeSpec(theme: number, variant: number, radius: number, seed: number): ShapeSpec {
  const slot = slotOf(seed)
  const t = ((theme % 3) + 3) % 3
  const key = variant < 0 ? `rp:${radius}:${slot}` : `${t}:${variant}:${radius}:${slot}`
  return { key, theme: t, variant, radius, seed: 101 + slot * 7919 + (variant + 1) * 31 }
}

/** Every shape a match can need. */
export function allShapeSpecs(): ShapeSpec[] {
  const out: ShapeSpec[] = []
  for (let slot = 0; slot < SHAPE_SLOTS; slot++) {
    OBSTACLE_RADII.forEach((radii, theme) => radii.forEach((radius, variant) => out.push(shapeSpec(theme, variant, radius, slot))))
    out.push(shapeSpec(0, -1, ROCKPILLAR_R, slot))
  }
  // dedupe (themes repeat radii per variant index, keys include the variant)
  return [...new Map(out.map((s) => [s.key, s])).values()]
}

export function cachedShape(key: string): PillarShape | undefined {
  return cache.get(key)
}

/** Cached shape; builds now on a miss (only before the worker delivered). */
export function pillarShape(theme: number, variant: number, radius: number, seed: number): PillarShape {
  const sp = shapeSpec(theme, variant, radius, seed)
  let s = cache.get(sp.key)
  if (!s) {
    s = buildPillar(sp.theme, sp.variant, sp.radius, sp.seed)
    cache.set(sp.key, s)
    for (const l of listeners) l(sp.key)
  }
  return s
}

/** Notified once per shape when it lands in the cache. Returns an unsubscribe. */
export function onShapeReady(fn: (key: string) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// ------------------------------------------------------------------ worker

/** Plain arrays a worker can transfer. */
export interface ShapeMsg {
  key: string
  attrs: Record<string, Float32Array>
  crystals: Record<string, Float32Array> | null
  height: number
  chunks: PillarShape['chunks']
  kind: PillarShape['kind']
}

export const SHAPE_ATTRS: [string, number][] = [
  ['position', 3],
  ['normal', 3],
  ['aInfo', 3],
  ['aBand', 2],
  ['aUV', 3],
]

export function geometryFromArrays(attrs: Record<string, Float32Array>): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  for (const [name, size] of SHAPE_ATTRS) if (attrs[name]) g.setAttribute(name, new THREE.BufferAttribute(attrs[name], size))
  g.computeBoundingSphere()
  g.computeBoundingBox()
  return g
}

let worker: Worker | null = null
let requested = false

/** Build every shape off the main thread; idempotent. Falls back to lazy sync builds. */
export function prefetchShapes(): void {
  if (requested) return
  requested = true
  if (typeof Worker === 'undefined') return
  try {
    worker = new Worker(new URL('./pillarWorker.ts', import.meta.url), { type: 'module' })
  } catch {
    worker = null
    return
  }
  worker.onmessage = (e: MessageEvent<ShapeMsg | 'done'>) => {
    const m = e.data
    if (m === 'done') {
      worker?.terminate()
      worker = null
      return
    }
    if (cache.has(m.key)) return
    cache.set(m.key, { geometry: geometryFromArrays(m.attrs), crystals: m.crystals ? geometryFromArrays(m.crystals) : null, height: m.height, chunks: m.chunks, kind: m.kind })
    for (const l of listeners) l(m.key)
  }
  worker.onerror = () => {
    worker?.terminate()
    worker = null
  }
  worker.postMessage(allShapeSpecs().filter((s) => !cache.has(s.key)))
}
