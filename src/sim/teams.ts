/**
 * Players, teams and alliances. `state.slots[i].team` holds the CURRENT team (re-assigned at
 * every round start by the team mode, systems.md §6.2); the lobby team is the value passed to
 * createMatch and is kept as-is in 'teams' mode.
 */
import { randomInt } from './rng'
import type { PawnState, PlayerId, PlayerScore, PlayerSlot, SimState } from './types'

export const ALLIANCE_SELF = 0
export const ALLIANCE_ALLY = 1
export const ALLIANCE_ENEMY = 2
export type Alliance = 0 | 1 | 2

/** Owner id used by obstacles: ENEMY to every player and every player is ENEMY to it. */
export const NEUTRAL_OWNER = -1

export function slotOf(state: SimState, player: PlayerId): PlayerSlot | undefined {
  for (const s of state.slots) if (s.id === player) return s
  return undefined
}

export function scoreOf(state: SimState, player: PlayerId): PlayerScore | undefined {
  for (const s of state.scores) if (s.id === player) return s
  return undefined
}

export function pawnOf(state: SimState, player: PlayerId): PawnState | undefined {
  for (const p of state.pawns) if (p.owner === player) return p
  return undefined
}

export function teamOf(state: SimState, player: PlayerId): number {
  const s = slotOf(state, player)
  return s ? s.team : NEUTRAL_OWNER
}

export function alliance(state: SimState, a: PlayerId, b: PlayerId): Alliance {
  if (a === NEUTRAL_OWNER || b === NEUTRAL_OWNER) return ALLIANCE_ENEMY
  if (a === b) return ALLIANCE_SELF
  return teamOf(state, a) === teamOf(state, b) ? ALLIANCE_ALLY : ALLIANCE_ENEMY
}

export function isEnemy(state: SimState, a: PlayerId, b: PlayerId): boolean {
  return alliance(state, a, b) === ALLIANCE_ENEMY
}

/**
 * Active = plays rounds (gets respawned, counts for arena size and spawn layout).
 * A disconnected player stays active while a bot holds the pawn (botsReplaceLeavers).
 */
export function isActive(state: SimState, player: PlayerId): boolean {
  const sc = scoreOf(state, player)
  if (!sc) return false
  return sc.connected || state.settings.botsReplaceLeavers
}

/** Active player ids in ascending order. */
export function activePlayers(state: SimState): PlayerId[] {
  return state.slots.filter((s) => isActive(state, s.id)).map((s) => s.id)
}

/** Team mode at round start (systems.md §6.2). */
export function assignTeams(state: SimState): void {
  const ids = activePlayers(state)
  const mode = state.settings.teamMode
  if (mode === 'teams') return
  if (mode === 'ffa') {
    // each player its own team; team id = player id keeps ids stable across rounds
    for (const id of ids) slotOf(state, id)!.team = id
    return
  }
  // shuffle: pick a team count among the divisors of n (2..n), excluding n (FFA) when there
  // is a choice, then deal shuffled players round-robin.
  const n = ids.length
  if (n === 0) return
  const divisors: number[] = []
  if (n === 1) divisors.push(1)
  else for (let d = 2; d <= n; d++) if (n % d === 0) divisors.push(d)
  const teamCount = divisors.length > 1 ? divisors[randomInt(state, 0, divisors.length - 2)] : divisors[0]
  const order = ids.slice()
  for (let k = 0; k < n; k++) {
    const i = randomInt(state, 0, n - 1)
    const j = randomInt(state, 0, n - 1)
    const t = order[i]
    order[i] = order[j]
    order[j] = t
  }
  order.forEach((id, k) => {
    slotOf(state, id)!.team = k % teamCount
  })
}
