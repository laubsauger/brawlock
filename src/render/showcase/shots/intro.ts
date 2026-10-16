/** Cold open (caldera reveal + wordmark) and the quick how-to-play tips. */
import { FLOOR, ease5, lerp } from '../cam'
import type { LowerThird, ShotSpec } from '../types'
import { DUMMIES, HERO, stage } from './common'
import { LAYER } from './kit'

const TIP_HUE = '#ffc548'

function tip(n: number, name: string, line: string): LowerThird {
  return { name, color: '#ffe2b8', kicker: `How to play · ${n}/3`, kickerColor: TIP_HUE, line }
}

export const OPEN_SHOTS: ShotSpec[] = [
  {
    // branded intro: splash art, the wordmark lands, burn to black into the cold open
    id: 'brand',
    dur: 5.6,
    players: [HERO],
    layer: LAYER,
    theme: 1,
    camera(c) {
      return { x: 0, y: -2000, h: 1600, tx: 0, ty: 0, th: FLOOR, fov: 40 + c.vt * 0 }
    },
    overlay: { logo: false, plates: false, nums: false, fadeIn: 0.9, fadeOut: 0.5, brand: { at: 0, mark: 1.5, out: 4.75 } },
  },
  {
    id: 'open',
    dur: 7.5,
    players: [HERO, DUMMIES[0], DUMMIES[1], DUMMIES[2]],
    layer: LAYER,
    theme: 1,
    level: 4,
    setup(s) {
      s.put(0, -380, -120, 0)
      s.put(1, 360, 60, Math.PI)
      s.put(2, -120, 520, -1)
      s.put(3, 220, -560, 2)
    },
    script: [
      [0.6, (s) => s.castAt(0, 'fireball', 1)],
      [1.7, (s) => s.castAt(1, 'fireball', 0)],
      [2.6, (s) => s.castAt(2, 'lightning', 3)],
      [3.4, (s) => s.castAt(0, 'fireball', 1)],
      [4.3, (s) => s.castAt(3, 'fireball', 2)],
      [5.2, (s) => s.castAt(1, 'fireball', 0)],
      [6.0, (s) => s.castAt(2, 'fireball', 0)],
    ],
    camera(c) {
      // high over the rim first, then down into the caldera once inside the cliff ring
      const t = c.vt / 7.5
      const horiz = lerp(2700, 1880, ease5(t))
      const h = lerp(3400, 1300, ease5(Math.max(0, (t - 0.42) / 0.58)))
      const yaw = (lerp(205, 168, ease5(t)) * Math.PI) / 180
      return { x: Math.sin(yaw) * horiz, y: -Math.cos(yaw) * horiz, h, tx: 0, ty: 60, th: FLOOR + 60, fov: 40 }
    },
    overlay: { fadeIn: 1.2, logo: false, plates: false, nums: false, hero: { at: 2.0, until: 7.3, tagline: 'Knock rival warlocks into the lava' } },
  },
]

export const TIP_SHOTS: ShotSpec[] = [
  {
    id: 'tip_move',
    dur: 3.2,
    players: [HERO, DUMMIES[0]],
    layer: LAYER,
    theme: 0,
    localPlayer: 0,
    setup(s) {
      s.put(0, -380, 560, 0.5)
      s.put(1, 520, 760, Math.PI)
    },
    script: [
      [0.15, (s) => s.move(0, 60, 820)],
      [1.65, (s) => s.move(0, 300, 560)],
    ],
    camera: stage({ pitch: 58, yaw: 0, push: 0.05, include: [{ x: -420, y: 900 }, { x: 560, y: 500 }] }),
    overlay: { lower: tip(1, 'Right-click to move', 'Your warlock walks where you click.'), plates: true },
  },
  {
    id: 'tip_cast',
    dur: 3.2,
    players: [HERO, DUMMIES[0]],
    layer: LAYER,
    theme: 0,
    localPlayer: 0,
    setup(s) {
      s.put(0, -420, 650, 0)
      s.put(1, 230, 650, Math.PI)
    },
    script: [
      [0.25, (s) => s.castAt(0, 'fireball', 1)],
      [1.45, (s) => s.castAt(0, 'fireball', 1)],
    ],
    camera: stage({ pitch: 56, yaw: 0, push: 0.05 }),
    overlay: { lower: tip(2, 'Cast at the cursor', 'Spells fly toward your cursor. Every hit shoves.'), plates: true },
  },
  {
    id: 'tip_lava',
    dur: 3.6,
    players: [HERO, DUMMIES[2]],
    layer: LAYER,
    theme: 0,
    localPlayer: 0,
    setup(s) {
      s.put(0, 860, 100, 0)
      s.put(1, 1340, 60, Math.PI)
      s.hp(1, 140)
    },
    script: [[0.25, (s) => s.castAt(0, 'fireball', 1)]],
    camera: stage({ pitch: 54, yaw: 0, push: 0.05, include: [{ x: 1950, y: 80 }] }),
    overlay: { lower: tip(3, 'Lava burns', '100 damage a second. Push them in.'), plates: true },
  },
]
