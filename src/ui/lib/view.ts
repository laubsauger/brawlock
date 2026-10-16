import { frame } from '../../game/frame'
import type { PawnState, PlayerScore, PlayerSlot, SimState, TeamMode } from '../../sim/types'
import { TICK_HZ } from '../../sim/types'
import * as sim from '../../sim'
import { PLAYER_GLYPHS, colorblindPalette, displayColor, paletteColor, paletteIndex, paletteName } from '../../game/playerPalette'

/** 0xRRGGBB -> #rrggbb */
export function hex(color: number): string {
  return '#' + (color & 0xffffff).toString(16).padStart(6, '0')
}

/** 0xRRGGBB -> rgba() with alpha */
export function rgba(color: number, a: number): string {
  return `rgba(${(color >> 16) & 255}, ${(color >> 8) & 255}, ${color & 255}, ${a})`
}

export interface LocalView {
  state: SimState
  pawn: PawnState | null
  score: PlayerScore | null
  slot: PlayerSlot | null
}

/** Local player's pawn / score / slot from the latest state, or null before the first state. */
export function localView(): LocalView | null {
  const state = frame.curr
  if (!state) return null
  const id = frame.localPlayer
  return {
    state,
    pawn: state.pawns.find((p) => p.owner === id) ?? null,
    score: state.scores.find((s) => s.id === id) ?? null,
    slot: state.slots.find((s) => s.id === id) ?? null,
  }
}

export function slotName(state: SimState | null, id: number | null | undefined): string {
  if (id == null || !state) return 'Unknown'
  return state.slots.find((s) => s.id === id)?.name ?? `Player ${id + 1}`
}

/** A player's colour on the HUD: the team colour in team modes (as the arena shows it), else the slot colour. */
export function slotColor(state: SimState | null, id: number | null | undefined): string {
  if (id == null || !state) return '#bbbbbb'
  const s = state.slots.find((x) => x.id === id)
  if (!s) return '#bbbbbb'
  return playerColor(s, state.settings.teamMode)
}

/** Shape for a player id in the current state ('' unless the colourblind palette is on). */
export function slotGlyph(state: SimState | null, id: number | null | undefined): string {
  const s = id == null || !state ? null : state.slots.find((x) => x.id === id)
  return s && state ? playerGlyph(s, state.settings.teamMode, colorblindPalette()) : ''
}

/** Colour of a slot as shown: team colour in team modes, else its own; both in the viewer's palette. */
export function playerColor(slot: Pick<PlayerSlot, 'color' | 'team'>, teamMode: TeamMode | undefined): string {
  return teamMode && teamMode !== 'ffa' ? teamColor(slot.team) : hex(displayColor(slot.color))
}

/**
 * Shape for a player (team modes: for the team), shown next to names when the
 * colourblind palette is on, so identity never rests on colour alone. '' when off.
 */
export function playerGlyph(slot: Pick<PlayerSlot, 'color' | 'team'>, teamMode: TeamMode | undefined, cb: boolean): string {
  if (!cb) return ''
  const i = teamMode && teamMode !== 'ffa' ? slot.team : paletteIndex(slot.color)
  return i >= 0 ? (PLAYER_GLYPHS[i % PLAYER_GLYPHS.length] ?? '') : ''
}

export function ticksToSeconds(ticks: number): number {
  return ticks / TICK_HZ
}

/** Knockback multiplier from knockback points, as the sim applies it (systems.md §5.2). */
export function kbMultiplier(kbPoints: number): number {
  return 1 + kbPoints / 1000
}

/** Team names follow the player palette by index, so "Purple team" wears purple (see teamColor). */
export function teamName(team: number): string {
  return paletteName(team)
}

/** Team colour in team modes: the player palette by team index, in the viewer's palette (render uses the same). */
export function teamColor(team: number): string {
  return hex(paletteColor(team))
}

/** "Mira", "Mira and Thorn", "Mira, Thorn and Vex" */
export function listNames(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * The winners as a banner reads them: one player by name; a whole team in a
 * team mode by its team ("Purple team"); otherwise a natural list. `plural`
 * picks "win" over "wins". Null when nobody won.
 */
export function winnersText(slots: readonly Pick<PlayerSlot, 'id' | 'name' | 'team'>[], winners: readonly number[], teamMode: TeamMode | undefined): { text: string; plural: boolean } | null {
  const ws = winners.map((id) => slots.find((s) => s.id === id)).filter((s): s is Pick<PlayerSlot, 'id' | 'name' | 'team'> => !!s)
  if (ws.length === 0) return null
  if (ws.length === 1) return { text: ws[0].name, plural: false }
  if (teamMode && teamMode !== 'ffa' && ws.every((s) => s.team === ws[0].team)) return { text: `${teamName(ws[0].team)} team`, plural: false }
  return { text: listNames(ws.map((s) => s.name)), plural: true }
}

/**
 * Whether the local player can buy right now. The sim's canBuy(state, player)
 * (shop phase, or your pawn is dead) when it exists; before that, shopOpen().
 * Looked up by key so the build works whether or not the sim exports it yet.
 */
type CanBuy = (state: SimState, player: number) => boolean
const simApi = sim as unknown as Record<string, unknown>
export function canBuyNow(state: SimState): boolean {
  const fn = simApi['canBuy'] as CanBuy | undefined
  return typeof fn === 'function' ? fn(state, frame.localPlayer) : sim.shopOpen(state)
}
