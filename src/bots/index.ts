/**
 * Bot API contract. Bots see the same SimState a client sees and return the
 * commands a human could have issued. They never mutate state.
 * Owned by the bots workstream; signatures are the contract.
 */
import type { BotDifficulty, InputCommand, PlayerId, SimState } from '../sim/types'

export interface Bot {
  readonly player: PlayerId
  readonly difficulty: BotDifficulty
  /** Called once per sim tick on the host. Returns commands for this tick (often none). */
  think(state: SimState): InputCommand[]
}

export function createBot(_player: PlayerId, _difficulty: BotDifficulty, _seed: number): Bot {
  throw new Error('bots: createBot not implemented')
}
