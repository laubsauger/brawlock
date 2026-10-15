/**
 * Area threats a bot should walk out of (new; the original AI only dodged projectiles):
 * - an enemy charging Scourge: radius 250 around the caster, fires when its cast point ends;
 * - an enemy Meteor: lands on its target point (data tx, ty, radius) after hover + fall;
 * - an enemy Gravity orb: damages within its dps radius (and pulls within 550), now.
 * All of it is visible state: pawn.cast, projectile data.
 */
import { TICK_HZ } from '../sim/types'
import type { PlayerId, SimState } from '../sim/types'
import { attr, isEnemy, spellDef } from '../sim'

export interface ThreatZone {
  kind: 'scourge' | 'meteor' | 'gravity'
  x: number
  y: number
  /** radius to clear: the hit radius plus our own body */
  r: number
  /** seconds until it strikes; 0 = hurting now */
  fireIn: number
}

export const PAWN_RADIUS = 30
/** Gravity orb position lead (s): where the orb will be when we react. */
const GRAVITY_LEAD = 0.3

export function threatZones(state: SimState, player: PlayerId): ThreatZone[] {
  const zones: ThreatZone[] = []
  for (const p of state.pawns) {
    if (!p.alive || p.cast?.spell !== 'scourge' || !isEnemy(state, player, p.owner)) continue
    const def = spellDef('scourge')
    const radius = def ? attr(def, 'radius', p.levels[p.cast.slot] || 1) : 250
    zones.push({ kind: 'scourge', x: p.x, y: p.y, r: radius + PAWN_RADIUS, fireIn: Math.max(0, p.cast.ticksLeft) / TICK_HZ })
  }
  for (const pr of state.projectiles) {
    if (!isEnemy(state, player, pr.owner)) continue
    const d = pr.data
    if (pr.spell === 'meteor' && pr.kind === undefined && d.tx !== undefined) {
      const left = d.falling ? d.fallTicks - d.elapsed : d.hoverTicks - d.elapsed + d.fallTicks
      zones.push({ kind: 'meteor', x: d.tx, y: d.ty, r: (d.radius || 225) + PAWN_RADIUS, fireIn: Math.max(0, left) / TICK_HZ })
    } else if (pr.spell === 'gravity') {
      zones.push({
        kind: 'gravity',
        x: pr.x + pr.vx * GRAVITY_LEAD,
        y: pr.y + pr.vy * GRAVITY_LEAD,
        r: (d.dpsRadius || 250) + PAWN_RADIUS,
        fireIn: 0,
      })
    }
  }
  return zones
}

export function insideAny(zones: readonly ThreatZone[], x: number, y: number, margin = 0): boolean {
  return zones.some((z) => Math.hypot(x - z.x, y - z.y) < z.r + margin)
}
