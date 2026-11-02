/**
 * The caldera wall (sim BASIN_WALL_RADIUS): a warlock thrown into the rim knocks rock chips and
 * dust back over the lava, harder the faster it hit. Not a spell: 'wall' never appears on an
 * event or projectile, so it claims nothing.
 */
import type { SimEvent } from '../../../sim/types'
import { registerSpellVfx, type VfxCtx } from '../registry'
import { floorH, rand } from './kitB'

const CHIP = [0.16, 0.12, 0.1] as const
const DUST = [0.24, 0.19, 0.15] as const
const SPARK = [2.6, 0.9, 0.25] as const

registerSpellVfx({
  spell: 'wall',
  onEvent(e: SimEvent, ctx: VfxCtx): void {
    if (e.type !== 'wallHit') return
    const k = Math.min(1, e.speed / 1800)
    const d = Math.hypot(e.x, e.y) || 1
    // back toward the arena, off the rock
    const ix = -e.x / d
    const iy = -e.y / d
    const h = floorH(ctx, e.x, e.y)
    for (let i = ctx.debris.budget((8 + 18 * k) * ctx.fx); i > 0; i--) {
      const s = rand(150, 420) * (0.6 + k)
      ctx.debris.spawn(e.x + rand(-20, 20), e.y + rand(-20, 20), h + rand(30, 110), ix * s + rand(-140, 140), iy * s + rand(-140, 140), rand(180, 420), rand(0.5, 0.9), rand(8, 15), 5, CHIP[0], CHIP[1], CHIP[2], -1600, 0, 0)
    }
    for (let i = ctx.smoke.budget((3 + 6 * k) * ctx.fx); i > 0; i--) {
      ctx.smoke.spawn(e.x + rand(-30, 30), e.y + rand(-30, 30), h + rand(20, 80), ix * rand(40, 120), iy * rand(40, 120), rand(30, 70), rand(0.9, 1.5), 40, 110, DUST[0], DUST[1], DUST[2], 0, 1.2, 15)
    }
    for (let i = ctx.particles.budget(6 * k * ctx.fx); i > 0; i--) {
      ctx.particles.spawn(e.x, e.y, h + rand(40, 100), ix * rand(200, 500) + rand(-150, 150), iy * rand(200, 500) + rand(-150, 150), rand(100, 300), rand(0.25, 0.45), rand(6, 9), 1.5, SPARK[0], SPARK[1], SPARK[2], -900, 1, -0.04)
    }
    ctx.shakeNear(e.x, e.y, 0.15 + 0.35 * k)
  },
})
