/**
 * Pawn modifiers (spells.md §6). Each modifier kind is a behavior with optional hooks;
 * `ModifierState` stays plain data. Spell modules register their behaviors in MODIFIERS
 * (see spells/index.ts). Stat deltas live in mod.data (keys in stats.ts) and are applied by
 * recomputeStats on every add / remove.
 *
 * Durations run on real game time (original GAME tasks), decremented once per tick.
 *
 * Modifier ids (render: look at pawn.modifiers and the 'modifier' events):
 *   spawnInvulnerable, thrust, windwalk (invisible), shield (data.radius), rush (data.absorbLeft),
 *   alteration (data.radius), grip, magnetize (data.sign +1 attract / -1 repel), link (data.target
 *   entity id, data.obstacle 1 = latched to a pillar), pact, pactSlow, redirectorPenalty,
 *   drainSlow, drainHaste, homingHaste (data.burnout 1 = Thrust combo), snowball (contact DoT),
 *   rechargeStreak (data.streak).
 */
import type { ColliderProfile, CollisionHit } from './collision'
import type { CastContext } from './spells/types'
import { recomputeStats } from './stats'
import type { ModifierState, PawnState, PlayerId, SimState } from './types'

export interface PawnCollider {
  radius: number
  profile: ColliderProfile
}

export interface DamageEvent {
  amount: number
  source: PlayerId | null
}

export interface ModifierBehavior {
  /** temporary modifiers are removed on death and at round reset (original `temporary`) */
  temporary: boolean
  onApply?(state: SimState, pawn: PawnState, mod: ModifierState): void
  /** `expired` = its timer ran out (Thrust brakes only then) */
  onRemove?(state: SimState, pawn: PawnState, mod: ModifierState, expired: boolean): void
  /** pawn pre-tick, after walking (original Pawn:onPreTick order) */
  onPreTick?(state: SimState, pawn: PawnState, mod: ModifierState): void
  /** the pawn casts a spell; runs before the spell executes (Pact, Windwalk, Grip, Link) */
  onSpellCast?(state: SimState, pawn: PawnState, mod: ModifierState, ctx: CastContext): void
  /** after knockback was computed; returns a damage delta (Rush absorb) */
  modifyDamagePostKB?(state: SimState, pawn: PawnState, mod: ModifierState, dmg: DamageEvent): number
  /** temporary collision component carried by this modifier (Shield, Alteration, Thrust, Windwalk) */
  collider?(state: SimState, pawn: PawnState, mod: ModifierState): PawnCollider | null
  /** this modifier's collider was notified of a collision */
  onColliderHit?(state: SimState, pawn: PawnState, mod: ModifierState, hit: CollisionHit): void
  /** body CC accept-mask changes while active: returns [allyMask, enemyMask] */
  bodyMask?(mod: ModifierState, ally: number, enemy: number): [number, number]
}

export const MOD_SPAWN_INVULNERABLE = 'spawnInvulnerable'

export const MODIFIERS: Record<string, ModifierBehavior> = {
  [MOD_SPAWN_INVULNERABLE]: {
    // a plain flag + 2 s task in the original, not a temporary modifier
    temporary: false,
    onApply(_s, pawn) {
      pawn.invulnerable = true
    },
    onRemove(_s, pawn) {
      pawn.invulnerable = false
    },
  },
}

export function registerModifiers(defs: Record<string, ModifierBehavior>): void {
  Object.assign(MODIFIERS, defs)
}

export function addModifier(
  state: SimState,
  pawn: PawnState,
  id: string,
  ticks: number,
  source: PlayerId | null,
  data: Record<string, number> = {},
): ModifierState {
  const mod: ModifierState = { id, ticksLeft: ticks, source, data }
  pawn.modifiers.push(mod)
  MODIFIERS[id]?.onApply?.(state, pawn, mod)
  recomputeStats(pawn)
  state.events.push({ type: 'modifier', pawn: pawn.id, id, on: true, source })
  return mod
}

export function removeModifierAt(state: SimState, pawn: PawnState, index: number, expired = false): void {
  const [mod] = pawn.modifiers.splice(index, 1)
  if (!mod) return
  MODIFIERS[mod.id]?.onRemove?.(state, pawn, mod, expired)
  recomputeStats(pawn)
  state.events.push({ type: 'modifier', pawn: pawn.id, id: mod.id, on: false, source: mod.source })
}

/** Remove one specific modifier instance (no-op if already gone). */
export function removeModifier(state: SimState, pawn: PawnState, mod: ModifierState, expired = false): void {
  const i = pawn.modifiers.indexOf(mod)
  if (i >= 0) removeModifierAt(state, pawn, i, expired)
}

export function hasModifier(pawn: PawnState, id: string): boolean {
  return pawn.modifiers.some((m) => m.id === id)
}

export function getModifier(pawn: PawnState, id: string): ModifierState | undefined {
  return pawn.modifiers.find((m) => m.id === id)
}

/** Remove every modifier of a kind. */
export function removeModifiers(state: SimState, pawn: PawnState, id: string): void {
  for (let i = pawn.modifiers.length - 1; i >= 0; i--) if (pawn.modifiers[i].id === id) removeModifierAt(state, pawn, i)
}

/** Death / round reset: drop temporary modifiers (original onDeath / onReset). */
export function removeTemporaryModifiers(state: SimState, pawn: PawnState): void {
  for (let i = pawn.modifiers.length - 1; i >= 0; i--) {
    const b = MODIFIERS[pawn.modifiers[i].id]
    if (!b || b.temporary) removeModifierAt(state, pawn, i)
  }
}

export function removeAllModifiers(state: SimState, pawn: PawnState): void {
  for (let i = pawn.modifiers.length - 1; i >= 0; i--) removeModifierAt(state, pawn, i)
}

export function modifiersPreTick(state: SimState, pawn: PawnState): void {
  for (const mod of pawn.modifiers.slice()) {
    if (!pawn.alive) return
    if (pawn.modifiers.includes(mod)) MODIFIERS[mod.id]?.onPreTick?.(state, pawn, mod)
  }
}

export function modifiersOnSpellCast(state: SimState, pawn: PawnState, ctx: CastContext): void {
  for (const mod of pawn.modifiers.slice()) {
    if (pawn.modifiers.includes(mod)) MODIFIERS[mod.id]?.onSpellCast?.(state, pawn, mod, ctx)
  }
}

/** Count down timed modifiers on every pawn; expired ones are removed in order. */
export function tickModifiers(state: SimState): void {
  for (const pawn of state.pawns) {
    for (const mod of pawn.modifiers.slice()) {
      if (mod.ticksLeft < 0) continue
      mod.ticksLeft -= 1
      if (mod.ticksLeft <= 0) removeModifier(state, pawn, mod, true)
    }
  }
}
