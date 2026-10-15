/**
 * Workstream B frame driver: resets kitB's per-frame pools exactly once per rendered frame through
 * render's beginFrame hook (also runs for frozen frames: hit-stop, pause, dt = 0), and draws the
 * cast level glyphs.
 */
import type { SimEvent } from '../../../sim/types'
import { registerSpellVfx, type VfxCtx } from '../registry'
import { castGlyph, drawGlyphs, kitFrameReset, kitInit, kitRelease, levelOfThing, pal, tierOfLevel, type RGB } from './kitB'

/** workstream B spells and their glyph colour (palette accent / core) */
const GLYPH: Record<string, RGB> = {}
for (const id of ['meteor', 'splitter', 'snowball', 'windwalk', 'shield', 'rush', 'alteration', 'gravity', 'grip', 'warpzone', 'magnetize', 'rockpillar', 'link']) {
  GLYPH[id] = pal(id, id === 'gravity' || id === 'meteor' ? 'core' : 'accent', 1.3)
}

registerSpellVfx({
  spell: '__frameB',
  init(ctx: VfxCtx) {
    kitInit(ctx)
  },
  dispose() {
    kitRelease()
  },
  onEvent(e: SimEvent, ctx: VfxCtx) {
    // brief level glyph over the caster for every workstream-B cast (power tier = pips)
    if (e.type !== 'cast') return
    const c = GLYPH[e.spell]
    if (c) castGlyph(ctx, e.pawn, tierOfLevel(ctx, levelOfThing(e)), c)
  },
  beginFrame() {
    kitFrameReset()
  },
  frame(ctx: VfxCtx) {
    drawGlyphs(ctx)
  },
})
