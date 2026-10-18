import { Vector3, type PerspectiveCamera } from 'three/webgpu'
import { S } from '../coords'
import { spellPalette } from '../vfx/palette'
import { Color } from 'three/webgpu'
import { Billboards } from './Billboards'

// Flat marks on the casting hand, never projectile cores. Their complete
// silhouettes appear at charge start; progress changes brightness, not travel.
type Stroke = readonly [number, number, number, number]
export const HAND_MARKS: Readonly<Record<string, readonly Stroke[]>> = {
  fireball: [
    [-.65,-.65,-.85,-.1],[-.85,-.1,-.55,.4],[-.55,.4,-.5,.8],[-.5,.8,-.2,.1],
    [-.2,.1,-.08,.95],[-.08,.95,.32,.45],[.32,.45,.25,-.1],
    [.25,-.1,.65,.5],[.65,.5,.85,-.2],[.85,-.2,.55,-.65],[-.65,-.65,.55,-.65],
  ],
  twin: [
    [-.9,0,-.55,.85],[-.55,.85,-.2,0],[-.2,0,-.55,-.85],[-.55,-.85,-.9,0],
    [.2,0,.55,.85],[.55,.85,.9,0],[.9,0,.55,-.85],[.55,-.85,.2,0],
  ],
  cluster: [
    [-.85,-.35,-.85,-.85],[-.85,-.85,-.35,-.85],
    [.35,-.85,.85,-.85],[.85,-.85,.85,-.35],
    [.85,.35,.85,.85],[.85,.85,.35,.85],
    [-.35,.85,-.85,.85],[-.85,.85,-.85,.35],
  ],
  bouncer: [
    [-.85,-.65,-.25,-.65],[-.25,-.65,-.6,.15],[-.6,.15,.6,-.15],
    [.6,-.15,.25,.65],[.25,.65,.85,.65],
  ],
  boomerang: [
    [.55,.85,-.2,.85],[-.2,.85,-.75,.45],[-.75,.45,-.95,0],
    [-.95,0,-.75,-.45],[-.75,-.45,-.2,-.85],[-.2,-.85,.55,-.85],
    [.55,-.85,.05,-.4],[.05,-.4,-.15,0],[-.15,0,.05,.4],[.05,.4,.55,.85],
  ],
  magnetize: [
    [-.8,.15,-.8,.8],[-.8,.8,.8,.8],[.8,.8,.8,.15],[0,.8,0,.5],
    [-.8,-.15,-.8,-.8],[-.8,-.8,.8,-.8],[.8,-.8,.8,-.15],[0,-.8,0,-.5],
  ],
  gravity: [
    [.85,.45,.5,.9],[.5,.9,-.45,.9],[-.45,.9,-.9,.25],[-.9,.25,-.7,-.6],
    [-.7,-.6,0,-.9],[0,-.9,.7,-.5],[.7,-.5,.5,.15],[.5,.15,-.05,.4],
    [-.05,.4,-.4,.05],[-.4,.05,-.15,-.25],[-.15,-.25,.15,-.05],
  ],
  snowball: [
    [0,-.95,0,.95],[-.82,-.48,.82,.48],[-.82,.48,.82,-.48],
    [0,.65,-.25,.8],[0,.65,.25,.8],[0,-.65,-.25,-.8],[0,-.65,.25,-.8],
    [.56,.33,.55,.62],[.56,.33,.82,.2],[-.56,-.33,-.55,-.62],[-.56,-.33,-.82,-.2],
    [.56,-.33,.55,-.62],[.56,-.33,.82,-.2],[-.56,.33,-.55,.62],[-.56,.33,-.82,.2],
  ],
}

export function hasHandMark(spell: string): boolean { return HAND_MARKS[spell] !== undefined }

/** One pooled sprite batch for all hand marks; no per-pawn objects or particles. */
export class CastMarks {
  readonly batch = new Billboards(512, false, null, true)
  private right = new Vector3()
  private up = new Vector3()
  private color = new Color()

  constructor() { this.batch.sprite.name = 'cast-hand-marks' }

  begin(camera: PerspectiveCamera): void {
    this.batch.begin()
    this.right.setFromMatrixColumn(camera.matrixWorld, 0)
    this.up.setFromMatrixColumn(camera.matrixWorld, 1)
  }

  charge(spell: string, hand: Vector3, progress: number): void {
    const strokes = HAND_MARKS[spell]
    if (!strokes) return // Only explicitly authored spells use this batch.
    this.color.setHex(spellPalette(spell).accent)
    const c = this.color
    const peak = Math.max(c.r, c.g, c.b)
    const strength = .8 + progress * .65
    const r = c.r / peak * strength
    const g = c.g / peak * strength
    const b = c.b / peak * strength
    const radius = 27 * S
    for (const [x0, y0, x1, y1] of strokes) {
      this.stroke(hand, x0 * radius, y0 * radius, x1 * radius, y1 * radius, 6 * S, r, g, b)
    }
  }

  /** A dim broken ring folds inward at the *current* hand, with no release burst. */
  cancel(hand: Vector3, fraction: number): void {
    const radius = (1 - fraction) * 20 * S
    const dim = (1 - fraction) * .35
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2
      const b = a + .65
      this.stroke(hand, Math.cos(a) * radius, Math.sin(a) * radius, Math.cos(b) * radius, Math.sin(b) * radius, 4 * S, dim * .65, dim * .7, dim)
    }
  }

  private stroke(hand: Vector3, x0: number, y0: number, x1: number, y1: number, width: number, r: number, g: number, b: number): void {
    const mx = (x0 + x1) * .5
    const my = (y0 + y1) * .5
    const dx = x1 - x0
    const dy = y1 - y0
    const length = Math.hypot(dx, dy) + width * .6
    this.batch.addStreak(
      hand.x + this.right.x * mx + this.up.x * my,
      hand.y + this.right.y * mx + this.up.y * my,
      hand.z + this.right.z * mx + this.up.z * my,
      width, length / width, Math.atan2(dy, dx), r, g, b, .6,
    )
  }
}
