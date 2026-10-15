/**
 * Pawn modifiers (spells.md §6). Each modifier kind is a behavior with optional hooks;
 * `ModifierState` stays plain data. New spells register their modifiers in MODIFIERS.
 *
 * Durations run on real game time (original GAME tasks), decremented once per tick.
 */
import type { ModifierState, PawnState, PlayerId, SimState } from './types'

export interface ModifierBehavior {
  /** temporary modifiers are removed on death and at round reset (original `temporary`) */
  temporary: boolean
  onApply?(state: SimState, pawn: PawnState, mod: ModifierState): void
  onRemove?(state: SimState, pawn: PawnState, mod: ModifierState): void
  /** runs in the pawn pre-tick, after walking (original Pawn:onPreTick order) */
  onPreTick?(state: SimState, pawn: PawnState, mod: ModifierState): void
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
  return mod
}

export function removeModifierAt(state: SimState, pawn: PawnState, index: number): void {
  const [mod] = pawn.modifiers.splice(index, 1)
  if (mod) MODIFIERS[mod.id]?.onRemove?.(state, pawn, mod)
}

export function hasModifier(pawn: PawnState, id: string): boolean {
  return pawn.modifiers.some((m) => m.id === id)
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
  for (const mod of pawn.modifiers.slice()) MODIFIERS[mod.id]?.onPreTick?.(state, pawn, mod)
}

/** Count down timed modifiers on every pawn; expired ones are removed in order. */
export function tickModifiers(state: SimState): void {
  for (const pawn of state.pawns) {
    for (let i = 0; i < pawn.modifiers.length; ) {
      const mod = pawn.modifiers[i]
      if (mod.ticksLeft >= 0) {
        mod.ticksLeft -= 1
        if (mod.ticksLeft <= 0) {
          removeModifierAt(state, pawn, i)
          continue
        }
      }
      i++
    }
  }
}
