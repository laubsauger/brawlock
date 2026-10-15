/** Pipeline smoke test shot (not in the edit). */
import { Follow, FLOOR, orbit, track, gameplay } from '../cam'
import { COLORS } from '../simShot'
import type { ShotSpec } from '../types'

export const TEST_SHOTS: ShotSpec[] = [
  {
    id: 'test',
    dur: 3,
    players: [
      { name: 'Ashcaller', color: COLORS.ember },
      { name: 'Frostbinder', color: COLORS.azure },
    ],
    setup(s) {
      s.put(0, -450, 0, 0)
      s.put(1, 350, 0, Math.PI)
    },
    script: [
      [0.3, (s) => s.castAt(0, 'fireball', 1)],
      [0.35, (s) => s.hp(1, 20)],
    ],
    camera(c) {
      const f = (c.mem.f ??= new Follow(5)) as Follow
      const p = c.projAt('fireball') ?? c.at(0)
      f.update({ x: p.x, y: p.y, h: FLOOR }, c.dt)
      return track(
        [
          [0, gameplay(-50, 0, 1200)],
          [1.2, orbit(f.x, f.y, FLOOR + 40, 700, 28, 35, 45)],
          [3, orbit(f.x, f.y, FLOOR + 40, 650, 24, 50, 45)],
        ],
        c.vt,
      )
    },
    overlay: {
      lower: { name: 'Fireball', spell: 'fireball', kicker: 'Starting kit', line: 'Straight, fast, reliable. Every upgrade adds damage.' },
    },
  },
]
