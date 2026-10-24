/**
 * Bot API contract. Bots see the same SimState a client sees and return the
 * commands a human could have issued. They never mutate state.
 * Owned by the bots workstream; signatures are the contract.
 *
 * Usage (host / offline loop): create one bot per bot slot with a seed derived
 * from the match seed, then every tick
 *   inputs.push({ player: bot.player, tick: state.tick, cmds: bot.think(state) })
 * before step(). Create fresh bots for a new match (or rewind: they reset when
 * state.tick goes backwards). Difficulty table: presets.ts.
 */
import type { BotDifficulty, InputCommand, PlayerId, SimState } from '../sim/types'
import { BotController } from './controller'

export interface Bot {
  readonly player: PlayerId
  readonly difficulty: BotDifficulty
  /** Called once per sim tick on the host. Returns commands for this tick (often none). */
  think(state: SimState): InputCommand[]
  /** Detached snapshot of already-decided orders awaiting their reaction delay.
   * `at` is the future sim tick when think() releases the commands. */
  scheduled?(): readonly { at: number; cmds: InputCommand[] }[]
  /** Changes whenever scheduled() changes other than by due orders leaving it: while it holds,
   * the host can skip re-reading and comparing the plan every tick. */
  readonly scheduledVersion?: number
}

export function createBot(player: PlayerId, difficulty: BotDifficulty, seed: number): Bot {
  return new BotController(player, difficulty, seed)
}

export { BOT_ELO, BOT_PRESETS, type BotParams } from './presets'
export { BotController, type BotAction } from './controller'
