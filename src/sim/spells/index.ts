/**
 * Behavior registry. To add a spell: write spells/<name>.ts with a SpellBehavior (and
 * ProjectileBehavior / ModifierBehavior as needed) and register them here. It becomes buyable
 * only once it is also listed in RELEASED_SPELLS (spells/data.ts).
 */
import { registerModifiers } from '../modifiers'
import { setProjectileBehaviorLookup } from '../projectiles'
import type { SpellId } from '../types'
import { PASSIVE_ITEMS } from './data'
import { MOD_ALTERATION, alterationModifier, alterationSpell } from './alteration'
import { boomerangProjectile, boomerangSpell } from './boomerang'
import { bouncerProjectile, bouncerSpell } from './bouncer'
import { clusterSpell } from './cluster'
import { MOD_DRAIN_HASTE, MOD_DRAIN_SLOW, drainHasteModifier, drainHealProjectile, drainProjectile, drainSlowModifier, drainSpell } from './drain'
import { fireballProjectile, fireballSpell, simpleProjectile } from './fireball'
import { gravityProjectile, gravitySpell } from './gravity'
import { MOD_GRIP, gripModifier, gripProjectile, gripSpell } from './grip'
import { MOD_HOMING_HASTE, homingHasteModifier, homingProjectile, homingSpell } from './homing'
import { lightningSpell } from './lightning'
import { MOD_LINK, linkModifier, linkProjectile, linkSpell } from './link'
import { MOD_MAGNETIZE, magnetizeModifier, magnetizeProjectile, magnetizeSpell } from './magnetize'
import { meteorProjectile, meteorSpell } from './meteor'
import { MOD_PACT, MOD_PACT_SLOW, pactModifier, pactSlowModifier, pactSpell } from './pact'
import { MOD_RECHARGE_STREAK, rechargeProjectile, rechargeRefreshProjectile, rechargeSpell, rechargeStreakModifier } from './recharge'
import { MOD_REDIRECTOR_PENALTY, redirectorSpell } from './redirector'
import { rockpillarSpell } from './rockpillar'
import { MOD_RUSH, rushModifier, rushSpell } from './rush'
import { scourgeSpell } from './scourge'
import { MOD_SHIELD, shieldModifier, shieldSpell } from './shield'
import { MOD_SNOWBALL, snowballModifier, snowballProjectile, snowballSpell } from './snowball'
import { splitterProjectile, splitterSpawnerProjectile, splitterSpell } from './splitter'
import { swapProjectile, swapSpell } from './swap'
import { teleportSpell } from './teleport'
import { MOD_THRUST, thrustModifier, thrustSpell } from './thrust'
import { twinProjectile, twinSpell } from './twin'
import { warpzoneProjectile, warpzoneSpell } from './warpzone'
import { MOD_WINDWALK, windwalkModifier, windwalkSpell } from './windwalk'
import type { ProjectileBehavior, SpellBehavior } from './types'

export const SPELL_BEHAVIORS: Readonly<Record<SpellId, SpellBehavior>> = {
  fireball: fireballSpell,
  scourge: scourgeSpell,
  teleport: teleportSpell,
  thrust: thrustSpell,
  swap: swapSpell,
  lightning: lightningSpell,
  boomerang: boomerangSpell,
  homing: homingSpell,
  twin: twinSpell,
  redirector: redirectorSpell,
  pact: pactSpell,
  cluster: clusterSpell,
  drain: drainSpell,
  bouncer: bouncerSpell,
  recharge: rechargeSpell,
  shield: shieldSpell,
  rush: rushSpell,
  alteration: alterationSpell,
  windwalk: windwalkSpell,
  meteor: meteorSpell,
  splitter: splitterSpell,
  snowball: snowballSpell,
  gravity: gravitySpell,
  grip: gripSpell,
  warpzone: warpzoneSpell,
  magnetize: magnetizeSpell,
  rockpillar: rockpillarSpell,
  link: linkSpell,
}

/** keyed by ProjectileState.kind ?? spell */
export const PROJECTILE_BEHAVIORS: Readonly<Record<string, ProjectileBehavior>> = {
  fireball: fireballProjectile,
  swap: swapProjectile,
  boomerang: boomerangProjectile,
  homing: homingProjectile,
  twin: twinProjectile,
  cluster: simpleProjectile,
  drain: drainProjectile,
  drainHeal: drainHealProjectile,
  bouncer: bouncerProjectile,
  recharge: rechargeProjectile,
  rechargeRefresh: rechargeRefreshProjectile,
  meteor: meteorProjectile,
  splitter: splitterProjectile,
  splitterSpawner: splitterSpawnerProjectile,
  splitterChild: simpleProjectile,
  snowball: snowballProjectile,
  gravity: gravityProjectile,
  grip: gripProjectile,
  warpzone: warpzoneProjectile,
  magnetize: magnetizeProjectile,
  link: linkProjectile,
}

registerModifiers({
  [MOD_THRUST]: thrustModifier,
  [MOD_HOMING_HASTE]: homingHasteModifier,
  [MOD_PACT]: pactModifier,
  [MOD_PACT_SLOW]: pactSlowModifier,
  [MOD_REDIRECTOR_PENALTY]: { temporary: true },
  [MOD_DRAIN_SLOW]: drainSlowModifier,
  [MOD_DRAIN_HASTE]: drainHasteModifier,
  [MOD_RECHARGE_STREAK]: rechargeStreakModifier,
  [MOD_SHIELD]: shieldModifier,
  [MOD_RUSH]: rushModifier,
  [MOD_ALTERATION]: alterationModifier,
  [MOD_WINDWALK]: windwalkModifier,
  [MOD_SNOWBALL]: snowballModifier,
  [MOD_GRIP]: gripModifier,
  [MOD_MAGNETIZE]: magnetizeModifier,
  [MOD_LINK]: linkModifier,
})

setProjectileBehaviorLookup((kind) => PROJECTILE_BEHAVIORS[kind])

/** Has sim behavior (spells, active items, passive items). Buyable = RELEASED_SPELLS. */
export const IMPLEMENTED_SPELLS: ReadonlySet<SpellId> = new Set<SpellId>([...Object.keys(SPELL_BEHAVIORS), ...Object.keys(PASSIVE_ITEMS)])

export * from './data'
export type { CastContext, ProjectileBehavior, SpellBehavior } from './types'
