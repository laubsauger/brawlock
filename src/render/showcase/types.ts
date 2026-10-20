/**
 * Showcase shot contract: a sim setup + script (simShot.ts), a camera function
 * evaluated every video frame, a time-scale curve and the overlay copy.
 */
import type { CamPose, V3 } from './cam'
import type { ActionInfo } from './action'
import type { ShotSim, SimShotSpec } from './simShot'

export interface CamCtx {
  /** video seconds since the shot started */
  vt: number
  /** sim seconds since the shot clock started (continuous, slows in slow motion) */
  st: number
  /** video frame delta (1/60) */
  dt: number
  /** shot length, video seconds */
  dur: number
  sim: ShotSim
  /** interpolated pawn position (h = floor height) */
  at(owner: number): V3
  /** interpolated position of the newest live projectile of a spell, null if none */
  projAt(spell: string, owner?: number, kind?: string): V3 | null
  /** per-shot camera memory (followers, latched positions) */
  mem: Record<string, unknown>
  /** dry run of the whole shot: every pawn / projectile position and death */
  action: ActionInfo
}

export interface LowerThird {
  /** spell / beat title */
  name: string
  /** palette id for the accent colour (spell id), or a CSS colour in `color` */
  spell?: string
  color?: string
  /** small caps line above the title (column / role) */
  kicker: string
  /** colour of the kicker (column hue) */
  kickerColor?: string
  /** one line: what happens on screen */
  line: string
  /** video seconds; defaults: 0.25 .. dur - 0.35 */
  at?: number
  until?: number
}

export interface OverlaySpec {
  /** one lower third, or a sequence (each with its own at / until) */
  lower?: LowerThird | LowerThird[]
  /** chapter card (column title) centred high, brief */
  card?: { title: string; sub?: string; color: string; at: number; until: number }
  /** seconds of fade from / to black at the shot edges */
  fadeIn?: number
  fadeOut?: number
  /** small wordmark top-left (default true) */
  logo?: boolean
  /** big centred wordmark reveal (cold open) */
  hero?: { at: number; until?: number; tagline?: string }
  /** end card */
  end?: { at: number }
  /** branded intro over the splash art: wordmark lands at `mark` s, flash-out at `out` s (shot time) */
  brand?: { at: number; mark?: number; out?: number }
  /** world overlay nameplates / combat numbers (default true / true) */
  plates?: boolean
  nums?: boolean
  /** kill stamps and bounty tags on the plates (default true) */
  stamps?: boolean
}

export interface ShotSpec extends SimShotSpec {
  id: string
  /** Existing floor material treatment used for this private capture. */
  floorStyle?: import('../tweaks').FloorStyle
  /** video seconds */
  dur: number
  /** time scale as a function of sim seconds (1 = real time) */
  speed?(st: number): number
  /**
   * time scale as a function of video seconds; wins over `speed`. Can reach 0 (a true freeze:
   * the sim and the render clock stop while the camera keeps moving), which a sim-time curve
   * cannot, since the sim clock would never move past the freeze.
   */
  speedV?(vt: number): number
  camera(c: CamCtx): CamPose
  overlay?: OverlaySpec
  /** whose point of view the world renders (Windwalk ghosting, nameplate highlight); default 0 */
  localPlayer?: number
  /** rendered but not captured frames before the shot (camera settle, default 12) */
  preroll?: number
  /** trailer: video seconds of the shot's key moment (the edit lands it on a beat) */
  hit?: number
  /** Capture-only temporal render steps per output frame (e.g. 4 for a close bullet-time orbit). */
  renderSubsteps?: number
}

/** the shot's time scale at video second `vt` / sim second `st` (never negative) */
export function speedAt(spec: Pick<ShotSpec, 'speed' | 'speedV'>, vt: number, st: number): number {
  return Math.max(0, spec.speedV ? spec.speedV(vt) : spec.speed ? spec.speed(st) : 1)
}
