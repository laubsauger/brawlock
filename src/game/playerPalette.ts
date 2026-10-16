/**
 * Player identity colours, the one place that decides how a slot / team
 * colour is SHOWN (PLAN §5.2: colourblind-safe palette option).
 *
 * The sim and the network keep the standard PLAYER_COLORS values in
 * `slot.color` (the lobby assigns them); the colourblind palette is a
 * per-viewer display setting, so every consumer maps through displayColor()
 * at draw time and both palettes stay index-aligned (team names follow the
 * index: "Blue team" is index 1 in both).
 *
 * Colourblind set: searched in OKLab under simulated deuteranopia,
 * protanopia and tritanopia (Machado 2009), each slot kept in its colour
 * family. Closest pair, standard -> colourblind (OKLab dE; ~0.02 is a
 * just-noticeable difference):
 *   deuteranopia blue/purple 0.006 -> 0.115, protanopia red/brown 0.014 -> 0.108,
 *   tritanopia red/pink 0.065 -> 0.071, normal vision stays >= 0.147.
 * Ten colours cannot all be told apart by colour alone under CVD, so
 * PLAYER_GLYPHS gives every slot a shape for plates, kill feed and HUD pills.
 *
 * Setting: `settings.colorblindPalette` (boolean, default false) in
 * game/store; read live, so toggling switches HUD, rings, plates,
 * projectiles and spell tints together on the next frame.
 */
import { PLAYER_COLORS } from '../net/session'
import { useGame } from './store'

/** Index-aligned with PLAYER_COLORS (red, blue, teal, purple, yellow, orange, green, pink, white, brown). */
export const PLAYER_COLORS_CB: readonly number[] = [
  0xe6410d, // vermillion
  0x4588fb, // blue
  0x90ddf6, // sky
  0xc74dbc, // magenta
  0xfaee55, // yellow
  0xf09229, // amber
  0x1a8a68, // bluish green
  0xa9a4e6, // lilac
  0xfaf9f9, // white
  0x9c3418, // rust (the brightest brown that keeps every CVD pair apart)
]

/** Display names per index (team banners, pills). */
export const PLAYER_COLOR_NAMES: readonly string[] = ['Red', 'Blue', 'Teal', 'Purple', 'Yellow', 'Orange', 'Green', 'Pink', 'White', 'Brown']
export const PLAYER_COLOR_NAMES_CB: readonly string[] = ['Vermillion', 'Blue', 'Sky', 'Magenta', 'Yellow', 'Amber', 'Green', 'Lilac', 'White', 'Rust']

/** Shape backup per index (meaning must never rest on colour alone). */
export const PLAYER_GLYPHS: readonly string[] = ['●', '▲', '■', '◆', '★', '✚', '⬟', '⬢', '✦', '▼']

/** True when the viewer picked the colourblind palette. */
export function colorblindPalette(): boolean {
  return (useGame.getState().settings as { colorblindPalette?: boolean }).colorblindPalette === true
}

/** Index of a standard palette colour, -1 for any other colour (dev drivers, mocks). */
export function paletteIndex(hex: number): number {
  return PLAYER_COLORS.indexOf(hex)
}

/** Palette colour for an index (team colour), in the active palette. */
export function paletteColor(index: number, cb = colorblindPalette()): number {
  const pal = cb ? PLAYER_COLORS_CB : PLAYER_COLORS
  const n = pal.length
  return pal[((index % n) + n) % n]
}

/**
 * How a slot colour is shown: standard palette colours swap to the
 * colourblind entry at the same index when the setting is on; any other
 * colour passes through unchanged.
 */
export function displayColor(hex: number, cb = colorblindPalette()): number {
  if (!cb) return hex
  const i = paletteIndex(hex)
  return i < 0 ? hex : PLAYER_COLORS_CB[i]
}

/** Display name of a palette index in the active palette. */
export function paletteName(index: number, cb = colorblindPalette()): string {
  const names = cb ? PLAYER_COLOR_NAMES_CB : PLAYER_COLOR_NAMES
  const n = names.length
  return names[((index % n) + n) % n]
}
