import { create } from 'zustand'
import type { AccountGame } from '../net/accounts'

export interface RankedConflict { kind: 'device' | 'controller'; game: AccountGame }
export const useRankedControl = create<{ conflict: RankedConflict | null }>(() => ({ conflict: null }))

/** Public conflict metadata only; never accepts an account ID or reconnect credential. */
export function showRankedConflict(value: unknown): void {
  const conflict = value as Partial<RankedConflict> | null
  if (!conflict || !['device', 'controller'].includes(conflict.kind!) || !conflict.game
    || typeof conflict.game.region !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(conflict.game.region)
    || !/^[A-Z]{5}$/.test(conflict.game.room)) throw new Error('Invalid ranked session conflict')
  useRankedControl.setState({ conflict: conflict as RankedConflict })
}
