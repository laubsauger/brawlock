/**
 * "The Brawl": the push loop. A scripted beat that shows knockback growing with
 * damage, then a real Brutal-bot 1v1 (seed picked by scripts/showcase/scan_duel.ts:
 * thrust and Scourge hits, Link pulls, both warlocks blown into the lava, one
 * shoved back out by his rival's Fireball, the other pushed deeper and burned).
 * Wide, steady framings; overhead plates on so the knockback meter reads.
 */
import type { LowerThird, ShotSpec } from '../types'
import { COLORS, cuts, slowmo, stage } from './common'

const KICK = '#ff7a2a'

function cap(name: string, line: string, at?: number, until?: number): LowerThird {
  return { name, color: '#ffe2b8', kicker: 'The brawl', kickerColor: KICK, line, at, until }
}

const DUEL = {
  players: [
    { name: 'Ashcaller', color: COLORS.ember, bot: 'brutal' as const },
    { name: 'Frostbinder', color: COLORS.azure, bot: 'brutal' as const },
  ],
  seed: 38,
  layer: 15,
  theme: 1,
  level: 4,
  shrink: true,
  bystander: false,
  kits: { 0: ['fireball', 'lightning', 'teleport', 'link'], 1: ['fireball', 'gravity', 'thrust', 'grip'] },
}

export const BRAWL_SHOTS: ShotSpec[] = [
  {
    // same Fireball into three different knockback meters: x1.0, x1.3, x1.6
    id: 'brawl_kb',
    dur: 5.0,
    players: [
      { name: 'Ashcaller', color: COLORS.ember },
      { name: 'Ashcaller', color: COLORS.ember },
      { name: 'Ashcaller', color: COLORS.ember },
      { name: 'Fresh', color: COLORS.azure },
      { name: 'Bruised', color: COLORS.gold },
      { name: 'Battered', color: COLORS.rose },
    ],
    layer: 18,
    theme: 1,
    level: 4,
    setup(s) {
      const lanes = [-300, 0, 300]
      for (let i = 0; i < 3; i++) {
        s.put(i, -280, lanes[i], 0)
        s.put(i + 3, 370, lanes[i], Math.PI)
        s.pawn(i + 3).kbPoints = [0, 300, 600][i]
      }
      s.hp(5, 110)
    },
    script: [
      [0.3, (s) => {
        for (let i = 0; i < 3; i++) {
          const t = s.pawn(i + 3)
          s.face(i, t.x, t.y)
          s.castAt(i, 'fireball', i + 3)
        }
      }],
    ],
    camera: stage({ pitch: 50, yaw: 0, from: 1, to: 4, push: 0.05, untilSt: 3.2 }),
    overlay: { plates: true, nums: true, lower: cap('Damage builds knockback', 'Same Fireball, three meters: the more damage taken, the farther they fly.') },
  },
  {
    id: 'brawl_a',
    dur: 4.2,
    ...DUEL,
    ffwd: 5.4,
    camera: stage({ pitch: 48, yaw: 0, push: 0.05, dolly: 4 }),
    overlay: { plates: true, nums: true, lower: cap('Hits push', 'A real match between Brutal bots. Hits shove, pulls drag.') },
  },
  {
    id: 'brawl_b',
    dur: 10.4,
    ...DUEL,
    ffwd: 17.0,
    tick(s) {
      // hold the victory moment (no new round)
      if (s.state.phase === 'roundEnd') s.state.phaseTicksLeft = 600
    },
    speed: slowmo(6.4, 6.75, 0.3, 0.08),
    camera: cuts([
      [0, stage({ pitch: 48, yaw: 0, untilSt: 3.4, push: 0.05, t0: 0, t1: 3.4 })],
      [3.4, stage({ pitch: 42, yaw: -20, fromSt: 3.3, untilSt: 6.3, push: 0.05, t0: 3.4, t1: 6.3, backdrop: 0 })],
      [6.3, stage({ pitch: 40, yaw: 10, fromSt: 6.2, push: 0.07, t0: 6.3, t1: 10.4, backdrop: 0 })],
    ]),
    overlay: {
      plates: true,
      nums: true,
      lower: [
        cap('Into the lava', 'Both blown off the edge. One gets shoved back out.', 0.3, 6.0),
        cap('Last one standing', 'One push too many. The round is his.', 6.4, 10.1),
      ],
    },
  },
]
