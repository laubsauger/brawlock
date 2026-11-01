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
import type { FinalBlowKind, FinalBlowPlan, FinalBlowShot } from '../game/finalBlow'
import type { MomentCamera } from '../game/moments'
import type { SimState } from '../sim/types'

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
/** the push target follows the victim with this lag rate (1/s, playback time) */
const TARGET_RATE = 4
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

/**
 * Frames one replayed moment as it plays: the side is fixed on the first frame, the push target
 * follows the victim with a lag, and the hitter's spot at the hit and the victim's at the death
 * are taken when playback passes them (or given up front, when the states are known).
 */
export class ShotFramer {
  private yaw: number | null = null
  private target: P | null = null
  private hitterAtHit: P | null = null
  private deathAt: P | null = null
  private hitterKnown = false

  constructor(
    private readonly cam: MomentCamera,
    private readonly plan: FinalBlowPlan,
  ) {}

  /** positions known before playback (the Final Blow reads them from the ring) */
  known(hitterAtHit: P | null, deathAt: P | null): void {
    this.hitterAtHit = hitterAtHit
    this.hitterKnown = true
    this.deathAt = deathAt
  }

  pose(c: { tick: number; speed: number; segment: number }, s0: SimState, s1: SimState, alpha: number, dtReal: number): CamPose {
    const at = (id: number | null): (P & { alive: boolean }) | null => {
      if (id === null) return null
      const a = s0.pawns.find((q) => q.id === id)
      const b = s1.pawns.find((q) => q.id === id)
      if (!a || !b) return a ?? b ?? null
      return { x: a.x + (b.x - a.x) * alpha, y: a.y + (b.y - a.y) * alpha, alive: b.alive }
    }
    const victim: P = at(this.cam.subject) ?? { x: this.cam.x, y: this.cam.y }
    const hitterNow = at(this.cam.other)
    if (!this.hitterKnown && c.tick >= this.plan.hit) {
      this.hitterAtHit = hitterNow?.alive ? { x: hitterNow.x, y: hitterNow.y } : null
      this.hitterKnown = true
    }
    const hitter = this.hitterKnown ? this.hitterAtHit : hitterNow?.alive ? hitterNow : null
    if (!this.deathAt && c.tick >= this.plan.death) this.deathAt = { x: victim.x, y: victim.y }
    const want = pushTarget(hitter, victim)
    if (!this.target || this.yaw === null) {
      this.target = { ...want }
      this.yaw = finalBlowYaw(want, this.cam.dirX, this.cam.dirY, hitter, victim)
    }
    const k = 1 - Math.exp(-dtReal * Math.max(c.speed, 0.05) * TARGET_RATE)
    this.target.x += (want.x - this.target.x) * k
    this.target.y += (want.y - this.target.y) * k
    const slowSeg = this.plan.segments.find((s) => s.speed < 1)
    const slow = slowSeg ? Math.max(0, Math.min(1, (c.tick - slowSeg.from) / (slowSeg.to - slowSeg.from))) : 1
    const seg = this.plan.segments[c.segment]
    return finalBlowPose({
      shot: seg.shot, reduced: this.plan.reduced, kind: this.plan.kind, yaw: this.yaw, slow, target: this.target, hitter, victim,
      death: this.deathAt ?? victim,
      hit: hitter ? { x: (hitter.x + victim.x) / 2, y: (hitter.y + victim.y) / 2 } : victim,
    })
  }
}
