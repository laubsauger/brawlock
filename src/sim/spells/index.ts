/**
 * Behavior registry. To add a spell: write spells/<name>.ts with a SpellBehavior (and a
 * ProjectileBehavior if it shoots), register both here, set `implemented: true` in data.ts.
 */
import type { SpellId } from '../types'
import { fireballProjectile, fireballSpell } from './fireball'
import { scourgeSpell } from './scourge'
import { teleportSpell } from './teleport'
import type { ProjectileBehavior, SpellBehavior } from './types'

export const SPELL_BEHAVIORS: Readonly<Record<SpellId, SpellBehavior>> = {
  fireball: fireballSpell,
  scourge: scourgeSpell,
  teleport: teleportSpell,
}

/** keyed by ProjectileState.spell */
export const PROJECTILE_BEHAVIORS: Readonly<Record<SpellId, ProjectileBehavior>> = {
  fireball: fireballProjectile,
}

export * from './data'
export type { CastContext, ProjectileBehavior, SpellBehavior } from './types'
