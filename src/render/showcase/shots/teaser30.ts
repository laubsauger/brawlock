/** Deliberately staged trailer takes: fixed axes, small eased moves, real spell inputs. */
import { FLOOR, ease5, lerp, orbit } from '../cam'
import type { ShotSpec } from '../types'
import { DUMMIES, HERO } from './common'
import { trailerMatch } from './trailerMatch'

const clean = { logo: false, plates: false, nums: false, stamps: false }
const Y = 850

/** No live following, shake, fitting changes or target switches during a take. */
function composed(x: number, y: number, dist: number, pitch = 44, arc = 4): ShotSpec['camera'] {
  return (c) => {
    const u = ease5(c.vt / c.dur)
    return orbit(x, y, FLOOR + 55, dist * lerp(1.025, 0.975, u), pitch, lerp(-arc / 2, arc / 2, u), 40)
  }
}

/** Ease into a near-freeze before Lightning lands, then release the explosion. */
function comboSpeed(vt: number): number {
  if (vt < 0.65) return 1
  if (vt < 0.95) return lerp(1, 0.015, ease5((vt - 0.65) / 0.3))
  if (vt < 1.65) return 0.015
  if (vt < 1.95) return lerp(0.015, 1, ease5((vt - 1.65) / 0.3))
  return 1
}

export const TEASER30_SHOTS: ShotSpec[] = [
  {
    id: 's30_arena', dur: 3.6, players: [HERO, ...DUMMIES.slice(0, 3)],
    layer: 15, theme: 1,
    setup(s) {
      s.put(0, -500, 180, 0)
      s.put(1, 450, 150, Math.PI)
      s.put(2, -120, 680, -Math.PI / 2)
      s.put(3, 200, -400, Math.PI / 2)
    },
    script: [[0.1, s => { s.move(0, -270, 250); s.move(1, 240, 250); s.move(2, -80, 470); s.move(3, 100, -160) }]],
    camera(c) {
      const u = ease5(c.vt / c.dur)
      return orbit(0, 100, FLOOR, lerp(3400, 2900, u), lerp(62, 56, u), -4, 42)
    },
    overlay: clean,
  },
  {
    id: 's30_fireball', dur: 3.6, hit: 1.3,
    players: [HERO, DUMMIES[0]], layer: 15, theme: 1, level: 5,
    setup(s) {
      s.put(0, -420, Y, 0); s.put(1, 400, Y, Math.PI)
      s.hp(1, 240); s.pawn(1).kbPoints = 170
    },
    script: [[0.35, s => s.castAt(0, 'fireball', 1)]],
    camera: composed(450, Y, 1950, 48), overlay: clean,
  },
  {
    id: 's30_combo', dur: 5.3, hit: 2.05,
    players: [HERO, DUMMIES[0], DUMMIES[2]], layer: 15, theme: 1, level: 5,
    setup(s) {
      s.put(0, -420, Y, 0); s.put(1, 270, Y + 85, Math.PI); s.put(2, 290, Y - 85, Math.PI)
      s.hp(1, 340); s.hp(2, 340)
      s.pawn(1).kbPoints = 45; s.pawn(2).kbPoints = 45
    },
    script: [[0.2, s => s.cast(0, 'fireball', 400, Y)], [0.74, s => s.cast(0, 'lightning', 400, Y)]],
    speedV: comboSpeed,
    camera: composed(190, Y, 1850, 50, 16), overlay: clean,
  },
  {
    id: 's30_grip', dur: 3.6, hit: 2.1,
    players: [HERO, DUMMIES[3]], layer: 15, theme: 2, level: 5,
    setup(s) {
      s.put(0, -400, Y - 60, 0); s.put(1, 220, Y - 200, Math.PI / 2)
      s.hp(1, 350); s.pawn(1).kbPoints = 80
    },
    script: [
      [0.05, s => s.move(1, 260, Y + 400)],
      [0.25, s => s.cast(0, 'grip', 240, Y + 60)],
      [1.25, s => s.castAt(0, 'fireball', 1)],
    ],
    camera: composed(-20, Y, 1400, 48), overlay: clean,
  },
  {
    id: 's30_snowball', dur: 3.6, hit: 2.07,
    players: [HERO, DUMMIES[1]], layer: 15, theme: 1, level: 5,
    setup(s) {
      s.put(0, -360, Y, 0); s.put(1, -80, Y + 15, Math.PI)
      s.hp(1, 400); s.pawn(1).kbPoints = 100
    },
    script: [[0.3, s => s.castAt(0, 'snowball', 1)]],
    camera: composed(70, Y, 1480, 46), overlay: clean,
  },
  {
    id: 's30_scourge', dur: 3.6, hit: 1.35,
    players: [HERO, ...DUMMIES.slice(0, 3)], layer: 15, theme: 1, level: 1,
    setup(s) {
      s.put(0, 0, Y, 0)
      for (let i = 1; i <= 3; i++) {
        const a = (i - 1) * 1.05 + 0.28
        s.put(i, Math.cos(a) * 180, Y + Math.sin(a) * 180)
        s.face(i, 0, Y); s.hp(i, 360)
      }
    },
    script: [[0.4, s => s.cast(0, 'scourge', 0, Y)]],
    camera: composed(0, Y + 300, 2300, 64, 3), overlay: clean,
  },
  {
    id: 's30_battle', ...trailerMatch('ffa8').spec,
    seed: 2, ffwd: 18, dur: 3.6, hit: 1.8,
    camera: composed(0, 0, 2800, 64, 2), overlay: clean,
  },
]
