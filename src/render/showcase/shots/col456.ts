/** Column 4 (Devastator), column 5 (Defense), column 6 (Control). */
import type { ShotSpec } from '../types'
import { DUMMIES, HERO, chapter, slowmo, spellLower, stage } from './common'
import { LAYER } from './kit'

const Y = 700

export const COL4_SHOTS: ShotSpec[] = [
  {
    id: 'c4_windwalk',
    dur: 3.4,
    players: [HERO, DUMMIES[0]],
    layer: LAYER,
    theme: 1,
    // the caster's own view: Windwalk ghosts the caster for its owner, hides it from everyone else
    localPlayer: 0,
    setup(s) {
      s.put(0, -300, Y - 30, 0)
      s.put(1, 260, Y + 20, Math.PI)
      s.hp(1, 30)
    },
    script: [
      [0.3, (s) => s.cast(0, 'windwalk', 0, Y)],
      [0.36, (s) => s.move(0, 330, Y + 30)],
    ],
    camera: stage({ pitch: 42, yaw: 10, push: 0.08, margin: 0.85 }),
    overlay: { card: chapter(3), lower: spellLower('Windwalk', 'windwalk', 3, 'Vanish, run, and slam the first enemy you touch.', 1.3), plates: false },
  },
  {
    id: 'c4_meteor',
    dur: 4.0,
    players: [HERO, DUMMIES[0], DUMMIES[1], DUMMIES[3]],
    layer: LAYER,
    theme: 1,
    level: 5,
    setup(s) {
      s.put(0, -520, Y - 80, 0)
      s.put(1, 250, Y + 50, Math.PI)
      s.put(2, 340, Y - 50, Math.PI)
      s.put(3, 200, Y - 100, Math.PI)
      for (let i = 1; i <= 3; i++) s.hp(i, 50)
    },
    script: [[0.25, (s) => s.cast(0, 'meteor', 265, Y - 30)]],
    speed: slowmo(1.62, 1.95, 0.3, 0.06),
    camera: stage({ pitch: 26, yaw: 18, push: 0.1, margin: 0.9 }),
    overlay: { lower: spellLower('Meteor', 'meteor', 3, 'Called down from the sky. It cannot be blocked.'), plates: false },
  },
  {
    id: 'c4_splitter',
    dur: 3.4,
    players: [HERO, DUMMIES[0], DUMMIES[2]],
    layer: LAYER,
    theme: 1,
    setup(s) {
      s.put(0, -450, Y, 0)
      s.put(1, 230, Y - 95, Math.PI)
      s.put(2, 280, Y + 100, Math.PI)
      s.hp(1, 25)
      s.hp(2, 25)
    },
    script: [[0.3, (s) => s.cast(0, 'splitter', -60, Y)]],
    camera: stage({ pitch: 50, yaw: 4, push: 0.07 }),
    overlay: { lower: spellLower('Splitter', 'splitter', 3, 'One bolt bursts into waves of smaller ones.'), plates: false },
  },
  {
    id: 'c4_snowball',
    dur: 3.8,
    players: [HERO, DUMMIES[1]],
    layer: LAYER,
    theme: 1,
    setup(s) {
      s.put(0, -360, Y, 0)
      s.put(1, 60, Y + 15, Math.PI)
      s.hp(1, 45)
    },
    script: [[0.3, (s) => s.castAt(0, 'snowball', 1)]],
    camera: stage({ pitch: 42, yaw: 10, push: 0.08 }),
    overlay: { lower: spellLower('Snowball', 'snowball', 3, 'Rolls them up, freezes them, shatters them.'), plates: false },
  },
]

export const COL5_SHOTS: ShotSpec[] = [
  {
    id: 'c5_shield',
    dur: 3.6,
    players: [HERO, DUMMIES[0]],
    layer: LAYER,
    theme: 0,
    setup(s) {
      s.put(0, -260, Y, 0)
      s.put(1, 380, Y, Math.PI)
      s.hp(1, 30)
    },
    script: [
      [0.15, (s) => s.castAt(1, 'fireball', 0)],
      [0.55, (s) => s.cast(0, 'shield', -260, Y)],
    ],
    camera: stage({ pitch: 40, yaw: 12, push: 0.08, margin: 0.85 }),
    overlay: { card: chapter(4), lower: spellLower('Shield', 'shield', 4, 'Reflect their spell. Now it is yours.', 1.3), plates: false },
  },
  {
    id: 'c5_rush',
    dur: 3.4,
    players: [HERO, DUMMIES[0], DUMMIES[2]],
    layer: LAYER,
    theme: 0,
    setup(s) {
      s.put(0, -150, Y, 0)
      s.put(1, 420, Y + 170, Math.PI)
      s.put(2, 420, Y - 170, Math.PI)
    },
    script: [
      [0.2, (s) => s.cast(0, 'rush', -150, Y)],
      [0.3, (s) => s.castAt(1, 'fireball', 0)],
      [0.45, (s) => s.castAt(2, 'fireball', 0)],
      [1.3, (s) => s.move(0, -700, Y + 120)],
    ],
    camera: stage({ pitch: 44, yaw: 0, push: 0.07 }),
    overlay: { lower: spellLower('Rush', 'rush', 4, 'Soak half the damage and turn it into speed.'), plates: false },
  },
  {
    id: 'c5_alteration',
    dur: 3.4,
    players: [HERO, DUMMIES[0], DUMMIES[3]],
    layer: LAYER,
    theme: 0,
    setup(s) {
      s.put(0, -180, Y, 0)
      s.put(1, 420, Y, Math.PI)
      s.put(2, -620, Y - 20, 0)
      s.hp(2, 30)
    },
    script: [
      [0.15, (s) => s.castAt(1, 'fireball', 0)],
      [0.4, (s) => s.cast(0, 'alteration', -180, Y)],
    ],
    camera: stage({ pitch: 42, yaw: 8, push: 0.07, margin: 0.9 }),
    overlay: { lower: spellLower('Alteration', 'alteration', 4, 'Trade places with the spell about to hit you.'), plates: false },
  },
]

export const COL6_SHOTS: ShotSpec[] = [
  {
    id: 'c6_gravity',
    dur: 4.2,
    players: [HERO, DUMMIES[0], DUMMIES[2]],
    layer: LAYER,
    theme: 2,
    level: 5,
    setup(s) {
      s.put(0, -480, Y, 0)
      s.put(1, 160, Y + 280, -Math.PI / 2)
      s.put(2, 230, Y - 250, Math.PI / 2)
      s.hp(1, 14)
      s.hp(2, 14)
    },
    script: [[0.2, (s) => s.cast(0, 'gravity', 220, Y)]],
    speed: slowmo(1.75, 2.15, 0.35, 0.08),
    camera: stage({ pitch: 46, yaw: 0, push: 0.08 }),
    overlay: { card: chapter(5), lower: spellLower('Gravity', 'gravity', 5, 'Pulls warlocks and spells into the dark.', 1.3), plates: false },
  },
  {
    id: 'c6_grip',
    dur: 3.6,
    players: [HERO, DUMMIES[3]],
    layer: LAYER,
    theme: 2,
    setup(s) {
      s.put(0, -400, Y - 60, 0)
      s.put(1, 220, Y - 200, Math.PI / 2)
      s.hp(1, 30)
    },
    script: [
      [0.05, (s) => s.move(1, 260, Y + 500)],
      [0.25, (s) => s.cast(0, 'grip', 240, Y + 60)],
      [1.25, (s) => s.castAt(0, 'fireball', 1)],
    ],
    camera: stage({ pitch: 46, yaw: 6, push: 0.07 }),
    overlay: { lower: spellLower('Grip', 'grip', 5, 'Root them in place, then line up the shot.'), plates: false },
  },
  {
    id: 'c6_warpzone',
    dur: 3.6,
    players: [HERO, DUMMIES[0]],
    layer: LAYER,
    theme: 2,
    setup(s) {
      s.put(0, -320, Y, 0)
      s.put(1, 440, Y, Math.PI)
    },
    script: [
      [0.1, (s) => s.cast(0, 'warpzone', 60, Y)],
      [0.3, (s) => s.castAt(1, 'fireball', 0)],
      [1.0, (s) => s.move(0, -360, Y + 300)],
    ],
    camera: stage({ pitch: 44, yaw: 6, push: 0.07, untilSt: 3.0 }),
    overlay: { lower: spellLower('Warpzone', 'warpzone', 5, 'Enemy spells crawl through the zone.'), plates: false },
  },
  {
    id: 'c6_magnetize',
    dur: 3.6,
    players: [HERO, DUMMIES[2]],
    layer: LAYER,
    theme: 2,
    setup(s) {
      s.put(0, -420, Y - 60, 0)
      s.put(1, 260, Y + 120, Math.PI)
      s.hp(1, 30)
    },
    script: [
      [0.15, (s) => s.castAt(0, 'magnetize', 1)],
      // aimed well wide of the target: the mark bends it in
      [1.2, (s) => s.cast(0, 'fireball', 300, Y + 40)],
    ],
    camera: stage({ pitch: 48, yaw: 4, push: 0.07 }),
    overlay: { lower: spellLower('Magnetize', 'magnetize', 5, 'Mark a warlock and your shots bend into them.'), plates: false },
  },
  {
    id: 'c6_rockpillar',
    dur: 3.6,
    players: [HERO, DUMMIES[1]],
    layer: LAYER,
    theme: 2,
    setup(s) {
      s.put(0, -420, Y, 0)
      s.put(1, 230, Y + 170, Math.PI)
      s.hp(1, 4)
    },
    script: [
      [0.2, (s) => s.cast(0, 'rockpillar', 180, Y + 20)],
      // a cracked pillar: one Fireball breaks it
      [0.7, (s) => s.state.obstacles.filter((o) => o.owner === 0).forEach((o) => (o.hp = 60))],
      [1.0, (s) => s.cast(0, 'fireball', 180, Y + 20)],
      [1.55, (s) => s.hp(1, 2)],
    ],
    camera: stage({ pitch: 40, yaw: 10, push: 0.08, margin: 0.85 }),
    overlay: { lower: spellLower('Rockpillar', 'rockpillar', 5, 'Raise a wall of stone. Break it and it explodes.'), plates: false },
  },
  {
    id: 'c6_link',
    dur: 5.0,
    players: [HERO, DUMMIES[0]],
    layer: LAYER,
    theme: 2,
    setup(s) {
      // hero on the east rim (edge ~1630), victim out on the platform
      s.put(0, 1540, 60, Math.PI)
      s.put(1, 700, -40, 0)
      s.hp(1, 120)
    },
    script: [
      [0.2, (s) => s.castAt(0, 'link', 1)],
      // step aside as the pull builds: the victim slingshots past into the lava
      [1.1, (s) => s.move(0, 1540, 360)],
    ],
    speed: slowmo(2.55, 2.95, 0.35, 0.08),
    camera: stage({ pitch: 40, yaw: 12, push: 0.08 }),
    overlay: { lower: spellLower('Link', 'link', 5, 'Drag them in. Step aside, and let them fly past into the lava.'), plates: false },
  },
]
