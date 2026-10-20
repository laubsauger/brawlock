/**
 * What the spell library lists, in reading order: the two spells every warlock
 * starts with, the six spellbook columns as the shop shows them (one spell per
 * column can be owned), then the item shelf. Built from the shop catalog so a
 * new or moved spell shows up here without a second list to keep in sync.
 */
import type { SpellId } from '../../sim'
import { COLUMNS, ITEMS, ITEM_HUE, SPELLS, hueFor } from './catalog'

export interface LibraryGroup {
  key: string
  name: string
  hint: string
  hue: string
  ids: SpellId[]
}

const STARTERS: SpellId[] = ['fireball', 'scourge']

export const LIBRARY_GROUPS: LibraryGroup[] = [
  { key: 'starters', name: 'Starting spells', hint: 'Every warlock has these', hue: hueFor('fireball'), ids: STARTERS },
  ...COLUMNS.map((c, i) => ({ key: `column-${i + 1}`, name: c.name, hint: c.hint, hue: c.hue, ids: SPELLS.filter((s) => s.column === i).map((s) => s.id) })),
  { key: 'items', name: 'Items', hint: 'From the item shelf, besides your spellbook', hue: ITEM_HUE, ids: ITEMS.map((i) => i.id).filter((id) => !STARTERS.includes(id)) },
]

/** Every id once, in the order the library shows them (arrow keys walk this). */
export const LIBRARY_ORDER: SpellId[] = LIBRARY_GROUPS.flatMap((g) => g.ids)

export function libraryGroupOf(id: SpellId): LibraryGroup | undefined {
  return LIBRARY_GROUPS.find((g) => g.ids.includes(id))
}
