/**
 * Teleport (spells.md §8.9). IMMEDIATE, no cast point. Destination = cursor clamped to the
 * level's range (no range mastery), no lava/obstacle checks, velocity x 0.8, then Stop().
 *
 * The original scales the total velocity (knockback + walk) by 0.8 and the next pre-tick then
 * removes the full previous walk velocity, leaving a -0.2 x walk residue. We scale only the
 * physics (knockback) part and clear the walk part, which is what Stop() intends.
 */
import { attr } from './data'
import type { SpellBehavior } from './types'

export const teleportSpell: SpellBehavior = {
  onCast({ state, caster, def, level, x, y }) {
    const range = attr(def, 'range', level)
    let dx = x - caster.x
    let dy = y - caster.y
    const d = Math.sqrt(dx * dx + dy * dy)
    if (d > range) {
      dx = (dx / d) * range
      dy = (dy / d) * range
    }
    const fromX = caster.x
    const fromY = caster.y
    caster.x = fromX + dx
    caster.y = fromY + dy
    const keep = attr(def, 'velocity_keep', level)
    caster.vx = (caster.vx - caster.walkVx) * keep
    caster.vy = (caster.vy - caster.walkVy) * keep
    caster.walkVx = 0
    caster.walkVy = 0
    caster.moveTarget = null
    caster.cast = null
    state.events.push({ type: 'teleport', pawn: caster.id, fromX, fromY, toX: caster.x, toY: caster.y })
  },
}
