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
  lower?: LowerThird
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
  /** world overlay nameplates / combat numbers (default true / true) */
  plates?: boolean
  nums?: boolean
}

export interface ShotSpec extends SimShotSpec {
  id: string
  /** video seconds */
  dur: number
  /** time scale as a function of sim seconds (1 = real time) */
  speed?(st: number): number
  camera(c: CamCtx): CamPose
  overlay?: OverlaySpec
  /** whose point of view the world renders (Windwalk ghosting, nameplate highlight); default 0 */
  localPlayer?: number
  /** rendered but not captured frames before the shot (camera settle, default 12) */
  preroll?: number
}
