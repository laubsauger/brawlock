/**
 * Workstream A frame driver: resets kitA's per-frame batches exactly once per rendered frame
 * (registry beginFrame, also on frozen frames). Imported FIRST in the workstream-A block of
 * spells/index.ts.
 */
import { registerSpellVfx, type VfxCtx } from '../registry'
import { acquireKit, releaseKit, type KitA } from './kitA'

let K: KitA | null = null

registerSpellVfx({
  spell: '__frameA',
  init(ctx: VfxCtx) {
    K = acquireKit(ctx)
  },
  dispose() {
    releaseKit(K)
    K = null
  },
  beginFrame() {
    K?.beginFrame()
  },
})
