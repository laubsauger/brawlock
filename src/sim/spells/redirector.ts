/**
 * Redirector (spells.md §8.3). Re-aims the caster's own projectile nearest the cursor toward the
 * cursor (speed kept) and extends a timed one by 0.5 s x rm. The original re-applied range
 * mastery to the remaining lifetime as well (§12.6); v1 applies it once, to the bonus only.
 * Always (even with nothing to redirect): +30% knockback taken for 8 s x own debuff factor.
 * Meteor and the Warpzone actor cannot be redirected.
 */
import { addModifier } from '../modifiers'
import { behaviorOf, isAlive, isProjectileInstance } from '../projectiles'
import { debuffFactor, rangeFactor } from '../stats'
import { ticks } from '../config'
import { TICK_HZ } from '../types'
import type { ProjectileState } from '../types'
import { attr } from './data'
import type { SpellBehavior } from './types'

export const MOD_REDIRECTOR_PENALTY = 'redirectorPenalty'

export const redirectorSpell: SpellBehavior = {
  onCast(ctx) {
    const { state, caster, def, level, x, y } = ctx
    let best: ProjectileState | null = null
    let bd = Infinity
    for (const p of state.projectiles) {
      if (!isAlive(p) || p.owner !== caster.owner || !isProjectileInstance(p) || behaviorOf(p)?.noSteer) continue
      const d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y)
      if (d < bd) {
        bd = d
        best = p
      }
    }
    if (best) {
      const speed = Math.sqrt(best.vx * best.vx + best.vy * best.vy)
      const dx = x - best.x
      const dy = y - best.y
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d > 0) {
        best.vx = (dx / d) * speed
        best.vy = (dy / d) * speed
      }
      if (best.data.noTimer !== 1) best.ticksLeft += attr(def, 'lifetime_bonus', level) * rangeFactor(state, caster.owner) * TICK_HZ
      state.events.push({ type: 'spellHit', spell: 'redirector', pawn: caster.id, target: best.id, x: best.x, y: best.y })
    }
    const seconds = attr(def, 'kb_penalty_duration', level) * debuffFactor(caster)
    addModifier(state, caster, MOD_REDIRECTOR_PENALTY, ticks(seconds), caster.owner, { kbReduction: attr(def, 'kb_penalty', level) })
  },
}
