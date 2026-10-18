import type { Vec2 } from '../sim/types'

/** One continuous camera move: a shallow arc, then a closer, lower look at the exchange. */
export function menuCameraAt(seconds: number, focus: Vec2, out: Vec2, aspect: number, reducedMotion: boolean) {
  const t = reducedMotion ? 0 : seconds
  const arc = Math.sin(t * Math.PI * 2 / 72) * 0.14
  const close = (1 - Math.cos(t * Math.PI * 2 / 48)) * 0.5
  const c = Math.cos(arc)
  const s = Math.sin(arc)
  const ux = out.x * c - out.y * s
  const uy = out.x * s + out.y * c
  const rx = uy
  const ry = -ux
  // Portrait screens see a wider establishing view; the menu remains the foreground.
  const fit = Math.max(1, 1.2 / aspect)
  const back = (1480 - close * 180) * fit
  const height = (970 - close * 140) * fit
  const fov = 35
  const ahead = 40
  const screenX = aspect < 1 ? 0.65 : 0.72
  const reach = Math.hypot(back + ahead, height)
  const shift = reach * (2 * screenX - 1) * Math.tan(fov * Math.PI / 360) * aspect
  return {
    x: focus.x - ux * back,
    y: focus.y - uy * back,
    height,
    aimX: focus.x + ux * ahead - rx * shift,
    aimY: focus.y + uy * ahead - ry * shift,
    fov,
  }
}
