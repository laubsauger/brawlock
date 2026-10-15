/**
 * Showcase camera math (plain numbers, no three: shot scripts also run in node).
 * Everything is in game units: x/y on the ground plane, h = height above the
 * world origin (tile tops sit at TILE_TOP_H).
 */

export interface CamPose {
  /** camera position */
  x: number
  y: number
  h: number
  /** look-at point */
  tx: number
  ty: number
  th: number
  /** vertical field of view, degrees */
  fov: number
}

export interface V3 {
  x: number
  y: number
  h: number
}

const D2R = Math.PI / 180

/** height of the arena floor the cameras aim at (= TILE_TOP_H, kept local so node can import this) */
export const FLOOR = 30

/**
 * Orbit pose: camera `dist` away from the target, `pitch` degrees above the
 * ground plane, `yaw` degrees around it (0 = south of the target looking
 * north, like the gameplay camera; 90 = east of it looking west).
 */
export function orbit(tx: number, ty: number, th: number, dist: number, pitch: number, yaw: number, fov = 42): CamPose {
  const p = pitch * D2R
  const a = yaw * D2R
  const hd = Math.cos(p) * dist
  return { x: tx + Math.sin(a) * hd, y: ty - Math.cos(a) * hd, h: th + Math.sin(p) * dist, tx, ty, th, fov }
}

/** The gameplay framing (60 deg pitch, 1100 away) around a point. */
export function gameplay(x: number, y: number, dist = 1100, fov = 50): CamPose {
  return orbit(x, y + dist * 0.1, FLOOR, dist, 60, 0, fov)
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}

/** smoothstep-style ease in/out */
export function ease(t: number): number {
  const x = clamp01(t)
  return x * x * (3 - 2 * x)
}

/** quintic ease (smoother start/stop for long camera moves) */
export function ease5(t: number): number {
  const x = clamp01(t)
  return x * x * x * (x * (x * 6 - 15) + 10)
}

export function easeOut(t: number): number {
  const x = clamp01(t)
  return 1 - (1 - x) * (1 - x) * (1 - x)
}

export function easeIn(t: number): number {
  const x = clamp01(t)
  return x * x * x
}

/** 0..1 progress of `t` through [a, b] */
export function span(t: number, a: number, b: number): number {
  return clamp01((t - a) / Math.max(1e-6, b - a))
}

export function lerpPose(a: CamPose, b: CamPose, t: number): CamPose {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    h: lerp(a.h, b.h, t),
    tx: lerp(a.tx, b.tx, t),
    ty: lerp(a.ty, b.ty, t),
    th: lerp(a.th, b.th, t),
    fov: lerp(a.fov, b.fov, t),
  }
}

/**
 * Critically damped follower for a 3D point (deterministic at a fixed dt).
 * `omega` ~ responsiveness (rad/s): 4 = lazy, 10 = tight.
 */
export class Follow {
  x = 0
  y = 0
  h = 0
  private vx = 0
  private vy = 0
  private vh = 0
  private init = false
  constructor(private omega = 6) {}

  snap(p: V3): void {
    this.x = p.x
    this.y = p.y
    this.h = p.h
    this.vx = this.vy = this.vh = 0
    this.init = true
  }

  update(p: V3, dt: number, omega = this.omega): V3 {
    if (!this.init) {
      this.snap(p)
      return this
    }
    const w = omega
    const step = (x: number, v: number, target: number): [number, number] => {
      // exact critically damped spring step
      const e = Math.exp(-w * dt)
      const d = x - target
      const tmp = (v + w * d) * dt
      return [target + (d + tmp) * e, (v - w * tmp) * e]
    }
    ;[this.x, this.vx] = step(this.x, this.vx, p.x)
    ;[this.y, this.vy] = step(this.y, this.vy, p.y)
    ;[this.h, this.vh] = step(this.h, this.vh, p.h)
    return this
  }
}

/** Keyframed pose track over a time axis: [time, pose, ease?]; holds outside the range. */
export function track(keys: [number, CamPose][], t: number, easing: (x: number) => number = ease5): CamPose {
  if (t <= keys[0][0]) return keys[0][1]
  for (let i = 1; i < keys.length; i++) {
    const [t1, p1] = keys[i]
    if (t <= t1) {
      const [t0, p0] = keys[i - 1]
      return lerpPose(p0, p1, easing((t - t0) / Math.max(1e-6, t1 - t0)))
    }
  }
  return keys[keys.length - 1][1]
}

/** Project a game-space point to NDC (-1..1, y up) for a pose; z > 0 = in front of the camera. */
export function project(pose: CamPose, aspect: number, px: number, py: number, ph: number): { x: number; y: number; z: number } {
  // camera basis (game axes: x east, y north, h up); forward = target - eye
  let fx = pose.tx - pose.x
  let fy = pose.ty - pose.y
  let fh = pose.th - pose.h
  const fl = Math.hypot(fx, fy, fh) || 1
  fx /= fl
  fy /= fl
  fh /= fl
  // right = forward x up(0,0,1) in (x, y, h) coords
  let rx = fy
  let ry = -fx
  const rl = Math.hypot(rx, ry) || 1
  rx /= rl
  ry /= rl
  // up = right x forward
  const ux = ry * fh - 0 * fy
  const uy = 0 * fx - rx * fh
  const uh = rx * fy - ry * fx
  const dx = px - pose.x
  const dy = py - pose.y
  const dh = ph - pose.h
  const z = dx * fx + dy * fy + dh * fh
  const x = dx * rx + dy * ry
  const y = dx * ux + dy * uy + dh * uh
  const t = Math.tan(((pose.fov * Math.PI) / 180) / 2)
  return { x: x / (z * t * aspect), y: y / (z * t), z }
}

export interface FrameBox {
  /** NDC safe area the points must fit in */
  left: number
  right: number
  bottom: number
  top: number
}

/** keep the action clear of the lower third (bottom-left) and the corner logo */
export const SAFE: FrameBox = { left: -0.82, right: 0.86, bottom: -0.5, top: 0.74 }

/**
 * Static framing that fits every point inside `box` when seen from `pitch` / `yaw`
 * (degrees, orbit convention). Returns the fitted pose (look-at re-centred on the
 * points' projected bounds).
 */
export function fitPose(points: V3[], pitch: number, yaw: number, fov: number, aspect: number, box: FrameBox = SAFE, lift = 40): CamPose {
  if (points.length === 0) return orbit(0, 0, FLOOR + lift, 1200, pitch, yaw, fov)
  let cx = 0
  let cy = 0
  for (const p of points) {
    cx += p.x
    cy += p.y
  }
  cx /= points.length
  cy /= points.length
  const fits = (pose: CamPose) => {
    for (const p of points) {
      const q = project(pose, aspect, p.x, p.y, p.h)
      if (q.z <= 1 || q.x < box.left || q.x > box.right || q.y < box.bottom || q.y > box.top) return false
    }
    return true
  }
  let pose = orbit(cx, cy, FLOOR + lift, 1000, pitch, yaw, fov)
  for (let iter = 0; iter < 4; iter++) {
    // distance that fits, by bisection
    let lo = 150
    let hi = 9000
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      if (fits(orbit(cx, cy, FLOOR + lift, mid, pitch, yaw, fov))) hi = mid
      else lo = mid
    }
    pose = orbit(cx, cy, FLOOR + lift, hi, pitch, yaw, fov)
    // re-centre: shift the look-at so the projected bounds sit in the middle of the box
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const p of points) {
      const q = project(pose, aspect, p.x, p.y, p.h)
      minX = Math.min(minX, q.x)
      maxX = Math.max(maxX, q.x)
      minY = Math.min(minY, q.y)
      maxY = Math.max(maxY, q.y)
    }
    const offX = (minX + maxX) / 2 - (box.left + box.right) / 2
    const offY = (minY + maxY) / 2 - (box.bottom + box.top) / 2
    if (Math.abs(offX) < 0.01 && Math.abs(offY) < 0.01) break
    // NDC offset -> ground offset at the look-at distance
    const t = Math.tan(((fov * Math.PI) / 180) / 2)
    const d = hi
    const a = (yaw * Math.PI) / 180
    const p = (pitch * Math.PI) / 180
    const sx = offX * d * t * aspect
    const sy = (offY * d * t) / Math.max(0.2, Math.sin(p))
    // screen right = (cos a, sin a) on the ground; screen up = away from the camera = (-sin a, cos a)
    cx += Math.cos(a) * sx - Math.sin(a) * sy
    cy += Math.sin(a) * sx + Math.cos(a) * sy
  }
  return pose
}
