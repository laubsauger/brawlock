import type { PlayerSlot } from '../sim/types'

/** The lobby palette is also the set of colors accepted by the authority. */
export const PLAYER_COLOR_OPTIONS = [
  { color: 0xff3b30, name: 'Red' },
  { color: 0x2e7bff, name: 'Blue' },
  { color: 0x14e0c8, name: 'Teal' },
  { color: 0xa24bff, name: 'Purple' },
  { color: 0xffd60a, name: 'Yellow' },
  { color: 0xff8c1a, name: 'Orange' },
  { color: 0x34c759, name: 'Green' },
  { color: 0xff4fa3, name: 'Pink' },
  // Lime replaced White (2026-11-02): a white health bar hid its white damage trail
  { color: 0xa6e22e, name: 'Lime' },
  { color: 0xa86b32, name: 'Brown' },
] as const

export const PLAYER_COLORS: readonly number[] = PLAYER_COLOR_OPTIONS.map((option) => option.color)

/** Colours that left the palette, and what a saved choice of one becomes. */
const RETIRED_COLORS = new Map<number, number>([[0xe8e8f0, 0xa6e22e]])

/** A saved or requested colour as the palette has it now (a retired one becomes its replacement). */
export function currentColor<T extends number | null>(color: T): T {
  return (color === null ? color : RETIRED_COLORS.get(color) ?? color) as T
}

export interface PlayerColorPatch {
  player: number
  color: number
}

/**
 * Plan one human's lobby color request without mutating authoritative slots.
 * Human colors are reserved; a bot exchanges colors with the requester.
 * null = refused, [] = already selected. The caller owns lobby/peer permissions.
 */
export function planPlayerColor(slots: readonly PlayerSlot[], player: number, color: number): PlayerColorPatch[] | null {
  const me = slots.find((slot) => slot.id === player && slot.kind === 'human')
  if (!me || !PLAYER_COLORS.includes(color)) return null
  if (slots.some((slot) => slot.id !== player && slot.kind === 'human' && slot.color === color)) return null
  if (me.color === color) return []
  const bot = slots.find((slot) => slot.kind === 'bot' && slot.color === color)
  const patches: PlayerColorPatch[] = [{ player, color }]
  if (bot) patches.push({ player: bot.id, color: me.color })
  return patches
}
