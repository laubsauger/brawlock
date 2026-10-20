/** Presentation only. Prices and offers are enforced by the account authority. */
export type CosmeticSlot = 'victory' | 'head' | 'back' | 'robe' | 'emblem' | 'staff'
export const COSMETIC_SLOTS: readonly CosmeticSlot[] = ['head', 'back', 'robe', 'emblem', 'staff', 'victory']
export type VictoryCosmeticId = 'victory-ascendant' | 'victory-revel'
export type HeadCosmeticId = 'head-ram' | 'head-demon' | 'head-antlers' | 'head-wizard' | 'head-crescent' | 'head-candles' | 'head-party' | 'head-crow' | 'head-lantern'
export type BackCosmeticId = 'back-antlers' | 'back-crescent' | 'back-spikes' | 'back-wings'
export type RobeCosmeticId = 'robe-tattered' | 'robe-emberveil'
export type EmblemCosmeticId = 'emblem-skull' | 'emblem-flame' | 'emblem-crown' | 'emblem-eye' | 'emblem-moon' | 'emblem-bolt' | 'emblem-spiral' | 'emblem-paw' | 'emblem-smile' | 'emblem-ghost' | 'emblem-swords' | 'emblem-mushroom' | 'emblem-gg' | 'emblem-heart'
export type StaffCosmeticId = 'staff-gnarled' | 'staff-iron' | 'staff-bone'
export type CosmeticId = VictoryCosmeticId | HeadCosmeticId | BackCosmeticId | RobeCosmeticId | EmblemCosmeticId | StaffCosmeticId
export interface Cosmetic {
  id: CosmeticId
  slot: CosmeticSlot
  name: string
  description: string
  price: number
  /** neutral material tone for list chips; the item itself never recolours the player */
  swatch: string
}

/**
 * Cosmetics change shape, never colour: player colour is identity, so every piece is a neutral
 * material and anything that glows glows in the wearer's colour (render/character/wardrobe.ts).
 */
export const COSMETICS: readonly Cosmetic[] = [
  { id: 'head-ram', slot: 'head', name: 'Ram Horns', description: 'Ribbed horns curling back past the hood.', price: 120, swatch: '#c9b48e' },
  { id: 'head-demon', slot: 'head', name: 'Pit Horns', description: 'Tall horns swept back, banded in your color.', price: 160, swatch: '#5a3f33' },
  { id: 'head-antlers', slot: 'head', name: 'Elder Antlers', description: 'Branching antlers. The widest crown in the arena.', price: 180, swatch: '#7a5434' },
  { id: 'head-wizard', slot: 'head', name: 'Pointed Hat', description: 'A tall hat whose tip flops along behind you.', price: 140, swatch: '#3a3540' },
  { id: 'head-crescent', slot: 'head', name: 'Crescent Moon', description: 'A bronze moon hanging over the hood, rimmed in your color.', price: 200, swatch: '#9d7a4e' },
  { id: 'head-candles', slot: 'head', name: 'Candle Crown', description: 'An iron ring of candles burning in your color.', price: 170, swatch: '#c9bc9e' },
  { id: 'head-party', slot: 'head', name: 'Party Hat', description: 'Every round is a celebration.', price: 80, swatch: '#b08a4f' },
  { id: 'head-crow', slot: 'head', name: 'Crow Companion', description: 'A crow perched on your hood. It judges your plays.', price: 150, swatch: '#26252c' },
  { id: 'head-lantern', slot: 'head', name: 'Angler Lure', description: 'A lantern on a stalk grown from your hood. Deep-sea chic.', price: 140, swatch: '#7a5434' },
  { id: 'back-antlers', slot: 'back', name: 'Bonewood Antlers', description: 'Pale antlers branching up from your shoulder blades.', price: 180, swatch: '#cdbf9f' },
  { id: 'back-crescent', slot: 'back', name: 'Twin Crescents', description: 'Iron crescent blades behind your shoulders, edged in your color.', price: 200, swatch: '#6c6870' },
  { id: 'back-spikes', slot: 'back', name: 'Spine Fan', description: 'A crown of bone spikes fanning out behind the hood.', price: 160, swatch: '#bfae8d' },
  { id: 'back-wings', slot: 'back', name: 'Bat Wings', description: 'Folded leathery wings. Purely decorative, sadly.', price: 220, swatch: '#3a3238' },
  { id: 'robe-tattered', slot: 'robe', name: 'Tattered Robe', description: 'A torn, jagged hem on coat and cape.', price: 120, swatch: '#3b3236' },
  { id: 'robe-emberveil', slot: 'robe', name: 'Emberveil Robe', description: 'Torn hem with smouldering veins in your color.', price: 220, swatch: '#5a2a1c' },
  { id: 'emblem-skull', slot: 'emblem', name: 'Grinning Skull', description: 'A skull printed across your back.', price: 60, swatch: '#d9cbb0' },
  { id: 'emblem-flame', slot: 'emblem', name: 'Living Flame', description: 'Fire, as a lifestyle.', price: 60, swatch: '#d9cbb0' },
  { id: 'emblem-crown', slot: 'emblem', name: 'Crown', description: 'For the one who keeps winning.', price: 70, swatch: '#d9cbb0' },
  { id: 'emblem-eye', slot: 'emblem', name: 'Watching Eye', description: 'Someone is always watching your back.', price: 60, swatch: '#d9cbb0' },
  { id: 'emblem-moon', slot: 'emblem', name: 'Moon and Star', description: 'A crescent and its star.', price: 60, swatch: '#d9cbb0' },
  { id: 'emblem-bolt', slot: 'emblem', name: 'Lightning Bolt', description: 'Fast hands. Faster bolt.', price: 50, swatch: '#d9cbb0' },
  { id: 'emblem-spiral', slot: 'emblem', name: 'Hypno Spiral', description: 'Look closer. Closer.', price: 50, swatch: '#d9cbb0' },
  { id: 'emblem-paw', slot: 'emblem', name: 'Paw Print', description: 'Good boy energy.', price: 50, swatch: '#d9cbb0' },
  { id: 'emblem-smile', slot: 'emblem', name: 'Big Smile', description: 'Unsettlingly cheerful.', price: 50, swatch: '#d9cbb0' },
  { id: 'emblem-ghost', slot: 'emblem', name: 'Little Ghost', description: 'Boo.', price: 50, swatch: '#d9cbb0' },
  { id: 'emblem-swords', slot: 'emblem', name: 'Crossed Blades', description: 'An old soldier, a new war.', price: 60, swatch: '#d9cbb0' },
  { id: 'emblem-mushroom', slot: 'emblem', name: 'Toadstool', description: 'Forest wisdom, dubious nutrition.', price: 50, swatch: '#d9cbb0' },
  { id: 'emblem-gg', slot: 'emblem', name: 'GG Tag', description: 'Good game, painted on.', price: 70, swatch: '#d9cbb0' },
  { id: 'emblem-heart', slot: 'emblem', name: 'Broken Heart', description: 'Shattered, still fighting.', price: 60, swatch: '#d9cbb0' },
  { id: 'staff-gnarled', slot: 'staff', name: 'Gnarled Staff', description: 'Wood claws around a crystal. Every spell leaves from its tip.', price: 180, swatch: '#5a3f2a' },
  { id: 'staff-iron', slot: 'staff', name: 'Iron Ring Staff', description: 'An iron ring with a glowing orb. Every spell leaves from its tip.', price: 200, swatch: '#55525a' },
  { id: 'staff-bone', slot: 'staff', name: 'Bone Staff', description: 'Bone horns cradling a crystal. Every spell leaves from its tip.', price: 220, swatch: '#cdbf9f' },
  { id: 'victory-ascendant', slot: 'victory', name: 'Ascendant', description: 'Raise both hands, then open into a grand summoning stance.', price: 80, swatch: '#efa85c' },
  { id: 'victory-revel', slot: 'victory', name: 'Ash Revel', description: 'A triumphant dance with an overhead wave and a deep bow.', price: 80, swatch: '#e6bb71' },
]

export interface CosmeticEquipment {
  victory: VictoryCosmeticId | null
  head: HeadCosmeticId | null
  back: BackCosmeticId | null
  robe: RobeCosmeticId | null
  emblem: EmblemCosmeticId | null
  staff: StaffCosmeticId | null
}
export const EMPTY_EQUIPMENT: Readonly<CosmeticEquipment> = { victory: null, head: null, back: null, robe: null, emblem: null, staff: null }

/** Retired colour robes (2026-10-20): refunded at their purchase price, no longer sold or worn. */
export const RETIRED_COSMETICS: readonly string[] = ['robe-cinder', 'robe-moon']

export function validCosmeticEquipment(value: unknown): value is CosmeticEquipment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return Object.keys(v).length === COSMETIC_SLOTS.length && COSMETIC_SLOTS.every((slot) => v[slot] === null || COSMETICS.some((item) => item.id === v[slot] && item.slot === slot))
}
