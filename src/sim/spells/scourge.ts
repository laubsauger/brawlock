/**
 * Scourge / Scourge Incarnation (spells.md §8.2). No target, 0.9 s cancellable windup.
 * 1. damageArea(caster, 250): flat damage, knockback factor 0.75 (edge) .. 1.0 (centre).
 * 2. Self cost: hp = max(1, hp - cost), cost = damage at Lv1, 100 at Lv2/3. Cannot kill, no DP,
 *    no knockback, ignores combat (also costs HP in the shop phase).
 * 3. Lv2/3: caster DP -= dp_reduce x pawns in range.
 */
import { damageArea } from '../combat'
import { attr } from './data'
import type { SpellBehavior } from './types'

export const scourgeSpell: SpellBehavior = {
  onCast({ state, caster, def, level }) {
    const damage = attr(def, 'damage', level)
    const radius = attr(def, 'radius', level)
    state.events.push({ type: 'explosion', x: caster.x, y: caster.y, radius, spell: 'scourge' })
    const hits = damageArea(state, caster.owner, caster.x, caster.y, radius, {
      amount: damage,
      kbFactorMin: attr(def, 'kb_factor_min', level),
      kbFactorMax: attr(def, 'kb_factor_max', level),
    })
    const cost = level === 1 ? damage : attr(def, 'self_cost', level)
    caster.hp = Math.max(1, caster.hp - cost)
    const dpReduce = attr(def, 'dp_reduce', level)
    if (dpReduce > 0) caster.kbPoints = Math.max(0, caster.kbPoints - dpReduce * hits)
  },
}
