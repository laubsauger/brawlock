import { describe, expect, it } from 'vitest'
import type { PlayerSlot } from '../sim/types'
import { PLAYER_COLORS, planPlayerColor } from './lobbyColors'

const slot = (id: number, color: number, kind: PlayerSlot['kind'] = 'human'): PlayerSlot => ({ id, color, kind, name: `Player ${id}`, team: id })

describe('lobby color requests', () => {
  it('moves to a free palette color without changing the input slots', () => {
    const slots = [slot(2, PLAYER_COLORS[0]), slot(5, PLAYER_COLORS[1])]
    const before = structuredClone(slots)
    expect(planPlayerColor(slots, 2, PLAYER_COLORS[3])).toEqual([{ player: 2, color: PLAYER_COLORS[3] }])
    expect(slots).toEqual(before)
  })

  it('swaps a bot color with the requesting human old color, even in a full lobby', () => {
    const slots = PLAYER_COLORS.map((color, i) => slot(i + 10, color, i === 0 || i === 5 ? 'human' : 'bot'))
    const before = structuredClone(slots)
    const patches = planPlayerColor(slots, 10, PLAYER_COLORS[7])!
    expect(patches).toEqual([{ player: 10, color: PLAYER_COLORS[7] }, { player: 17, color: PLAYER_COLORS[0] }])
    const applied = slots.map((s) => ({ ...s, color: patches.find((p) => p.player === s.id)?.color ?? s.color }))
    expect(new Set(applied.map((s) => s.color)).size).toBe(slots.length)
    expect(applied.find((s) => s.id === 15)).toEqual(slots.find((s) => s.id === 15))
    expect(slots).toEqual(before)
  })

  it('refuses another human color without stealing or recoloring that person', () => {
    const slots = [slot(2, PLAYER_COLORS[0]), slot(5, PLAYER_COLORS[1])]
    expect(planPlayerColor(slots, 2, PLAYER_COLORS[1])).toBeNull()
    expect(slots[1].color).toBe(PLAYER_COLORS[1])
    expect(planPlayerColor(slots, 2, PLAYER_COLORS[0])).toEqual([])
  })

  it.each([0, 0xffffff, 0xff3b30 + 0.1, NaN, Infinity, -1])('refuses a color outside the palette: %s', (color) => {
    expect(planPlayerColor([slot(0, PLAYER_COLORS[0])], 0, color)).toBeNull()
  })

  it('only plans requests for an existing human slot', () => {
    expect(planPlayerColor([slot(1, PLAYER_COLORS[0], 'bot')], 1, PLAYER_COLORS[1])).toBeNull()
    expect(planPlayerColor([slot(1, PLAYER_COLORS[0])], 2, PLAYER_COLORS[1])).toBeNull()
  })
})
