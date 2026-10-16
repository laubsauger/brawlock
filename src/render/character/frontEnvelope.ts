/**
 * Front-panel envelope spring: how far forward (model metres) the robe front
 * must clear a striding leg. The cloth shader pushes the front panel vertices
 * out to this value, so it must never leave the leg's neighbourhood.
 *
 * Stiff when the leg pushes the panel out, softer when the leg swings back
 * (cloth-like: quick out, slower settle). Integrated in fixed substeps so any
 * frame time is safe: the explicit stiff spring diverges for steps above
 * ~1/16 s, and a warlock's secondary motion can run with a summed dt at
 * reduced detail or after a hitch. Clamped to a band around the leg.
 */

/** substep length (s) */
export const ENV_STEP = 1 / 120
/** never more than this far behind the leg (m): fast strides */
export const ENV_LAG = 0.02
/** never more than this far ahead of the leg (m): overshoot room */
export const ENV_LEAD = 0.15

export interface EnvelopeState {
  /** envelope position (model metres, forward) */
  x: number
  /** velocity (m/s) */
  v: number
}

/** Advance one envelope value toward `target` over `dt` seconds. */
export function stepEnvelope(s: EnvelopeState, target: number, dt: number): void {
  if (!Number.isFinite(s.x) || !Number.isFinite(s.v)) {
    s.x = target
    s.v = 0
  }
  if (!(dt > 0)) return
  const n = Math.max(1, Math.ceil(dt / ENV_STEP))
  const h = dt / n
  let x = s.x
  let v = s.v
  for (let i = 0; i < n; i++) {
    const pushOut = target > x
    const K = pushOut ? 900 : 220
    const C = pushOut ? 50 : 22
    v += ((target - x) * K - v * C) * h
    x += v * h
    if (x < target - ENV_LAG) x = target - ENV_LAG
    else if (x > target + ENV_LEAD) {
      x = target + ENV_LEAD
      if (v > 0) v = 0
    }
  }
  s.x = x
  s.v = v
}
