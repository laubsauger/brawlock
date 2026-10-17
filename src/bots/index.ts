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
}

export function createBot(player: PlayerId, difficulty: BotDifficulty, seed: number): Bot {
  return new BotController(player, difficulty, seed)
}

export { BOT_ELO, BOT_PRESETS, type BotParams } from './presets'
export { BotController, type BotAction } from './controller'
