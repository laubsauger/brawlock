/**
 * Final Blow camera shots (docs/moonshot/specs/final-blow.md, Rule 5), pure game-unit math:
 * - push: side-on to the victim's knockback, on the side nearer the arena centre, 38 degrees
 *   down, easing from 1,000 to 850 units over the slow segment (wider when hitter and victim
 *   do not fit), aimed 65% of the way from the hitter to the victim;
 * - death: after a cut, the same side (no line crossing), 50 degrees down, 900 units, on the
 *   death position;
 * - reduced motion: the gameplay framing, still, on the hit or on the death after a cut.
 * The match version orbits 20 degrees during the slow segment.
 */
import { FLOOR, ease, gameplay, lerp, orbit, type CamPose } from './cinematic/cam'
import type { FinalBlowKind, FinalBlowShot } from '../game/finalBlow'

const PUSH_PITCH = 38
const DEATH_PITCH = 50
const FOV = 40
const PUSH_FAR = 1000
const PUSH_NEAR = 850
const PUSH_MAX = 1400
const DEATH_DIST = 900
/** aim this high above the floor */
const AIM_LIFT = 60
/** the push target sits this far from the hitter toward the victim */
const PUSH_AIM = 0.65
/** the match version orbits this far (degrees) over its slow segment */
const MATCH_ORBIT = 20
/** hitter and victim fill at most 80% of the frame width: visible width per unit distance at 40 degrees, 16:9 */
const FIT_WIDTH = 0.8 * 2 * Math.tan(Math.atan(Math.tan((FOV / 2) * (Math.PI / 180)) * (16 / 9)))

interface P {
  x: number
  y: number
}

/**
 * The shot's side, as an orbit yaw (degrees), fixed for the whole replay: perpendicular to the
 * knockback direction (else hitter to victim, else east-west), on the side nearer the centre.
 */
export function finalBlowYaw(target: P, dirX: number, dirY: number, hitter: P | null, victim: P): number {
  let dx = dirX
  let dy = dirY
  if (Math.hypot(dx, dy) < 1e-6 && hitter) {
    dx = victim.x - hitter.x
    dy = victim.y - hitter.y
  }
  const l = Math.hypot(dx, dy)
  if (l < 1e-6) {
    dx = 1
    dy = 0
  } else {
    dx /= l
    dy /= l
  }
  // camera offsets either side of the line; orbit puts the camera at (sin a, -cos a) from the target
  const a = { x: -dy, y: dx }
  const b = { x: dy, y: -dx }
  const pick = Math.hypot(target.x + a.x * PUSH_FAR, target.y + a.y * PUSH_FAR) <= Math.hypot(target.x + b.x * PUSH_FAR, target.y + b.y * PUSH_FAR) ? a : b
  return (Math.atan2(pick.x, -pick.y) * 180) / Math.PI
}

/** where the push shot aims: 65% of the way from the hitter to the victim (the victim alone without a hitter) */
export function pushTarget(hitter: P | null, victim: P): P {
  return hitter ? { x: lerp(hitter.x, victim.x, PUSH_AIM), y: lerp(hitter.y, victim.y, PUSH_AIM) } : { x: victim.x, y: victim.y }
}

export interface ShotInput {
  shot: FinalBlowShot
  /** reduced motion: the gameplay framing, still */
  reduced: boolean
  kind: FinalBlowKind
  yaw: number
  /** progress through the slow segment, 0..1 (1 after it) */
  slow: number
  /** the (smoothed) push target */
  target: P
  /** hitter at the hit and victim now, for the fit */
  hitter: P | null
  victim: P
  /** where the victim died, and the hit point (static shots) */
  death: P
  hit: P
}

export function finalBlowPose(i: ShotInput): CamPose {
  if (i.reduced) {
    const at = i.shot === 'death' ? i.death : i.hit
    return gameplay(at.x, at.y, 1100, 50)
  }
  if (i.shot === 'death') return orbit(i.death.x, i.death.y, FLOOR + AIM_LIFT, DEATH_DIST, DEATH_PITCH, i.yaw, FOV)
  let dist = lerp(PUSH_FAR, PUSH_NEAR, ease(i.slow))
  if (i.hitter) dist = Math.min(PUSH_MAX, Math.max(dist, Math.hypot(i.victim.x - i.hitter.x, i.victim.y - i.hitter.y) / FIT_WIDTH))
  const yaw = i.yaw + (i.kind === 'match' ? MATCH_ORBIT * ease(i.slow) : 0)
  return orbit(i.target.x, i.target.y, FLOOR + AIM_LIFT, dist, PUSH_PITCH, yaw, FOV)
}
