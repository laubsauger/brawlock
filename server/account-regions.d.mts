export interface RankedGame {
  region: string
  room: string
}
export type RankedClaim = { ok: true } | { ok: false; game: RankedGame }
export interface AccountRegions {
  register(region: string, instance: string): void
  claim(region: string, instance: string, userId: string, room: string): RankedClaim
  release(region: string, instance: string, room: string, userId?: string): void
  game(userId: string): RankedGame | null
}
/** Explicit migration SQL; the caller applies it using the accounts schema version. */
export const ACCOUNT_REGIONS_SCHEMA: string
/** Uses an existing Node DatabaseSync connection without opening or closing it. */
export function accountRegions(database: unknown): AccountRegions
