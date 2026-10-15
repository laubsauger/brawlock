/**
 * Order helpers shared by commands, spells and combat. Every path that drops a pending cast goes
 * through cancelCast so render / audio get a 'castCancel' (Dota-style animation cancel).
 */
import type { PawnState, SimState } from './types'

/** Drop a pending (turning or winding up) cast without spending its cooldown. */
export function cancelCast(state: SimState, pawn: PawnState): void {
  const c = pawn.cast
  if (!c) return
  pawn.cast = null
  state.events.push({ type: 'castCancel', pawn: pawn.id, spell: c.spell, slot: c.slot, started: !!c.started })
}

/** Dota unit:Stop(): clears the move order and cancels a pending cast. */
export function stopPawn(state: SimState, pawn: PawnState): void {
  pawn.moveTarget = null
  cancelCast(state, pawn)
}

/** Remove the walk component of the velocity (knockback is kept). */
export function clearWalk(pawn: PawnState): void {
  pawn.vx -= pawn.walkVx
  pawn.vy -= pawn.walkVy
  pawn.walkVx = 0
  pawn.walkVy = 0
}
