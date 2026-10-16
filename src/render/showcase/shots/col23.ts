/** Column 2 (Transport) and column 3 (Damage). */
import type { ShotSpec } from '../types'
import { DUMMIES, HERO, chapter, spellLower, stage } from './common'
import { LAYER } from './kit'

const Y = 1060

export const COL2_SHOTS: ShotSpec[] = [
  {
    id: 'c2_teleport',
    dur: 3.4,
    players: [HERO, DUMMIES[0]],
    layer: LAYER,
    theme: 0,
    setup(s) {
      s.put(0, -300, Y, 0)
      s.put(1, 380, Y, Math.PI)
      s.hp(1, 40)
    },
    script: [
      [0.15, (s) => s.castAt(1, 'fireball', 0)],
      [0.72, (s) => s.cast(0, 'teleport', -80, Y + 380)],
      [1.25, (s) => s.castAt(0, 'fireball', 1)],
    ],
    camera: stage({ pitch: 44, yaw: 0, push: 0.06 }),
    overlay: { card: chapter(1), lower: spellLower('Teleport', 'teleport', 1, 'Blink out of the line of fire, then answer.', 1.3), plates: false, nums: false },
  },
  {
    id: 'c2_thrust',
    dur: 3.0,
    players: [HERO, DUMMIES[1]],
    layer: LAYER,
    theme: 0,
    setup(s) {
      s.put(0, -420, Y, 0)
      s.put(1, 260, Y + 20, Math.PI)
      s.hp(1, 30)
    },
    script: [[0.45, (s) => s.castAt(0, 'thrust', 1)]],
    camera: stage({ pitch: 40, yaw: 12, push: 0.08, margin: 0.85 }),
    overlay: { lower: spellLower('Thrust', 'thrust', 1, 'Dash and slam. The faster you arrive, the harder it lands.'), plates: false, nums: false },
  },
  {
    id: 'c2_swap',
    dur: 3.6,
    players: [HERO, DUMMIES[2]],
    layer: LAYER,
    theme: 0,
    setup(s) {
      // the hero has been knocked into the lava past the east edge (~1630)
      s.put(0, 1780, 90, Math.PI)
      s.put(1, 1300, 40, 0)
      s.hp(1, 55)
    },
    script: [[0.4, (s) => s.castAt(0, 'swap', 1)]],
    camera: stage({ pitch: 38, yawAbs: -72, push: 0.08, margin: 0.85 }),
    overlay: { lower: spellLower('Swap', 'swap', 1, 'Knocked into the lava? Trade places and leave them in it.'), plates: false, nums: false },
  },
]

export const COL3_SHOTS: ShotSpec[] = [
  {
    id: 'c3_cluster',
    dur: 3.0,
    players: [HERO, DUMMIES[0], DUMMIES[3]],
    layer: LAYER,
    theme: 2,
    setup(s) {
      s.put(0, -350, Y, 0)
      s.put(1, 240, Y - 60, Math.PI)
      s.put(2, 270, Y + 80, Math.PI)
      s.hp(1, 25)
      s.hp(2, 25)
    },
    script: [[0.3, (s) => s.cast(0, 'cluster', 255, Y)]],
    camera: stage({ pitch: 46, yaw: 6, push: 0.07 }),
    overlay: { card: chapter(2), lower: spellLower('Cluster', 'cluster', 2, 'Four small fireballs in a fan. More chances to land.', 1.3), plates: false, nums: false },
  },
  {
    id: 'c3_drain',
    dur: 3.8,
    players: [HERO, DUMMIES[2]],
    layer: LAYER,
    theme: 2,
    setup(s) {
      s.put(0, -400, Y - 40, 0)
      s.put(1, 230, Y + 110, Math.PI)
      s.hp(1, 30)
      s.hp(0, 700)
    },
    script: [[0.3, (s) => s.castAt(0, 'drain', 1)]],
    camera: stage({ pitch: 46, yaw: 8, push: 0.07 }),
    overlay: { lower: spellLower('Drain', 'drain', 2, 'Saps the enemy and sends the life back to you.'), plates: false, nums: false },
  },
  {
    id: 'c3_bouncer',
    dur: 3.8,
    players: [HERO, DUMMIES[0], DUMMIES[1], DUMMIES[3]],
    layer: LAYER,
    theme: 2,
    level: 6,
    setup(s) {
      s.put(0, -420, Y, 0)
      s.put(1, 80, Y - 30, Math.PI)
      s.put(2, 360, Y + 230, Math.PI)
      s.put(3, 400, Y - 250, Math.PI)
      s.hp(3, 20)
    },
    script: [[0.3, (s) => s.castAt(0, 'bouncer', 1)]],
    camera: stage({ pitch: 52, yaw: 0, push: 0.06 }),
    overlay: { lower: spellLower('Bouncer', 'bouncer', 2, 'Ricochets from warlock to warlock.'), plates: false, nums: false },
  },
  {
    id: 'c3_recharge',
    dur: 3.3,
    players: [HERO, DUMMIES[1], DUMMIES[4]],
    layer: LAYER,
    theme: 2,
    setup(s) {
      s.put(0, -380, Y, 0)
      s.put(1, 230, Y + 110, Math.PI)
      s.put(2, 260, Y - 120, Math.PI)
      s.hp(2, 70)
    },
    script: [
      [0.2, (s) => s.castAt(0, 'recharge', 1)],
      [1.15, (s) => s.castAt(0, 'recharge', 2)],
    ],
    camera: stage({ pitch: 46, yaw: 0, push: 0.06 }),
    overlay: { lower: spellLower('Recharge', 'recharge', 2, 'Every hit in a row hits harder. The orb brings the cooldown back.'), plates: false, nums: false },
  },
]
