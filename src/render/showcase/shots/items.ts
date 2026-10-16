/** Active items (Redirector, Pact) and the mechanics beats (shrink, pillars, shop, power tiers). */
import { FLOOR, ease5, lerp, orbit } from '../cam'
import type { ShotSpec } from '../types'
import { COLORS, DUMMIES, HERO, slowmo, spellLower, stage } from './common'
import { LAYER } from './kit'

const Y = 1060
const ARENA_KICK = '#ffb36b'

export const ITEM_SHOTS: ShotSpec[] = [
  {
    id: 'it_redirector',
    dur: 3.4,
    players: [HERO, DUMMIES[1]],
    layer: LAYER,
    theme: 0,
    setup(s) {
      s.put(0, -420, Y - 40, 0)
      s.put(1, 260, Y + 200, Math.PI)
      s.hp(1, 30)
    },
    script: [
      // a miss, wide of the target...
      [0.2, (s) => s.cast(0, 'fireball', 300, Y - 340)],
      // ...re-aimed mid-flight
      [0.72, (s) => s.castAt(0, 'redirector', 1)],
    ],
    camera: stage({ pitch: 46, yaw: 6, push: 0.07 }),
    overlay: { lower: spellLower('Redirector', 'redirector', 'item', 'Missed? Re-aim your spell mid-flight.'), plates: false, nums: false },
  },
  {
    id: 'it_pact',
    dur: 3.8,
    players: [HERO, DUMMIES[0]],
    layer: LAYER,
    theme: 0,
    level: 5,
    setup(s) {
      // near the east rim: the empowered hit throws the target into the lava
      s.put(0, 900, 60, 0)
      s.put(1, 1400, 40, Math.PI)
      s.hp(1, 150)
    },
    script: [
      [0.2, (s) => s.cast(0, 'pact', 1400, 40)],
      [0.75, (s) => s.castAt(0, 'fireball', 1)],
    ],
    camera: stage({ pitch: 40, yaw: 10, push: 0.08 }),
    overlay: { lower: spellLower('Pact', 'pact', 'item', 'Your next spell hits half again as hard. Then you pay for it.'), plates: false, nums: false },
  },
]

export const MECH_SHOTS: ShotSpec[] = [
  {
    id: 'm_shrink',
    dur: 4.4,
    players: [HERO, DUMMIES[0], DUMMIES[2]],
    layer: 15,
    theme: 1,
    setup(s) {
      s.put(0, 700, 300, 0)
      // on the outer ring: it sinks under them
      s.put(1, 1300, 140, Math.PI)
      s.put(2, 1080, -560, Math.PI)
      s.hp(1, 60)
      // the next shrink lands 1.4 s in (the ring pulses red for the last second)
      s.state.arena.nextShrinkTick = s.state.tick + 84
    },
    script: [[0.1, (s) => s.move(1, 1250, 300)]],
    camera: stage({ pitch: 52, yawAbs: -20, push: 0.06, include: [{ x: 1400, y: -700 }, { x: 1400, y: 600 }, { x: 600, y: 0 }], margin: 0.95 }),
    overlay: { lower: { name: 'The shrink', color: '#ff7a4a', kicker: 'Arena', kickerColor: ARENA_KICK, line: 'Every 10 seconds the outer ring sinks into the lava.' }, plates: false, nums: false },
  },
  {
    id: 'm_pillar',
    dur: 3.8,
    players: [HERO, DUMMIES[1]],
    layer: LAYER,
    theme: 0,
    setup(s) {
      s.put(0, -420, Y, 0)
      s.put(1, 260, Y + 150, Math.PI)
      s.addObstacle(140, Y + 20, 60, 1, 150)
    },
    script: [
      [0.2, (s) => s.cast(0, 'fireball', 140, Y + 20)],
      [1.2, (s) => s.cast(0, 'fireball', 140, Y + 20)],
      [1.75, (s) => s.hp(1, 2)],
    ],
    camera: stage({ pitch: 40, yaw: 12, push: 0.08, margin: 0.85 }),
    overlay: { lower: { name: 'Pillars', color: '#d9c2a0', kicker: 'Arena', kickerColor: ARENA_KICK, line: 'They block shots, crack, and explode when they break.' }, plates: false, nums: false },
  },
  {
    id: 'm_shop',
    dur: 4.4,
    players: [HERO, DUMMIES[0], DUMMIES[2]],
    layer: 16,
    theme: 2,
    shop: true,
    setup(s) {
      s.put(0, 0, 200, -Math.PI / 2)
      s.put(1, -330, 330, -Math.PI / 2)
      s.put(2, 330, 330, -Math.PI / 2)
    },
    script: [
      [0.5, (s) => s.cmd(0, { kind: 'buyItem', item: 'fireball' })],
      [1.15, (s) => s.cmd(0, { kind: 'buyItem', item: 'fireball' })],
      [1.8, (s) => s.cmd(0, { kind: 'buySpell', spell: 'meteor' })],
      [2.45, (s) => s.cmd(0, { kind: 'buySpell', spell: 'meteor' })],
      [3.1, (s) => s.cmd(0, { kind: 'buyMastery', mastery: 'all' })],
      [0.8, (s) => s.cmd(1, { kind: 'buySpell', spell: 'lightning' })],
      [2.0, (s) => s.cmd(2, { kind: 'buySpell', spell: 'gravity' })],
    ],
    camera(c) {
      const t = ease5(c.vt / 4.4)
      return orbit(0, 260, FLOOR + 80, lerp(1080, 960, t), lerp(28, 25, t), lerp(-8, 8, t), 38)
    },
    overlay: { lower: { name: 'Shop phase', color: '#ffd27a', kicker: 'Between rounds', kickerColor: ARENA_KICK, line: 'Buy, upgrade, power up. Your warlock wears its build.' }, plates: false, nums: false },
  },
  {
    id: 'm_tiers',
    dur: 3.8,
    players: [
      { name: 'Fireball · Level 1', color: COLORS.ember },
      { name: 'Fireball · Level 7', color: COLORS.ember },
      DUMMIES[0],
      DUMMIES[1],
    ],
    layer: LAYER,
    theme: 1,
    setup(s) {
      s.put(0, -460, Y + 190, 0)
      s.put(1, -460, Y - 190, 0)
      s.put(2, 300, Y + 190, Math.PI)
      s.put(3, 300, Y - 190, Math.PI)
      s.grant(0, 'fireball', 1)
      s.grant(1, 'fireball', 7)
    },
    script: [
      [0.3, (s) => {
        s.face(0, 300, Y + 190)
        s.face(1, 300, Y - 190)
        s.cast(0, 'fireball', 300, Y + 190, 1)
        s.cast(1, 'fireball', 300, Y - 190, 7)
      }],
    ],
    speed: slowmo(0.95, 1.25, 0.4, 0.06),
    camera: stage({ pitch: 44, yaw: 0, from: 1, to: 3, push: 0.07 }),
    overlay: { lower: { name: 'Power tiers', color: '#ffb36b', kicker: 'Progression', kickerColor: ARENA_KICK, line: 'Fireball at level 1 and level 7: more fire, more push.' }, plates: true, nums: true },
  },
  {
    // escalation: Scourge level 1 (tame) next to level 3 (full blast)
    id: 'm_tiers_scourge',
    dur: 3.6,
    players: [
      { name: 'Scourge · Level 1', color: COLORS.ember },
      { name: 'Scourge · Level 3', color: COLORS.ember },
      DUMMIES[0],
      DUMMIES[1],
      DUMMIES[2],
      DUMMIES[3],
    ],
    layer: LAYER,
    theme: 1,
    setup(s) {
      s.put(0, -320, 0, -Math.PI / 2)
      s.put(1, 320, 0, -Math.PI / 2)
      s.put(2, -320, 150, -Math.PI / 2)
      s.put(3, -320, -150, Math.PI / 2)
      s.put(4, 320, 150, -Math.PI / 2)
      s.put(5, 320, -150, Math.PI / 2)
      s.grant(0, 'scourge', 1)
      s.grant(1, 'scourge', 3)
    },
    script: [
      [0.25, (s) => {
        s.cast(0, 'scourge', -320, 0, 1)
        s.cast(1, 'scourge', 320, 0, 3)
      }],
    ],
    speed: slowmo(1.1, 1.4, 0.4, 0.06),
    // frame the two casters and their blast rings; the shoved dummies may slide out of frame
    camera: stage({ pitch: 44, yawAbs: 0, push: 0.07, untilSt: 1.15, include: [{ x: -580, y: 0 }, { x: 580, y: 0 }], backdrop: 0 }),
    overlay: { lower: { name: 'Power tiers', color: '#ffb36b', kicker: 'Progression', kickerColor: ARENA_KICK, line: 'Scourge at level 1 and level 3: the charge grows, the blast hits harder.' }, plates: true, nums: true },
  },
]
