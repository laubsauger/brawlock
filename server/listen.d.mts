import type { Room } from '../src/net/dedicated'
import type { LogFn, RoomSetup, ServerConfig, ServerCore } from '../src/net/server'

export interface ServerOptions {
  port?: number
  host?: string
  /** netcode compatibility id (default: the build's __NET_ID__) */
  build?: string
  config?: Partial<Omit<ServerConfig, 'build'>>
  /** client IP from X-Forwarded-For (behind the local nginx only) */
  trustProxy?: boolean
  /** tests only: session clocks run this many times faster than wall time (clients must match) */
  timeScale?: number
  log?: LogFn
  /** directory of leaderboard.sqlite; '' / missing = no leaderboard */
  dataDir?: string
  /** ms since epoch for stored results (tests) */
  clock?: () => number
}

export interface DedicatedServer {
  readonly port: number
  readonly core: ServerCore
  /** the room with this code, created if missing */
  room(code: string): Promise<Room>
  createRoom(opts?: RoomSetup): Promise<Room>
  close(): Promise<void>
}

export const NET_BUILD: string
export function jsonLog(level: string, event: string, fields?: Record<string, unknown>): void
export function startServer(opts?: ServerOptions): Promise<DedicatedServer>
