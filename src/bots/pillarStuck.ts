/**
 * Test helper: how long a pawn keeps pushing into a pillar. A tick counts as stuck when the
 * pawn is walking to a move target that is still far, touches a pillar, and gains less than
 * 30% of its walk speed toward that target.
 */
import { hypot } from '../sim/math'
import { DT } from '../sim/types'
import type { SimState } from '../sim/types'

export class PillarStuckMeter {
  /** longest run of stuck ticks seen per pawn id */
  readonly worst = new Map<number, number>()
  private readonly run = new Map<number, number>()
  private readonly lastDist = new Map<number, number>()

  observe(state: SimState): void {
    for (const p of state.pawns) {
      const target = p.moveTarget
      const dist = target ? hypot(target.x - p.x, target.y - p.y) : -1
      const prev = this.lastDist.get(p.id)
      this.lastDist.set(p.id, dist)
      const walking = p.alive && !p.cast && target !== null && dist > 40 && prev !== undefined && prev >= 0
      const touching = state.obstacles.some((o) => hypot(p.x - o.x, p.y - o.y) < o.radius + 30 + 6)
      const progress = walking ? prev! - dist : 0
      const stuck = walking && touching && progress < 0.3 * p.moveSpeed * DT
      const n = stuck ? (this.run.get(p.id) ?? 0) + 1 : 0
      this.run.set(p.id, n)
      if (n > (this.worst.get(p.id) ?? 0)) this.worst.set(p.id, n)
    }
  }

  get worstTicks(): number {
    let w = 0
    for (const v of this.worst.values()) w = Math.max(w, v)
    return w
  }
}
