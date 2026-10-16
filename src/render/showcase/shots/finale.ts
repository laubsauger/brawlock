/** Finale: eight Brutal bots, free for all, until one is left; then the end card. */
import { FLOOR, ease5, lerp, orbit } from '../cam'
import type { PlayerDef, ShotSim } from '../simShot'
import type { ShotSpec } from '../types'
import { COLORS, slowmo, stage } from './common'

export const FINALE_PLAYERS: PlayerDef[] = [
  { name: 'Ashcaller', color: COLORS.ember, bot: 'brutal' },
  { name: 'Frostbinder', color: COLORS.azure, bot: 'brutal' },
  { name: 'Mossgrave', color: COLORS.moss, bot: 'brutal' },
  { name: 'Hexweaver', color: COLORS.violet, bot: 'brutal' },
  { name: 'Emberwake', color: COLORS.gold, bot: 'brutal' },
  { name: 'Tidewarden', color: COLORS.teal, bot: 'brutal' },
  { name: 'Rosethorn', color: COLORS.rose, bot: 'brutal' },
  { name: 'Starveil', color: COLORS.ice, bot: 'brutal' },
]

/** one spell per shop column the bots know how to use, varied per player */
export const FINALE_KITS: Record<number, string[]> = {
  0: ['fireball', 'lightning', 'teleport', 'cluster', 'meteor', 'link'],
  1: ['fireball', 'boomerang', 'thrust', 'drain', 'snowball', 'gravity'],
  2: ['fireball', 'homing', 'swap', 'bouncer', 'splitter', 'grip'],
  3: ['fireball', 'twin', 'teleport', 'recharge', 'meteor', 'magnetize'],
  4: ['fireball', 'lightning', 'thrust', 'cluster', 'snowball', 'rockpillar'],
  5: ['fireball', 'boomerang', 'swap', 'drain', 'splitter', 'warpzone'],
  6: ['fireball', 'homing', 'teleport', 'bouncer', 'meteor', 'link'],
  7: ['fireball', 'twin', 'thrust', 'recharge', 'snowball', 'gravity'],
}

/** shrink period for the finale (the stock 10 s would make an 8-way FFA last minutes) */
const SHRINK_EVERY = 4

/** the match every finale shot fast-forwards into (seed from scripts/showcase/scan_ffa.ts) */
export const FINALE_BASE = {
  players: FINALE_PLAYERS,
  seed: 20,
  layer: 15,
  theme: 0,
  level: 4,
  shrink: true,
  bystander: false,
  kits: FINALE_KITS,
  tick(s: ShotSim): void {
    const a = s.state.arena
    if (a.nextShrinkTick >= 0 && a.nextShrinkTick - s.state.tick > SHRINK_EVERY * 60) a.nextShrinkTick = s.state.tick + SHRINK_EVERY * 60
    // hold the victory moment (no new round)
    if (s.state.phase === 'roundEnd') s.state.phaseTicksLeft = 600
  },
}

const FINALE_KICK = '#ffc548'

export const FINALE_SHOTS: ShotSpec[] = [
  {
    // eight Brutal bots, the platform already shrinking: Scourges, Thrusts, a Splitter, the first falls
    id: 'f_wide',
    dur: 5.0,
    ...FINALE_BASE,
    ffwd: 38.0,
    camera: stage({ pitch: 52, yawAbs: 10, push: 0.06, dolly: 6, backdrop: 0, minPx: 84 }),
    overlay: { plates: true, nums: false, lower: { name: 'Eight warlocks', color: '#ffe2b8', kicker: 'Free for all · Brutal bots', kickerColor: FINALE_KICK, line: 'One shrinking arena. The last warlock standing wins.', at: 0.3, until: 4.7 } },
  },
  {
    // four go down inside a second
    id: 'f_mid',
    dur: 4.4,
    ...FINALE_BASE,
    ffwd: 43.3,
    camera: stage({ pitch: 48, yawAbs: -25, push: 0.06, backdrop: 0 }),
    overlay: { plates: true, nums: false },
  },
  {
    // the last two: a Link pulls the survivor back in, Lightning throws him out for good
    id: 'f_last',
    dur: 6.4,
    ...FINALE_BASE,
    ffwd: 47.6,
    speed: slowmo(1.95, 2.35, 0.3, 0.08),
    camera: stage({ pitch: 40, yawAbs: 20, push: 0.1, backdrop: 0 }),
    overlay: { plates: true, nums: false, lower: { name: 'Last one standing', color: '#ffe2b8', kicker: 'Round won', kickerColor: FINALE_KICK, line: 'Ashcaller takes the round.', at: 3.5, until: 6.2 } },
  },
]

export const END_SHOTS: ShotSpec[] = [
  {
    id: 'end',
    dur: 6,
    players: [{ name: 'Ashcaller', color: COLORS.ember }],
    layer: 18,
    theme: 1,
    camera(c) {
      const t = ease5(c.vt / 6)
      return orbit(0, 0, FLOOR + 60, lerp(2100, 2500, t), lerp(36, 40, t), lerp(150, 172, t), 40)
    },
    overlay: { logo: false, plates: false, nums: false, end: { at: 0.4 }, fadeOut: 0.8 },
  },
]
