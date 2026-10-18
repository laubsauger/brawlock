/**
 * Which move destination to show for the local warlock (pure logic, tested).
 *
 * The sim's move target is the source of truth: it follows prediction and
 * rollback, stays through knockback (the warlock walks back), and the sim
 * drops it on arrival, stop / hold, a cast order, death and round reset.
 * The last click only bridges the gap until that order lands (network delay,
 * or a move the input layer holds during a windup when "Move cancels cast"
 * is off: then it shows as queued while the windup lasts).
 */

export interface DestClick {
  x: number
  y: number
  /** world clock (s) when the order was issued */
  at: number
  /** held by the input layer until the current windup ends */
  queued: boolean
}

export interface DestPawn {
  alive: boolean
  moveTarget: { x: number; y: number } | null
  cast: unknown
}

export interface DestResult {
  show: boolean
  x: number
  y: number
  queued: boolean
  /** the click to keep for the next frame (null once the sim has it, or it expired) */
  click: DestClick | null
}

/** how long a click is shown on its own while its order is in flight (s) */
export const CLICK_BRIDGE_S = 0.6
/** the sim's target counts as the clicked one within this distance (game units) */
export const SAME_TARGET = 2

export function resolveDestination(pawn: DestPawn | undefined, click: DestClick | null, t: number): DestResult {
  const out: DestResult = { show: false, x: 0, y: 0, queued: false, click }
  if (!pawn || !pawn.alive) {
    out.click = null
    return out
  }
  const st = pawn.moveTarget
  if (click) {
    if (st && Math.hypot(st.x - click.x, st.y - click.y) < SAME_TARGET) out.click = null
    else if (click.queued && pawn.cast) {
      out.show = true
      out.x = click.x
      out.y = click.y
      out.queued = true
      return out
    } else if (t - click.at < CLICK_BRIDGE_S) {
      out.show = true
      out.x = click.x
      out.y = click.y
      return out
    } else out.click = null
  }
  if (st) {
    out.show = true
    out.x = st.x
    out.y = st.y
  }
  return out
}
