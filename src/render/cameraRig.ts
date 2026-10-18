import * as THREE from 'three/webgpu'
import { S, TILE_TOP_H } from './coords'

/**
 * Tilted top-down follow camera with the original zoom model
 * (docs/research/systems.md §9.5): distance 500..1500 game units, start 1100,
 * 200 per wheel notch computed from the current (not target) distance,
 * smoothed every 1/60 s with dist = 0.8 * dist + 0.2 * target.
 *
 * Deviation (overview zoom, requested): past the original 1500 the camera
 * zooms out further, to ZOOM_MAX, where a full-size arena (radius 2000, ten
 * players) fits a 16:9 screen with a margin. Beyond 1500 a notch scales the
 * distance by the same ratio the last original notch had (x 1.133), so the
 * zoom feels the same, and the framing eases from "warlock a little below
 * centre" to centred on the arena (see frameOffset).
 */
export const ZOOM_MIN = 500
export const ZOOM_MAX = 3600
export const ZOOM_DEFAULT = 1100
export const ZOOM_STEP = 200
/** end of the original zoom range */
export const ZOOM_ORIGINAL_MAX = 1500
const ZOOM_RATIO = 1 + ZOOM_STEP / ZOOM_ORIGINAL_MAX

/**
 * Vertical framing: how far past the focus the camera looks, as a fraction
 * of the distance. 0.1 (warlock slightly below centre) up to the original max
 * zoom, easing to -0.2 at the overview zoom, which centres a whole arena on
 * screen (the near side of a 60 degree view is otherwise the limit).
 */
export function frameOffset(dist: number): number {
  const t = Math.max(0, Math.min(1, (dist - ZOOM_ORIGINAL_MAX) / (ZOOM_MAX - ZOOM_ORIGINAL_MAX)))
  const k = t * t * (3 - 2 * t)
  return cameraParams.centerOffset + (-0.2 - cameraParams.centerOffset) * k
}

/** Next zoom distance from `dist` after `notches` wheel notches (+ = out, fractional ok). */
export function zoomStep(dist: number, notches: number): number {
  let d = dist
  let n = notches
  while (Math.abs(n) > 1e-6) {
    const k = Math.sign(n) * Math.min(1, Math.abs(n))
    n -= k
    // original 200-unit steps up to 1500; beyond, the same relative step
    if (k > 0) d = d < ZOOM_ORIGINAL_MAX ? d + ZOOM_STEP * k : d * Math.pow(ZOOM_RATIO, k)
    else d = d > ZOOM_ORIGINAL_MAX ? d * Math.pow(ZOOM_RATIO, k) : d + ZOOM_STEP * k
  }
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, d))
}
/**
 * Live-tunable camera shape (Inspector "Camera" group). Dota-matched:
 * pitch 60 degrees below horizontal; FOV 70 degrees horizontal on Dota's 4:3
 * baseline with Hor+ widening (vertical ~55 degrees, ~86 degrees horizontal at
 * 16:9), which shows ~2000 game units across the screen centre at the
 * default distance 1100. The vertical FOV never drops below the baseline, so
 * wider screens see more to the sides and narrower ones more vertically.
 * `centerOffset` puts the pawn slightly below screen centre.
 */
export const cameraParams = {
  pitch: 60,
  hfov: 70,
  centerOffset: 0.1,
}
const REF_ASPECT = 4 / 3
const D2R = Math.PI / 180

function verticalFov(aspect: number): number {
  const th = Math.tan((cameraParams.hfov * D2R) / 2)
  const vRef = 2 * Math.atan(th / REF_ASPECT)
  const vHere = 2 * Math.atan(th / Math.max(0.1, aspect))
  return Math.max(vRef, vHere) / D2R
}

/** Dev-only: pin the match camera to a game position (look-dev screenshots). */
export const devCamera = { focus: null as { x: number; y: number } | null }

/** Free camera (replay viewer): hold the camera on a game-unit point; null = follow again. */
export function setCameraFocus(p: { x: number; y: number } | null): void {
  devCamera.focus = p ? { x: p.x, y: p.y } : null
}

/** Audio listener / screen-space helpers, updated every frame (game units). */
export const cameraListener = { x: 0, y: 0, halfWidth: 1000 }

class CameraRig {
  dist = ZOOM_DEFAULT
  targetDist = ZOOM_DEFAULT
  /** smoothed focus point, game units */
  fx = 0
  fy = 0
  private snap = true
  private shakeAmp = 0
  private shakeT = 0
  // directional kick (game units), damped spring back to rest
  private kx = 0
  private ky = 0
  private kvx = 0
  private kvy = 0
  private tmp = new THREE.Vector3()

  reset(): void {
    this.dist = ZOOM_DEFAULT
    this.targetDist = ZOOM_DEFAULT
    this.snap = true
    this.shakeAmp = 0
    this.kx = this.ky = this.kvx = this.kvy = 0
  }

  zoom(notches: number): void {
    this.targetDist = zoomStep(this.dist, notches)
  }

  /** bumped by recenter(): the world drops any camera reach offset */
  recenterSeq = 0

  recenter(): void {
    this.snap = true
    this.recenterSeq++
  }

  /** Add trauma (0..1+). Shake amplitude decays quickly. */
  shake(amount: number): void {
    this.shakeAmp = Math.min(1.4, this.shakeAmp + amount)
  }

  /** Punch the camera along a game-space direction (hit direction), `amount` game units/s. */
  kick(dx: number, dy: number, amount: number): void {
    const l = Math.hypot(dx, dy) || 1
    this.kvx += (dx / l) * amount
    this.kvy += (dy / l) * amount
  }

  /**
   * Move toward focus point (game units). `fov` vertical degrees.
   */
  update(camera: THREE.PerspectiveCamera, focusX: number, focusY: number, dt: number, aspect: number, shakeScale: number): void {
    // zoom smoothing, frame-rate independent form of 0.8/0.2 per 1/60 s
    const zk = 1 - Math.pow(0.8, dt * 60)
    this.dist += (this.targetDist - this.dist) * zk
    if (this.snap) {
      this.fx = focusX
      this.fy = focusY
      this.snap = false
    } else {
      const fk = 1 - Math.exp(-dt * 7)
      this.fx += (focusX - this.fx) * fk
      this.fy += (focusY - this.fy) * fk
    }
    let sx = 0
    let sy = 0
    let sz = 0
    if (this.shakeAmp > 0.001 && shakeScale > 0) {
      this.shakeT += dt
      const a = this.shakeAmp * this.shakeAmp * 28 * shakeScale
      const t = this.shakeT * 42
      sx = (Math.sin(t * 1.0) + Math.sin(t * 2.3 + 1.7) * 0.5) * a
      sy = (Math.sin(t * 1.3 + 0.4) + Math.sin(t * 2.9 + 2.2) * 0.5) * a
      sz = Math.sin(t * 1.7 + 3.1) * a * 0.5
      this.shakeAmp *= Math.exp(-dt * 6)
    } else {
      this.shakeAmp = 0
    }
    // kick spring (stiff, well damped): a short shove that settles in ~0.25 s
    const cdt = Math.min(dt, 1 / 30)
    this.kvx += (-this.kx * 260 - this.kvx * 22) * cdt
    this.kvy += (-this.ky * 260 - this.kvy * 22) * cdt
    this.kx += this.kvx * cdt
    this.ky += this.kvy * cdt
    sx += this.kx * shakeScale
    sy -= this.ky * shakeScale
    const d = this.dist
    const pitch = cameraParams.pitch * D2R
    // look slightly past the pawn so it sits a little below screen centre
    const ahead = d * frameOffset(d)
    const tx = this.fx * S
    const ty = TILE_TOP_H * S
    const tz = -(this.fy + ahead) * S
    camera.position.set(tx + sx * S, ty + Math.sin(pitch) * d * S + sz * S, tz + Math.cos(pitch) * d * S + sy * S)
    this.tmp.set(tx + sx * S * 0.5, ty, tz + sy * S * 0.5)
    camera.lookAt(this.tmp)
    const vfov = verticalFov(aspect)
    if (Math.abs(camera.fov - vfov) > 0.01) {
      camera.fov = vfov
      camera.updateProjectionMatrix()
    }
    cameraListener.x = this.fx
    cameraListener.y = this.fy
    cameraListener.halfWidth = d * Math.tan((vfov * D2R) / 2) * aspect
  }
}

export const cameraRig = new CameraRig()

/** Snap the match camera back onto the local pawn (Space). */
export function recenterCamera(): void {
  cameraRig.recenter()
}

/** Inspector-friendly view of the zoom: reads/writes the target distance. */
export const cameraZoomParam = {
  get distance(): number {
    return cameraRig.targetDist
  },
  set distance(v: number) {
    cameraRig.targetDist = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v))
  },
}

/** Zoom by wheel notches (+ = out). The match view already handles the mouse wheel. */
export function zoomCamera(notches: number): void {
  cameraRig.zoom(notches)
}

/** Pending move-marker requests from the UI (consumed by the match world). */
export const moveMarkers: { x: number; y: number; at: number }[] = []

/**
 * Show a Dota-style move marker (green chevrons) at a game position right
 * away, e.g. from the right-click handler. The match view also derives
 * markers from the local pawn's moveTarget, so calling this is optional; it
 * only removes the network delay.
 */
export function showMoveMarker(x: number, y: number): void {
  if (moveMarkers.length < 8) moveMarkers.push({ x, y, at: performance.now() })
}
