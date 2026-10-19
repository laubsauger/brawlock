/** Presentation only. Prices and offers are enforced by the account authority. */
export type CosmeticSlot = 'victory' | 'robe'
export type VictoryCosmeticId = 'victory-ascendant' | 'victory-revel'
export type RobeCosmeticId = 'robe-cinder' | 'robe-moon'
export type CosmeticId = VictoryCosmeticId | RobeCosmeticId
export interface Cosmetic {
  id: CosmeticId
  slot: CosmeticSlot
  name: string
  description: string
  price: number
  swatch: string
}

export const COSMETICS: readonly Cosmetic[] = [
  { id: 'victory-ascendant', slot: 'victory', name: 'Ascendant', description: 'Raise both hands, then open into a grand summoning stance.', price: 80, swatch: '#efa85c' },
  { id: 'victory-revel', slot: 'victory', name: 'Ash Revel', description: 'A triumphant dance with an overhead wave and a deep bow.', price: 80, swatch: '#e6bb71' },
  { id: 'robe-cinder', slot: 'robe', name: 'Cinder Weave', description: 'Warm charcoal cloth. Your player color and spell effects stay clear.', price: 100, swatch: '#785343' },
  { id: 'robe-moon', slot: 'robe', name: 'Moon Weave', description: 'Cool slate cloth. Your player color and spell effects stay clear.', price: 100, swatch: '#526b85' },
]

export interface CosmeticEquipment { victory: VictoryCosmeticId | null; robe: RobeCosmeticId | null }
export const EMPTY_EQUIPMENT: Readonly<CosmeticEquipment> = { victory: null, robe: null }

export function validCosmeticEquipment(value: unknown): value is CosmeticEquipment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return Object.keys(v).length === 2 && (['victory', 'robe'] as const).every((slot) => v[slot] === null || COSMETICS.some((item) => item.id === v[slot] && item.slot === slot))
}
