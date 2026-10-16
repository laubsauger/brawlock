/**
 * Team identity colours. Contract (shared with the HUD pills and the round
 * banners): team colour = palette index `team` (PLAYER_COLORS order: Red,
 * Blue, Teal, Purple, Yellow, Orange, Green, Pink, White, Brown), so the
 * "Purple team" banner matches purple rings, plates and projectiles. Mapped
 * through game/playerPalette, so the per-viewer colourblind palette applies.
 */
import { displayColor, paletteColor } from '../game/playerPalette'
import type { PlayerId, SimState } from '../sim/types'

/**
 * Team colour in the viewer's palette (standard or colourblind, read live
 * from settings.colorblindPalette): index-aligned with PLAYER_COLORS.
 */
export function teamColor(team: number): number {
  return paletteColor(team)
}

/** true when allies exist (Teams / Shuffle): identity = team colour */
export function teamModeOn(state: SimState | null): boolean {
  return !!state && state.settings.teamMode !== 'ffa'
}

/**
 * Identity colour of a player: the TEAM colour in team modes (read live, so
 * Shuffle re-teams every round), the slot colour in FFA.
 */
export function colorForPawn(state: SimState | null, owner: PlayerId): number {
  if (!state) return 0xffffff
  let slot = null
  for (const s of state.slots) if (s.id === owner) slot = s
  if (!slot) return 0xffffff
  return teamModeOn(state) ? paletteColor(slot.team) : displayColor(slot.color)
}

/** The player's own slot colour (name text), in the viewer's palette. */
export function slotColorOf(state: SimState | null, owner: PlayerId): number {
  if (!state) return 0xffffff
  for (const s of state.slots) if (s.id === owner) return displayColor(s.color)
  return 0xffffff
}

/** alias */
export const identityColor = colorForPawn
