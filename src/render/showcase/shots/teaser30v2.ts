/** Debut teaser: staged spectacle, close lenses and motivated continuous camera moves. */
import { roundWon } from '../../../sim/mode'
import { FLOOR, ease5, lerp, lerpPose, orbit, span } from '../cam'
import { COLORS } from '../simShot'
import type { ShotSpec } from '../types'
import { HERO, DUMMIES } from './common'
import { TEASER30_SHOTS } from './teaser30'
import { trailerMatch } from './trailerMatch'

const clean = { logo: false, plates: false, nums: false, stamps: false }
const cast = [HERO, ...DUMMIES, { name: 'Sunbreaker', color: COLORS.gold }, { name: 'Starveil', color: COLORS.ice }, { name: 'Rosehex', color: COLORS.rose }]
function source(id: string): ShotSpec {
  const spec = TEASER30_SHOTS.find(s => s.id === id)
  if (!spec) throw new Error(`Missing staged shot ${id}`)
  return spec
}
const base = trailerMatch('ffa8').spec
const ten = {
  ...base,
  players: [...base.players, { name: 'Sunbreaker', color: COLORS.gold, bot: 'uber' as const }, { name: 'Rosehex', color: COLORS.rose, bot: 'uber' as const }],
  kits: { ...base.kits, 8: base.kits![0], 9: base.kits![1] },
}

export const TEASER30V2_SHOTS: ShotSpec[] = [
  {
    id: 's32_lineup', dur: 3.2, players: [...cast, { name: 'Cinder', color: COLORS.amber }],
    bystander: false, layer: 15, theme: 1, renderSubsteps: 4,
    setup(s) {
      for (let i = 0; i < 10; i++) s.put(i, (i - 4.5) * 135, Math.abs(i - 4.5) * 15, -Math.PI / 2)
    },
    script: [[.4, s => {
      const spells = ['fireball', 'boomerang', 'homing', 'twin', 'cluster', 'drain', 'bouncer', 'recharge', 'snowball', 'lightning']
      spells.forEach((spell, i) => s.cast(i, spell, s.pawn(i).x, -1100))
    }]],
    speedV(vt) {
      if (vt < .35) return 1
      if (vt < .5) return lerp(1, .12, ease5(span(vt, .35, .5)))
      if (vt < 1.45) return .12
      if (vt < 1.6) return lerp(.12, 1, ease5(span(vt, 1.45, 1.6)))
      return 1
    },
    camera(c) {
      const u = ease5(c.vt / c.dur)
      return { x: lerp(-300, 80, u), y: lerp(-1150, -1300, u), h: lerp(350, 450, u), tx: 0, ty: 20, th: FLOOR + 90, fov: 43 }
    }, overlay: clean,
  },
  {
    id: 's32_arena', ...ten, seed: 2, ffwd: 8, dur: 3.2, renderSubsteps: 4,
    speedV: () => .32,
    camera(c) {
      // Reach the establishing view inside the edited 2.5-second take. Climb
      // inside the caldera before moving past its raised rim.
      const u = ease5(span(c.vt, 0, 2.35))
      const yaw = lerp(-55, 16, u) * Math.PI / 180
      const hd = lerp(950, 1850, ease5(span(c.vt, 1.9, 2.4)))
      return { x: Math.sin(yaw) * hd, y: -Math.cos(yaw) * hd, h: lerp(320, 3400, u), tx: 0, ty: 0, th: FLOOR + 50, fov: 48 }
    }, overlay: clean,
  },
  {
    id: 's32_final', dur: 3.9, hit: 1.4, players: [HERO, DUMMIES[0]], layer: 8, theme: 1, level: 5,
    setup(s) { s.put(0, -280, 220, 0); s.put(1, 220, 220, Math.PI); s.hp(1, 230); s.pawn(1).kbPoints = 60 },
    script: [
      [.05, s => s.cast(0, 'meteor', 220, 220)],
      [.12, s => s.cast(1, 'fireball', -500, 50)],
      [.65, s => s.castAt(0, 'fireball', 1)],
      [2.15, s => s.move(0, -120, 220)],
    ],
    camera(c) {
      const u = ease5(span(c.vt, 1.2, 2.1))
      return { x: lerp(200, 400, u), y: -850, h: 430, tx: lerp(120, 650, u), ty: 220, th: FLOOR + 85, fov: 47 }
    }, overlay: clean,
  },
  {
    id: 's32_winner', dur: 3.0, players: [HERO], layer: 8, theme: 1, level: 3,
    setup(s) {
      s.put(0, -280, 220, -.9)
      s.state.slots[0].cosmetics = { victory: 'victory-ascendant', head: null, back: null, robe: null, emblem: null, staff: null }
    },
    script: [
      [.03, s => s.cast(0, 'scourge', -280, 220)],
      // End the private staged round after the real Scourge release. The normal
      // roundWin renderer then plays the equipped Ascendant celebration.
      [1.08, s => s.after(() => roundWon(s.state, 0))],
    ],
    camera(c) {
      const u = ease5(span(c.vt, .7, 2.4))
      return orbit(-280, 220, FLOOR + 95, lerp(850, 330, u), lerp(23, 8, u), lerp(20, -10, u), lerp(46, 40, u))
    }, overlay: clean,
  },
  {
    id: 's32_ring', dur: 3.9, hit: 1.017, players: cast, layer: 8, theme: 1, level: 3,
    setup(s) {
      s.put(0, 0, 0, -Math.PI / 2)
      for (let i = 1; i < cast.length; i++) {
        const a = (i - 1) * Math.PI / 4
        s.put(i, Math.cos(a) * 178, Math.sin(a) * 178)
        s.face(i, 0, 0); s.hp(i, 165)
      }
    },
    script: [[0.1, s => s.cast(0, 'scourge', 0, 0)]],
    camera(c) {
      const u = ease5(span(c.vt, .1, 2.5))
      const yaw = lerp(-18, 32, u) * Math.PI / 180
      const hd = lerp(930, 1000, u)
      return { x: Math.sin(yaw) * hd, y: -Math.cos(yaw) * hd, h: lerp(500, 2400, u), tx: 0, ty: 0, th: FLOOR + 55, fov: 46 }
    }, overlay: clean,
  },
  {
    ...source('s30_fireball'), id: 's32_lava', dur: 4.6,
    camera(c) {
      const u = ease5(span(c.st, 1.1, 3.4))
      const a = orbit(0, 850, FLOOR + 65, 1320, 25, -8, 43)
      const b = orbit(1050, 850, FLOOR + 65, 1250, 34, 18, 43)
      return lerpPose(a, b, u)
    }, overlay: clean,
  },
  {
    id: 's32_matrix', dur: 4.5, hit: 3.15, renderSubsteps: 4,
    players: [HERO, DUMMIES[0]], layer: 15, theme: 1, level: 5,
    setup(s) { s.put(0, -600, 0, 0); s.put(1, 65, 0, Math.PI); s.hp(1, 260) },
    script: [[.2, s => s.castAt(0, 'fireball', 1)], [.74, s => s.castAt(0, 'lightning', 1)]],
    speedV(vt) {
      if (vt < .55) return 1
      if (vt < 1.05) return lerp(1, .035, ease5(span(vt, .55, 1.05)))
      if (vt < 2.8) return .035
      if (vt < 3.2) return lerp(.035, 1, ease5(span(vt, 2.8, 3.2)))
      return 1
    },
    camera(c) {
      const arc = ease5(span(c.vt, .4, 2.8))
      const dive = ease5(span(c.vt, 0, 1.15))
      const out = ease5(span(c.vt, 2.8, 3.9))
      const dist = lerp(lerp(1200, 610, dive), 1550, out)
      return orbit(lerp(-80, 90, dive), 0, FLOOR + 65, dist, lerp(lerp(32, 12, dive), 32, out), -32 + 360 * arc, 43)
    }, overlay: clean,
  },
  {
    id: 's32_battle', dur: 4.0, hit: 2.2, renderSubsteps: 4,
    players: [HERO, ...DUMMIES.slice(0, 4)], layer: 8, theme: 1, level: 5, floorStyle: 'classic',
    setup(s) {
      s.put(0, -420, -40, 0)
      s.put(1, -120, -40, Math.PI); s.put(2, 10, -20, Math.PI); s.put(3, 140, -30, Math.PI)
      s.put(4, -350, -350, .7)
      for (let i = 1; i <= 3; i++) { s.hp(i, 110); s.pawn(i).kbPoints = 120 }
    },
    script: [
      [.03, s => s.cast(0, 'snowball', 500, -40)],
      [.7, s => s.castAt(4, 'bouncer', 2)],
      [.03, s => s.castAt(1, 'fireball', 4)],
      [.1, s => s.castAt(2, 'cluster', 4)],
      [.12, s => s.castAt(3, 'lightning', 4)],
      [.85, s => s.cast(0, 'thrust', 500, -40)],
      [1.35, s => s.cast(0, 'bouncer', 680, 150)],
    ],
    speedV(vt) {
      if (vt < 1.75) return 1
      if (vt < 1.9) return lerp(1, .55, ease5(span(vt, 1.75, 1.9)))
      if (vt < 2.2) return .55
      if (vt < 2.35) return lerp(.55, 1, ease5(span(vt, 2.2, 2.35)))
      return 1
    },
    camera(c) {
      const u = ease5(span(c.vt, .25, 3.2))
      return { x: lerp(-250, 450, u), y: -650, h: 230, tx: lerp(-20, 460, u), ty: lerp(-10, 140, u), th: FLOOR + 80, fov: 46 }
    }, overlay: clean,
  },
  {
    id: 's32_unload', dur: 3.8, hit: 1.86,
    players: [HERO, DUMMIES[3]], layer: 15, theme: 2, level: 5,
    setup(s) { s.put(0, -360, 700, 0); s.put(1, -70, 715, Math.PI); s.hp(1, 560) },
    script: [
      [.05, s => s.castAt(0, 'grip', 1)],
      [.4, s => s.castAt(0, 'snowball', 1)],
      [1.2, s => s.castAt(0, 'fireball', 1)],
      [1.66, s => s.castAt(0, 'lightning', 1)],
    ],
    camera(c) {
      const u = ease5(c.vt / c.dur)
      return { x: lerp(-700, -420, u), y: 480, h: lerp(230, 260, u), tx: lerp(30, 580, u), ty: 735, th: FLOOR + 90, fov: 45 }
    }, overlay: clean,
  },
  {
    id: 's32_meteors', dur: 3.1, hit: 1.4, players: [HERO, ...DUMMIES.slice(0, 3)], layer: 12, theme: 1, level: 5,
    setup(s) {
      s.put(0, -550, -150, 0)
      s.put(1, 200, -90, Math.PI); s.put(2, 310, 70, Math.PI); s.put(3, 80, 180, Math.PI)
      s.hp(1, 75); s.hp(2, 140); s.hp(3, 140)
      s.addObstacle(230, 50, 55, 1, 50)
    },
    script: [
      [.05, s => s.cast(0, 'meteor', 200, 20)],
      [.15, s => s.castAt(1, 'fireball', 0)],
      [.2, s => s.castAt(2, 'snowball', 0)],
      [.05, s => s.move(3, 120, 50)],
      [.6, s => s.castAt(3, 'lightning', 0)],
    ],
    camera(c) {
      const u = ease5(c.vt / c.dur)
      const drop = ease5(span(c.vt, .55, 1.5))
      return { x: lerp(-950, -650, u), y: lerp(-600, -500, u), h: lerp(300, 420, u), tx: lerp(150, 240, u), ty: 30, th: lerp(560, 100, drop), fov: 47 }
    }, overlay: clean,
  },
]
