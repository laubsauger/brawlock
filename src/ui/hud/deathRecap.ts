import { TICK_HZ } from '../../sim'
import type { GameMode, Phase, SimEvent } from '../../sim/types'
import { displayName } from '../data/catalog'

export type DeathEvent = Extract<SimEvent, { type: 'death' }>

/** Read the lethal cause itself; a prior hit is not necessarily what killed you. */
export function deathRecap(death: DeathEvent, killerName: string | null): string {
  if (death.cause === 'lava') return killerName ? `Pushed into the lava by ${killerName}` : 'Consumed by the lava'
  if (death.cause === 'obstacle') return killerName ? `Caught in ${killerName}’s pillar blast` : 'Caught in a pillar blast'
  if (death.cause) return killerName ? `${killerName} · ${displayName(death.cause)}` : `Taken down by ${displayName(death.cause)}`
  return killerName ? `Taken down by ${killerName}` : 'Knocked out'
}

export function deathNextStep(mode: GameMode, phase: Phase, respawnTicks: number): string {
  if (phase === 'roundEnd') return 'Next round shortly'
  if (mode === 'deathmatch' || respawnTicks > 0) return respawnTicks > 0 ? `Respawning in ${Math.ceil(respawnTicks / TICK_HZ)}s` : 'Waiting to respawn'
  return 'Watching the rest of the round'
}
