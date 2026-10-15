/**
 * Public sim API. Everything outside src/sim imports from here (and types.ts).
 * Owned by the sim workstream; signatures are the contract.
 */
import type { MatchSettings, PlayerInput, PlayerSlot, SimState } from './types'

export * from './types'

/** Build the initial state for a match. Deterministic in (settings, slots, seed). */
export function createMatch(_settings: MatchSettings, _slots: PlayerSlot[], _seed: number): SimState {
  throw new Error('sim: createMatch not implemented')
}

/**
 * Advance exactly one tick (DT seconds). Mutates `state` in place.
 * `inputs` = every input to apply this tick, any order; the sim sorts by player id.
 * Clears `state.events` first, then fills it with this tick's events.
 */
export function step(_state: SimState, _inputs: PlayerInput[]): void {
  throw new Error('sim: step not implemented')
}
