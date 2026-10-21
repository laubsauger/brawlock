import { freshStartRefund, type SpellId } from '../../sim'
import { frame } from '../../game/frame'
import type { MasteryId } from '../data/catalog'
import { canBuyNow, localView } from '../lib/view'

/** What the shop (and the shop's ability cards) show for the local warlock, polled from the frame buffer. */
export interface ShopView {
  ready: boolean
  gold: number
  /** owned spell per column 0..5 */
  spells: { id: SpellId | null; level: number }[]
  /** owned items by id -> level */
  items: Record<string, number>
  /** owned items by id -> hotbar slot (6..11), for key swaps */
  itemSlots: Record<string, number>
  freeItemSlots: number
  masteries: Record<MasteryId, number>
  phase: string
  open: boolean
  /** gold a Fresh start would refund now (seat taken over from a bot this round), 0 = not offered */
  refund: number
}

export function readShop(): ShopView {
  const v = localView()
  const pawn = v?.pawn
  const items: Record<string, number> = {}
  const itemSlots: Record<string, number> = {}
  let free = 0
  for (let i = 6; i < 12; i++) {
    const id = pawn?.slots[i]
    if (id) {
      items[id] = pawn?.levels[i] ?? 1
      itemSlots[id] = i
    } else free++
  }
  return {
    ready: !!pawn && !!v?.score,
    gold: Math.floor(v?.score?.gold ?? 0),
    spells: Array.from({ length: 6 }, (_, c) => ({ id: pawn?.slots[c] ?? null, level: pawn?.levels[c] ?? 0 })),
    items,
    itemSlots,
    freeItemSlots: pawn ? free : 0,
    masteries: { duration: 0, range: 0, lifesteal: 0, ...v?.score?.masteries },
    phase: v?.state.phase ?? '',
    open: v ? canBuyNow(v.state) : false,
    refund: v ? freshStartRefund(v.state, frame.localPlayer) : 0,
  }
}

