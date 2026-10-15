import { frame } from '../../game/frame'
import type { PawnState, PlayerScore, PlayerSlot, SimState } from '../../sim/types'
import { TICK_HZ } from '../../sim/types'
import * as sim from '../../sim'

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

export function slotColor(state: SimState | null, id: number | null | undefined): string {
  if (id == null || !state) return '#bbbbbb'
  const s = state.slots.find((x) => x.id === id)
  return s ? hex(s.color) : '#bbbbbb'
}

export function ticksToSeconds(ticks: number): number {
  return ticks / TICK_HZ
}

/** Knockback multiplier from knockback points, as the sim applies it (systems.md §5.2). */
export function kbMultiplier(kbPoints: number): number {
  return 1 + kbPoints / 1000
}

export const TEAM_NAMES = ['Red', 'Blue', 'Teal', 'Purple', 'Yellow', 'Orange', 'Green', 'Pink', 'Gray', 'Light Blue']

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
