/** Starting kit (Fireball, Scourge) and column 1: Knockout. */
import type { ShotSpec } from '../types'
import { DUMMIES, HERO, chapter, slowmo, spellLower, stage } from './common'

export const LAYER = 18
/** shot staging row: action happens around this y so the lava rim backs the frame */
const Y = 1060

export const KIT_SHOTS: ShotSpec[] = [
  {
    id: 'kit_fireball',
    dur: 3.0,
    players: [HERO, DUMMIES[0]],
    layer: LAYER,
    theme: 1,
    level: 5,
    setup(s) {
      s.put(0, -430, Y - 40, 0)
      s.put(1, 320, Y + 40, Math.PI)
      s.hp(1, 40)
    },
    script: [[0.3, (s) => s.castAt(0, 'fireball', 1)]],
    camera: stage({ pitch: 40, yaw: 10, push: 0.08 }),
    overlay: { lower: spellLower('Fireball', 'fireball', 'kit', 'Straight, fast, reliable. Big knockback.'), plates: false, nums: false },
  },
  {
    id: 'kit_scourge',
    dur: 3.6,
    players: [HERO, DUMMIES[0], DUMMIES[1], DUMMIES[2]],
    layer: LAYER,
    theme: 1,
    // starting kit: Scourge as every warlock first has it, level 1
    level: 1,
    setup(s) {
      s.put(0, 0, Y, -0.5)
      const r = 165
      for (let i = 1; i <= 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.6
        s.put(i, Math.cos(a) * r, Y + Math.sin(a) * r)
        s.face(i, 0, Y)
        s.hp(i, 60)
      }
    },
    script: [[0.2, (s) => s.cast(0, 'scourge', 0, Y, 1)]],
    speed: slowmo(1.12, 1.42, 0.3, 0.06),
    camera: stage({ pitch: 36, yawAbs: -18, push: 0.12, dolly: 10, margin: 0.8 }),
    overlay: { lower: spellLower('Scourge', 'scourge', 'kit', 'Charge it, then blast everyone around you. Costs you 100 HP.'), plates: false, nums: false },
  },
]

export const COL1_SHOTS: ShotSpec[] = [
  {
    id: 'c1_boomerang',
    dur: 3.8,
    players: [HERO, DUMMIES[0]],
    layer: LAYER,
    theme: 1,
    setup(s) {
      s.put(0, -420, Y - 40, 0)
      s.put(1, 300, Y, Math.PI)
      s.hp(1, 40)
    },
    script: [[0.25, (s) => s.castAt(0, 'boomerang', 1)]],
    camera: stage({ pitch: 54, yaw: 0, push: 0.06 }),
    overlay: { card: chapter(0), lower: spellLower('Boomerang', 'boomerang', 0, 'Arcs out, cuts through, and comes back to you.', 1.3), plates: false, nums: false },
  },
  {
    id: 'c1_lightning',
    dur: 2.8,
    players: [HERO, DUMMIES[1]],
    layer: LAYER,
    theme: 1,
    setup(s) {
      s.put(0, -260, Y, 0)
      s.put(1, 290, Y + 30, Math.PI)
      s.hp(1, 40)
    },
    script: [[0.35, (s) => s.castAt(0, 'lightning', 1)]],
    camera: stage({ pitch: 38, yaw: 14, push: 0.08, margin: 0.85 }),
    overlay: { lower: spellLower('Lightning', 'lightning', 0, 'Instant. The first thing in its path takes all of it.'), plates: false, nums: false },
  },
  {
    id: 'c1_combo',
    dur: 3.6,
    players: [HERO, DUMMIES[0], DUMMIES[2]],
    layer: LAYER,
    theme: 1,
    level: 5,
    setup(s) {
      s.put(0, -420, Y, 0)
      s.put(1, 300, Y + 85, Math.PI)
      s.put(2, 320, Y - 80, Math.PI)
      s.hp(1, 3)
      s.hp(2, 3)
    },
    script: [
      [0.2, (s) => s.cast(0, 'fireball', 400, Y)],
      // the beam leaves 0.2 s after the order: the bolt is ~620 out by then, between the two
      [0.74, (s) => s.cast(0, 'lightning', 400, Y)],
    ],
    speed: slowmo(0.92, 1.2, 0.3, 0.05),
    camera: stage({ pitch: 44, yaw: 10, push: 0.07, exclude: ['lightning'] }),
    overlay: { lower: { name: 'Lightning × Fireball', spell: 'lightning', kicker: 'Combo', kickerColor: '#ff7a2a', line: 'Strike your own Fireball to detonate it mid-flight.' }, plates: false, nums: false },
  },
  {
    id: 'c1_homing',
    dur: 4.0,
    players: [HERO, DUMMIES[2]],
    layer: LAYER,
    theme: 1,
    setup(s) {
      s.put(0, -450, Y - 60, 0.4)
      s.put(1, 120, Y + 260, -Math.PI / 2)
      s.hp(1, 40)
    },
    script: [
      [0.05, (s) => s.move(1, 160, Y - 500)],
      [0.3, (s) => s.cast(0, 'homing', 120, Y + 260)],
    ],
    camera: stage({ pitch: 56, yaw: 0, push: 0.05, minPx: 88 }),
    overlay: { lower: spellLower('Homing', 'homing', 0, 'Hunts the nearest enemy, wherever they run.'), plates: false, nums: false },
  },
  {
    id: 'c1_twin',
    dur: 3.4,
    players: [HERO, DUMMIES[3]],
    layer: LAYER,
    theme: 1,
    setup(s) {
      s.put(0, -380, Y, 0)
      s.put(1, 300, Y, Math.PI)
      s.hp(1, 40)
    },
    script: [[0.3, (s) => s.castAt(0, 'twin', 1)]],
    camera: stage({ pitch: 56, yaw: 0, push: 0.07 }),
    overlay: { lower: spellLower('Twin', 'twin', 0, 'Two bolts swing out on mirrored arcs and meet at the target.'), plates: false, nums: false },
  },
]
