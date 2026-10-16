/**
 * Builds pillar shapes off the main thread (shapes.ts prefetchShapes): the
 * seeded displacement, creased normals and merging cost a few ms per shape,
 * which at shop start would stack into a dropped frame.
 */
import { buildPillar } from './pillars'
import { SHAPE_ATTRS, type ShapeMsg, type ShapeSpec } from './shapes'

const pack = (g: { getAttribute(n: string): { array: ArrayLike<number> } | undefined }): Record<string, Float32Array> => {
  const out: Record<string, Float32Array> = {}
  for (const [name] of SHAPE_ATTRS) {
    const a = g.getAttribute(name)
    if (a) out[name] = a.array as Float32Array
  }
  return out
}

self.onmessage = (e: MessageEvent<ShapeSpec[]>) => {
  for (const sp of e.data) {
    const s = buildPillar(sp.theme, sp.variant, sp.radius, sp.seed)
    const msg: ShapeMsg = { key: sp.key, attrs: pack(s.geometry), crystals: s.crystals ? pack(s.crystals) : null, height: s.height, chunks: s.chunks, kind: s.kind }
    const transfer = [...Object.values(msg.attrs), ...(msg.crystals ? Object.values(msg.crystals) : [])].map((a) => a.buffer)
    ;(self as unknown as Worker).postMessage(msg, transfer)
  }
  ;(self as unknown as Worker).postMessage('done')
}
