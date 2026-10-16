/**
 * Showcase shot list, in edit order. Each module exports its shots; the
 * recorder renders them one page load each and the editor concatenates them.
 */
import type { ShotSpec } from '../types'
import { COL1_SHOTS, KIT_SHOTS } from './kit'
import { COL2_SHOTS, COL3_SHOTS } from './col23'
import { COL4_SHOTS, COL5_SHOTS, COL6_SHOTS } from './col456'
import { ITEM_SHOTS, MECH_SHOTS } from './items'
import { OPEN_SHOTS, TIP_SHOTS } from './intro'
import { BRAWL_SHOTS } from './brawl'
import { END_SHOTS, FINALE_SHOTS } from './finale'
import { TEST_SHOTS } from './test'

export const SHOTS: ShotSpec[] = [...OPEN_SHOTS, ...TIP_SHOTS, ...KIT_SHOTS, ...COL1_SHOTS, ...COL2_SHOTS, ...COL3_SHOTS, ...COL4_SHOTS, ...COL5_SHOTS, ...COL6_SHOTS, ...ITEM_SHOTS, ...MECH_SHOTS, ...BRAWL_SHOTS, ...FINALE_SHOTS, ...END_SHOTS, ...TEST_SHOTS]

export function shotById(id: string): ShotSpec {
  const s = SHOTS.find((x) => x.id === id)
  if (!s) throw new Error(`unknown shot ${id}`)
  return s
}
