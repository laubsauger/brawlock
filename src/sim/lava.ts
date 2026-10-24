/**
 * Lava (systems.md §5.2, assets.md §6.3): every 0.25 s each living pawn whose nearest tile is
 * missing takes lavaDps * 0.25 damage, DP gain factor 0.5, no source and no hit normal (no
 * knockback). A lava death credits the pawn's last hitter.
 */
import { isLocationSafe } from './arena'
import { LAVA_DAMAGE_PERIOD, LAVA_KB_POINT_FACTOR } from './config'
import { receiveDamage } from './combat'
import { TICK_HZ, type SimState } from './types'

const LAVA_DAMAGE_PERIOD_PER_SECOND = 1 / LAVA_DAMAGE_PERIOD

export function lavaTick(state: SimState): void {
  // A burst on each tick that starts a new 0.25 s window: every 15th tick at 60 Hz, every 7th
  // or 8th at 30 Hz. The bursts keep their original size and average exactly 0.25 s apart.
  const window = (tick: number) => Math.floor((tick * LAVA_DAMAGE_PERIOD_PER_SECOND) / TICK_HZ)
  const burn = window(state.tick) !== window(state.tick - 1)
  const amount = state.settings.lavaDps * LAVA_DAMAGE_PERIOD
  for (const pawn of state.pawns) {
    if (!pawn.alive) continue
    if (isLocationSafe(state, pawn.x, pawn.y)) {
      pawn.lavaTicks = 0
      continue
    }
    pawn.lavaTicks += 1
    if (burn) receiveDamage(state, pawn, { amount, source: null, kbVulnerability: LAVA_KB_POINT_FACTOR, cause: 'lava' })
  }
}
