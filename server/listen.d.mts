import type { BotDifficulty, MatchSettings } from '../src/sim/types'
import type { Room } from '../src/net/dedicated'

export interface ServerOptions {
  port?: number
  host?: string
  bots?: BotDifficulty[]
  settings?: Partial<MatchSettings>
  autoStartMs?: number
  rematchMs?: number
  /** tests only: session clocks run this many times faster than wall time (clients must match) */
  timeScale?: number
  log?: (msg: string) => void
}

export interface DedicatedServer {
  readonly port: number
  room(code: string): Promise<Room>
  close(): Promise<void>
}

export function startServer(opts?: ServerOptions): Promise<DedicatedServer>
