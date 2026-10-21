import type { PlayerSlot, SimState } from './types'
import { createPawn } from './spawn'

/** Authoritative roster changes, shared by the host, input stream and replay playback. */
export function applyRosterChanges(state: SimState, changes: readonly PlayerSlot[]): void {
  for (const slot of changes) {
    const index = state.slots.findIndex((s) => s.id === slot.id)
    if (index >= 0) {
      state.slots[index] = { ...slot }
      continue
    }
    if (state.settings.rankedRounds || state.phase === 'gameOver' || (state.phase === 'fight' && state.settings.gameMode !== 'deathmatch')) {
      throw new Error('New players must enter between casual rounds')
    }
    state.slots.push({ ...slot })
    // Match the guaranteed budget of existing seats; kills and wins remain earned.
    const paidRounds = Math.max(0, state.round - (state.phase === 'roundEnd' ? 1 : 0))
    state.scores.push({ id: slot.id, gold: state.settings.startGold + paidRounds * state.settings.roundGold,
      score: 0, kills: 0, deaths: 0, damageThisRound: 0, spent: 0,
      masteries: { duration: 0, range: 0, lifesteal: 0 }, connected: true })
    const pawn = createPawn(state, slot.id)
    // Shop/round setup respawns an entrant. Deathmatch has no subsequent shop phase.
    if (state.settings.gameMode === 'deathmatch') pawn.respawnTicks = 1
    state.pawns.push(pawn)
    if (state.settings.teamMode === 'ffa') state.slots[state.slots.length - 1].team = slot.id
  }
}
