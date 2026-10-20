import { describe, expect, it } from 'vitest'
import { COLUMNS, ITEMS, SPELLS } from './catalog'
import { LIBRARY_GROUPS, LIBRARY_ORDER, libraryGroupOf } from './library'

describe('spell library groups', () => {
  it('lists every shop spell and item exactly once, so nothing a player can buy is missing from the library', () => {
    const shop = [...SPELLS.map((s) => s.id), ...ITEMS.map((i) => i.id)]
    expect(new Set(LIBRARY_ORDER).size).toBe(LIBRARY_ORDER.length)
    expect([...LIBRARY_ORDER].sort()).toEqual([...new Set(shop)].sort())
  })

  it('opens on the starting kit, then follows the spellbook columns in shop order', () => {
    expect(LIBRARY_GROUPS[0].ids).toEqual(['fireball', 'scourge'])
    const columns = LIBRARY_GROUPS.slice(1, 1 + COLUMNS.length)
    expect(columns.map((g) => g.name)).toEqual(COLUMNS.map((c) => c.name))
    expect(LIBRARY_GROUPS.at(-1)!.key).toBe('items')
  })

  it("files each spell under the column it is bought from (one spell per column is the build rule players learn here)", () => {
    for (const s of SPELLS) {
      const group = libraryGroupOf(s.id)!
      expect(group.name).toBe(COLUMNS[s.column].name)
      expect(group.hue).toBe(COLUMNS[s.column].hue)
    }
  })
})
