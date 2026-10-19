export interface RankedGame {
  region: string
  room: string
}
import type { RankedConnection } from '../src/net/accounts'
export type RankedClaim = { ok: true } | { ok: false; game: RankedGame; conflict?: 'device' | 'controller' }
export interface AccountRegions {
  register(region: string, instance: string): void
  access(userId: string, connection: RankedConnection): RankedClaim
  disconnect(region: string, instance: string, userId: string, room: string, controller: string): void
  claim(region: string, instance: string, userId: string, room: string, connection: RankedConnection): RankedClaim
  release(region: string, instance: string, room: string, userId?: string): void
  game(userId: string): RankedGame | null
  activeGame(userId: string): RankedGame | null
  started(region: string, instance: string, room: string, userIds: string[]): void
}
/** Explicit migration SQL; the caller applies it using the accounts schema version. */
export const ACCOUNT_REGIONS_SCHEMA: string
export const ACCOUNT_CONTROL_SCHEMA: string
export const ACCOUNT_STARTED_SCHEMA: string
/** Uses an existing Node DatabaseSync connection without opening or closing it. */
export function accountRegions(database: unknown): AccountRegions
