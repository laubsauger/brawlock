/** Trusted identity metadata supplied by the server, never accepted from a hello frame. */
export interface VerifiedAccount {
  connection: RankedConnection
  cosmetics: import('../game/progressionCatalog').CosmeticEquipment
  id: string
  name: string
  color: number | null
  ratingKey: string
}

/** Bound to a one-use authority ticket, never trusted from a game hello frame. */
export interface RankedConnection { device: string; controller: string; takeover: boolean }

export interface AccountGame { region: string; room: string }
export class RankedConflictError extends Error {
  readonly rankedConflict: { kind: 'device' | 'controller'; game: AccountGame }
  constructor(kind: 'device' | 'controller', game: AccountGame) {
    super(kind === 'device' ? 'This browser already has an active ranked player. Finish that game or sign back into its account.' : 'Your ranked game is active in another tab or device.')
    this.rankedConflict = { kind, game }
  }
}
export interface RankedAccountAuthority {
  attachPlay(token: string, room: string, accountId: string | null): Promise<{ connection: string; id: string; expiresAt: number; serverTime: number }>
  checkPlay(token: string, connection: string): Promise<{ ok: boolean; expiresAt?: number; serverTime?: number }>
  detachPlay(connection: string): void
  pending?(): { rewards: number; releases: number }
  names(accountIds: string[]): Promise<Map<string, string>>
  reward(receipt: import('../../server/progression.mjs').ProgressionReceipt): Promise<'awarded' | 'pending' | 'ineligible'>
  verify(token: string): Promise<VerifiedAccount>
  game(accountId: string): Promise<AccountGame | null>
  claim(accountId: string, room: string, connection: RankedConnection): Promise<{ ok: true } | { ok: false; game: AccountGame; conflict?: 'device' | 'controller' }>
  release(room: string, accountId?: string): void
  started(room: string, accountIds: string[]): void
  disconnected(room: string, accountId: string, controller: string): void
  close(): void
}

export function accountRatingKey(id: string): string {
  if (!/^[A-Za-z0-9_-]{8,60}$/.test(id)) throw new Error('Invalid account identity')
  return `a_${id}`
}
