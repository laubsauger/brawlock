import * as THREE from 'three/webgpu'
import { SPELLS } from '../../sim/spells/data'
import type { PawnState } from '../../sim/types'
import { getSpellColor, luminance, withLuminance, type RGB3 } from '../vfx/palette'
import type { WarlockGpu } from './gpuState'

/**
 * Visual progression (docs/PLAN.md §5.7.1): the warlock shows its build.
 *
 * - Each owned shop column (1..6) lights an accent rune band in that spell's
 *   colour at a fixed garment location, so opponents read the build at a
 *   glance. The player colour stays the primary identity: accents are thinner,
 *   dimmer secondary lines inside the team trims.
 *     column 1  sleeves (cuff)        column 4  cape border
 *     column 2  hood back stripe      column 5  mantle edge
 *     column 3  waist sash            column 6  tabard rune column
 * - Total spell levels (all slots, items included) raise rune density and
 *   brightness, eye glow and, near max, a faint ember aura at the hem, in
 *   steps (POWER_STEPS) from subtle to radiant.
 * - levelUp(colour) on the warlock plays a short burst sweeping feet -> hood.
 */
export const PROGRESSION_LOCATIONS = ['sleeves', 'hood stripe', 'sash', 'cape border', 'mantle edge', 'tabard column'] as const

/** total spell levels at which the next power step starts (power = step / 4) */
export const POWER_STEPS = [4, 10, 18, 28] as const

const tmp: RGB3 = [0, 0, 0]
/** accent band brightness (linear luminance): visible but below the team trims */
const ACCENT_LUMA = 0.32

/** Last applied build per warlock (compared element-wise, no per-frame allocation). */
export interface BuildCache {
  slots: (string | null)[]
  levels: number[]
}

export function newBuildCache(): BuildCache {
  return { slots: [], levels: [] }
}

/** Writes the pawn's build into the GPU state when it changed since the cache. */
export function applyBuild(p: PawnState, gpu: WarlockGpu, cache: BuildCache): void {
  let same = cache.slots.length === p.slots.length
  for (let i = 0; same && i < p.slots.length; i++) same = cache.slots[i] === p.slots[i] && cache.levels[i] === (p.levels[i] ?? 0)
  if (same) return
  cache.slots.length = cache.levels.length = p.slots.length
  for (let i = 0; i < p.slots.length; i++) {
    cache.slots[i] = p.slots[i]
    cache.levels[i] = p.levels[i] ?? 0
  }
  for (const c of gpu.accents) c.setRGB(0, 0, 0)
  let total = 0
  for (let i = 0; i < p.slots.length; i++) {
    const id = p.slots[i]
    if (!id) continue
    total += p.levels[i] ?? 0
    const col = SPELLS[id]?.column ?? 0
    if (col < 1 || col > 6) continue
    const a = getSpellColor(id).accent
    tmp[0] = a.r
    tmp[1] = a.g
    tmp[2] = a.b
    // dark identities (Gravity, Meteor) still read; bright ones don't blow out
    if (luminance(tmp[0], tmp[1], tmp[2]) < 1e-4) tmp[0] = tmp[1] = tmp[2] = 0.3
    withLuminance(tmp, ACCENT_LUMA, tmp)
    gpu.accents[col - 1].setRGB(tmp[0], tmp[1], tmp[2])
  }
  let step = 0
  for (const t of POWER_STEPS) if (total >= t) step++
  gpu.power = step / POWER_STEPS.length
}

/** Starts the level-up burst (colour default: player colour). */
export function startLevelUp(gpu: WarlockGpu, color: number | THREE.Color | null): void {
  if (color === null) gpu.levelColor.copy(gpu.team)
  else if (typeof color === 'number') gpu.levelColor.setHex(color)
  else gpu.levelColor.copy(color)
  gpu.levelSweep = 0
  gpu.levelFlash = 1
}

/** Advances the burst: the band sweeps from the feet to the hood in ~0.6 s, then fades. */
export function tickLevelUp(gpu: WarlockGpu, dt: number): void {
  if (gpu.levelSweep < 0) return
  gpu.levelSweep += dt * 3.4
  if (gpu.levelSweep > 2.1) gpu.levelFlash = Math.max(0, gpu.levelFlash - dt * 4)
  if (gpu.levelFlash <= 0) gpu.levelSweep = -1
}
