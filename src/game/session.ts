/**
 * Session contract: owns the running lobby / match for every role.
 * - offline: local sim loop, local player + bots
 * - host: local sim loop, remote players via net, bots
 * - client: sends inputs, receives snapshots
 * UI calls these functions; state for UI goes to the zustand store (lobby, screen)
 * and per-frame data goes to game/frame.ts.
 * Owned by the net workstream; signatures are the contract.
 */
import type { BotDifficulty, MatchSettings, PlayerId } from '../sim/types'

export interface SessionApi {
  /** Create an offline lobby: local player in slot 0. */
  openOffline(): void
  /** Create an online lobby as host. Resolves when the join link exists. */
  openHost(): Promise<void>
  /** Join a host by peer id (from ?join= link). */
  join(hostId: string): Promise<void>
  addBot(difficulty: BotDifficulty): void
  removeSlot(player: PlayerId): void
  setBotDifficulty(player: PlayerId, difficulty: BotDifficulty): void
  setTeam(player: PlayerId, team: number): void
  updateSettings(patch: Partial<MatchSettings>): void
  /** Host / offline only. */
  startMatch(): void
  /** Leave lobby or match, close connections, back to menu. */
  leave(): void
}

export const session: SessionApi = {
  openOffline() {},
  async openHost() {},
  async join() {},
  addBot() {},
  removeSlot() {},
  setBotDifficulty() {},
  setTeam() {},
  updateSettings() {},
  startMatch() {},
  leave() {},
}
