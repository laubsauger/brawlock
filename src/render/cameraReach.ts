/**
 * Camera reach: how far the match camera looks away from the local warlock
 * (pure logic, game units, tested). A hybrid of follow and free camera:
 *
 * - Edge pan: with the cursor in a thin band at the screen edge the view pans
 *   that way, accelerating smoothly up to the edge-pan speed, as far as the
 *   reach allows. Leaving the band eases the view back to the warlock.
 * - Peek (held key / middle mouse): the view eases toward the cursor's
 *   screen direction, up to the full reach, and back on release.
 * - Aim look-ahead: while aiming, a capped lean toward the cursor so long
 *   shots see their target region (a much smaller lean otherwise).
 *
 * The offset is clamped to the reach and keeps the view centre over the
 * arena plus a margin. The owner adds it to the warlock's position and feeds
 * the result to the camera rig (which smooths the focus further).
 */

/** screen-edge band that pans, as a fraction of the half-screen (NDC) */
export const EDGE_BAND = 0.035
/** seconds to reach full edge-pan speed */
export const EDGE_RAMP_S = 0.35
/** return-to-warlock spring rate (1/s): critically damped, ~0.6 s to settle */
export const RETURN_RATE = 7
/** peek approach rate (1/s) */
export const PEEK_RATE = 4.5
/** view centre may go this far past the arena edge (game units) */
export const ARENA_MARGIN = 300

/** reach as a fraction of the arena diameter, per setting */
export const REACH_FRACTION = { short: 0.4, normal: 0.75, far: 1 } as const
export type ReachSetting = keyof typeof REACH_FRACTION
/** base edge-pan speed (game units / s) at speed setting 1 */
export const EDGE_SPEED = 1800

export interface ReachInput {
  dt: number
  /** cursor in NDC (-1..1, +y up) and whether it is over the view */
  pointer: { x: number; y: number; inside: boolean }
  /** peek held */
  peek: boolean
  /** aiming a spell (targeting preview up) */
  aiming: boolean
  /** cursor on the ground (game units), valid flag */
  cursor: { x: number; y: number; valid: boolean }
  /** local warlock (game units) */
  pawn: { x: number; y: number }
  /** current arena radius (game units) */
  arenaR: number
  /** max offset from the warlock (game units) */
  reach: number
  /** edge-pan speed (game units / s) */
  edgeSpeed: number
  /** edge pan enabled (settings); absent = on */
  edgePan?: boolean
}

export class CameraReach {
  /** pan / peek offset from the warlock (game units) */
  ox = 0
  oy = 0
  private vx = 0
  private vy = 0
  private edgeT = 0
  /** total focus offset of the last step (pan + look-ahead) */
  readonly out = { x: 0, y: 0 }

  reset(): void {
    this.ox = this.oy = this.vx = this.vy = this.edgeT = 0
    this.out.x = this.out.y = 0
  }

  step(i: ReachInput): { x: number; y: number } {
    const dt = Math.min(0.1, Math.max(0, i.dt))
    const p = i.pointer
    // edge direction in screen space (x right, y up) == game space (x, y)
    let ex = 0
    let ey = 0
    if (p.inside && !i.peek && i.edgePan !== false) {
      if (p.x > 1 - EDGE_BAND) ex = 1
      else if (p.x < -1 + EDGE_BAND) ex = -1
      if (p.y > 1 - EDGE_BAND) ey = 1
      else if (p.y < -1 + EDGE_BAND) ey = -1
    }
    const atEdge = ex !== 0 || ey !== 0
    if (atEdge) {
      this.edgeT = Math.min(EDGE_RAMP_S, this.edgeT + dt)
      const l = Math.hypot(ex, ey)
      // smoothstep ramp: no jolt when the cursor enters the band
      const r = this.edgeT / EDGE_RAMP_S
      const sp = i.edgeSpeed * r * r * (3 - 2 * r)
      const tvx = (ex / l) * sp
      const tvy = (ey / l) * sp
      const k = 1 - Math.exp(-dt * 12)
      this.vx += (tvx - this.vx) * k
      this.vy += (tvy - this.vy) * k
      this.ox += this.vx * dt
      this.oy += this.vy * dt
    } else if (i.peek && p.inside) {
      this.edgeT = 0
      // toward the cursor's screen direction, scaled by how far out it is
      const m = Math.min(1, Math.hypot(p.x, p.y) * 1.15)
      const l = Math.hypot(p.x, p.y) || 1
      const tx = (p.x / l) * i.reach * m
      const ty = (p.y / l) * i.reach * m
      const k = 1 - Math.exp(-dt * PEEK_RATE)
      const nx = this.ox + (tx - this.ox) * k
      const ny = this.oy + (ty - this.oy) * k
      this.vx = dt > 0 ? (nx - this.ox) / dt : 0
      this.vy = dt > 0 ? (ny - this.oy) / dt : 0
      this.ox = nx
      this.oy = ny
    } else {
      this.edgeT = 0
      // critically damped return to the warlock (no overshoot, no bobbing)
      const w = RETURN_RATE
      const ax = -w * w * this.ox - 2 * w * this.vx
      const ay = -w * w * this.oy - 2 * w * this.vy
      this.vx += ax * dt
      this.vy += ay * dt
      this.ox += this.vx * dt
      this.oy += this.vy * dt
      if (Math.hypot(this.ox, this.oy) < 0.5 && Math.hypot(this.vx, this.vy) < 5) this.ox = this.oy = this.vx = this.vy = 0
    }
    this.clamp(i)
    // aim look-ahead on top (not part of the held offset)
    let lx = 0
    let ly = 0
    if (i.cursor.valid) {
      const f = i.aiming ? 0.3 : 0.12
      const cap = i.aiming ? Math.min(650, i.reach * 0.35) : 160
      lx = (i.cursor.x - i.pawn.x) * f
      ly = (i.cursor.y - i.pawn.y) * f
      const l = Math.hypot(lx, ly)
      if (l > cap) {
        lx *= cap / l
        ly *= cap / l
      }
    }
    this.out.x = this.ox + lx
    this.out.y = this.oy + ly
    return this.out
  }

  /** reach circle around the warlock, and the view centre over the arena (+ margin) */
  private clamp(i: ReachInput): void {
    const l = Math.hypot(this.ox, this.oy)
    if (l > i.reach) {
      const s = i.reach / l
      this.ox *= s
      this.oy *= s
      // stop pushing outward
      const d = (this.vx * this.ox + this.vy * this.oy) / (i.reach * i.reach || 1)
      if (d > 0) {
        this.vx -= this.ox * d
        this.vy -= this.oy * d
      }
    }
    const lim = i.arenaR + ARENA_MARGIN
    const cx = i.pawn.x + this.ox
    const cy = i.pawn.y + this.oy
    const c = Math.hypot(cx, cy)
    if (c > lim) {
      const s = lim / c
      this.ox = cx * s - i.pawn.x
      this.oy = cy * s - i.pawn.y
      const d = (this.vx * cx + this.vy * cy) / (c * c)
      if (d > 0) {
        this.vx -= cx * d
        this.vy -= cy * d
      }
    }
  }
}

/** reach in game units for a setting and an arena radius (diameter based) */
export function reachFor(setting: ReachSetting, arenaR: number): number {
  return REACH_FRACTION[setting] * 2 * Math.max(arenaR, 600)
}
