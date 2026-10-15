/**
 * Mastery factors (systems.md §4): duration 1.0 + gains, range 1.0 + gains, lifesteal 0 + gains.
 */
import { MASTERY_GAIN } from './config'
import { scoreOf } from './teams'
import type { PlayerId, SimState } from './types'

export type MasteryKind = 'duration' | 'range' | 'lifesteal'

export function masteryFactor(kind: MasteryKind, level: number): number {
  let f = kind === 'lifesteal' ? 0 : 1
  const gains = MASTERY_GAIN[kind]
  for (let i = 0; i < level && i < gains.length; i++) f += gains[i]
  return f
}

export function playerMastery(state: SimState, player: PlayerId | null, kind: MasteryKind): number {
  if (player === null) return masteryFactor(kind, 0)
  const sc = scoreOf(state, player)
  return masteryFactor(kind, sc ? sc.masteries[kind] : 0)
}

/** "rm" in spells.md: projectile lifetime / explicit range multiplier. */
export function rangeFactor(state: SimState, player: PlayerId | null): number {
  return playerMastery(state, player, 'range')
}

/** "dm" in spells.md: buff/debuff duration multiplier. */
export function durationFactor(state: SimState, player: PlayerId | null): number {
  return playerMastery(state, player, 'duration')
}

export function lifestealFactor(state: SimState, player: PlayerId | null): number {
  return playerMastery(state, player, 'lifesteal')
}
