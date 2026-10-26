/**
 * How a collected bounty shows (pure logic, tested): the exact authoritative payout labelled
 * above the collector, and a fixed handful of gold facets thrown from the defeated holder that the
 * GPU particle integration (velocity plus gravity over each life) lands on the collector. Payout
 * size changes the label, never particle or voice cost; FX off or reduced motion keeps the label
 * alone.
 */

export interface BountyPoint {
  x: number
  y: number
  /** height of the pawn's feet */
  h: number
}

/** One particle launch (game units, seconds). */
export interface BountyFacet {
  x: number
  y: number
  h: number
  vx: number
  vy: number
  vh: number
  life: number
  gravity: number
}

export interface BountyPlan {
  label: { text: string; x: number; y: number; h: number }
  /** false with FX off or reduced motion: no facets and no ground ring */
  animate: boolean
  facets: BountyFacet[]
}

const FACETS = 10

/** `budget(n)`: how many of n particles the quality tier allows (asked only when animating). */
export function planBountyCollection(victim: BountyPoint, collector: BountyPoint, amount: number, fx: number, reducedMotion: boolean, budget: (n: number) => number): BountyPlan {
  const label = { text: `+${amount} bounty`, x: collector.x, y: collector.y, h: collector.h + 125 }
  const animate = !(fx <= 0 || reducedMotion)
  const facets: BountyFacet[] = []
  const n = animate ? budget(FACETS) : 0
  for (let i = 0; i < n; i++) {
    const angle = i * 2.39996
    const ox = Math.cos(angle) * 15
    const oy = Math.sin(angle) * 15
    const life = 0.3 + (i % 3) * 0.035
    const h = victim.h + 65 + (i % 3) * 8
    const gravity = -850
    facets.push({
      x: victim.x + ox, y: victim.y + oy, h,
      vx: (collector.x - victim.x - ox) / life, vy: (collector.y - victim.y - oy) / life,
      vh: (collector.h + 85 - h - gravity * life * life * 0.5) / life,
      life, gravity,
    })
  }
  return { label, animate, facets }
}
