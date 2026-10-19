import type { ProgressionEquip, ProgressionPurchase, ProgressionSnapshot } from '../../server/progression.mjs'

export type { ProgressionReward, ProgressionSnapshot } from '../../server/progression.mjs'
export interface MatchProgression { matchId: string; status: 'pending' | 'awarded' | 'ineligible' | 'unavailable' }

async function request(path: string, body?: ProgressionEquip | ProgressionPurchase): Promise<ProgressionSnapshot> {
  const response = await fetch(`/api/progression${path}`, {
    method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'Could not load your collection.')
  return result as ProgressionSnapshot
}

export const loadProgression = () => request('')
export const purchaseCosmetic = (purchase: ProgressionPurchase) => request('/purchase', purchase)
export const equipCosmetic = (equipment: ProgressionEquip) => request('/equip', equipment)
