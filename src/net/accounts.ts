/** Trusted identity metadata supplied by the server, never accepted from a hello frame. */
export interface VerifiedAccount {
  cosmetics: import('../game/progressionCatalog').CosmeticEquipment
  id: string
  name: string
  color: number | null
  ratingKey: string
}

export interface AccountGame { region: string; room: string }
export interface RankedAccountAuthority {
  pending?(): { rewards: number; releases: number }
  names(accountIds: string[]): Promise<Map<string, string>>
  reward(receipt: import('../../server/progression.mjs').ProgressionReceipt): Promise<'awarded' | 'pending' | 'ineligible'>
  verify(token: string): Promise<VerifiedAccount>
  game(accountId: string): Promise<AccountGame | null>
  claim(accountId: string, room: string): Promise<{ ok: true } | { ok: false; game: AccountGame }>
  release(room: string, accountId?: string): void
  close(): void
}

export function accountRatingKey(id: string): string {
  if (!/^[A-Za-z0-9_-]{8,60}$/.test(id)) throw new Error('Invalid account identity')
  return `a_${id}`
}
