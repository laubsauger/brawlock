import { TICK_HZ, type Phase, type SimState } from '../sim/types'

/** Small public snapshot; never includes inputs, identities, or loadouts. */
export interface RoomProgress {
  round: number
  elapsedSeconds: number
  phase: Phase
  final: boolean
}

/** Match time advances with the authoritative simulation, including shopping. */
export function roomProgress(state: Pick<SimState, 'round' | 'tick' | 'phase' | 'rankedFinal'>): RoomProgress {
  return {
    round: state.phase === 'shop' || state.phase === 'warmup' ? state.round + 1 : Math.max(1, state.round),
    elapsedSeconds: Math.floor(state.tick / TICK_HZ),
    phase: state.phase,
    final: !!state.rankedFinal,
  }
}
