/**
 * Lava (systems.md §5.2, assets.md §6.3): every 0.25 s each living pawn whose nearest tile is
 * missing takes lavaDps * 0.25 damage, DP gain factor 0.5, no source and no hit normal (no
 * knockback). A lava death credits the pawn's last hitter.
 */
import { isLocationSafe } from './arena'
import { LAVA_DAMAGE_PERIOD, LAVA_KB_POINT_FACTOR, ticks } from './config'
import { receiveDamage } from './combat'
import type { SimState } from './types'

export function lavaTick(state: SimState): void {
  const period = ticks(LAVA_DAMAGE_PERIOD)
  const burn = state.tick % period === 0
  const amount = state.settings.lavaDps * LAVA_DAMAGE_PERIOD
  for (const pawn of state.pawns) {
    if (!pawn.alive) continue
    if (isLocationSafe(state, pawn.x, pawn.y)) {
      pawn.lavaTicks = 0
      continue
    }
    pawn.lavaTicks += 1
    if (burn) receiveDamage(state, pawn, { amount, source: null, kbVulnerability: LAVA_KB_POINT_FACTOR })
  }
}
