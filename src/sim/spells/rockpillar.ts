/**
 * Rockpillar (spells.md §8.27). An obstacle at the cursor clamped to 650..1100 (no range
 * mastery): r90, 400 HP, static, neutral (enemy to everyone, the caster included), gone after
 * 4 s x dm (real time) or at round start. Behaves exactly like an arena pillar: warlocks bounce /
 * are pushed out, projectiles react per their own pillar rules, and at 0 HP it explodes for
 * 5..10 to every warlock within 300.
 */
import { OBSTACLE_HP, ticks } from '../config'
import { durationFactor } from '../stats'
import { attr } from './data'
import type { SpellBehavior } from './types'
import { clampTarget } from './util'

export const rockpillarSpell: SpellBehavior = {
  onCast(ctx) {
    const { state, caster, def, level } = ctx
    const t = clampTarget(ctx, attr(def, 'range', level))
    state.obstacles.push({
      id: state.nextEntityId++,
      x: t.x,
      y: t.y,
      radius: attr(def, 'radius', level),
      hp: attr(def, 'hp', level) || OBSTACLE_HP,
      variant: -1,
      ticksLeft: ticks(attr(def, 'duration', level) * durationFactor(state, caster.owner)),
      owner: caster.owner,
    })
  },
}
