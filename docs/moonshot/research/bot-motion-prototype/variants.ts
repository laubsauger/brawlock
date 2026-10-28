import type { BotParams } from '../../../../src/bots'
import type { BotDifficulty } from '../../../../src/sim/types'

const top = (d: BotDifficulty) => d === 'hard' || d === 'brutal' || d === 'uber'
const think = (s: number) => (d: BotDifficulty): Partial<BotParams> | undefined => (top(d) ? { thinkInterval: s } : undefined)

export const VARIANTS: Record<string, { over?: (d: BotDifficulty) => Partial<BotParams> | undefined; ctor?: any }> = {
  base: {},
  think02: { over: think(0.2) },
  think035: { over: think(0.35) },
  think05: { over: think(0.5) },
}

import { BotController as Motor } from './controller-motor'
const FULL = { commit: 0.8, stayStop: true, deadBand: 0.35, deadBandDist: 100, deadBandFar: 400, dodgeMode: 'settle', dodgeExit: 1.6, dodgeHold: 0.5, standoffStep: 0.15, standoffEvery: [1, 2], ffaKeep: 0.1 }
const motor = (m: Record<string, unknown>, tiers = ['hard', 'brutal', 'uber']) => ({
  ctor: Motor,
  over: (d: BotDifficulty) => (tiers.includes(d) ? ({ motor: m } as unknown as Partial<BotParams>) : undefined),
})
const without = (k: string) => { const m: Record<string, unknown> = { ...FULL }; delete m[k]; return m }
Object.assign(VARIANTS, {
  motorCopy: motor({}),
  full: motor(FULL),
  fullMed: motor(FULL, ['medium', 'hard', 'brutal', 'uber']),
  stayOnly: motor({ stayStop: true }),
  stayCommit: motor({ stayStop: true, commit: 0.8 }),
  deadOnly: motor({ deadBand: 0.35, deadBandDist: 100, deadBandFar: 400 }),
  noCommit: motor(without('commit')),
  noSettle: motor(without('dodgeMode')),
  hyst: motor({ ...FULL, dodgeMode: 'hyst' }),
  noDrift: motor(without('standoffStep')),
  noKeep: motor(without('ffaKeep')),
  commit05: motor({ ...FULL, commit: 0.5 }),
  commit12: motor({ ...FULL, commit: 1.2 }),
})
const NOISE = { thinkSigma: 0.6, delaySigma: 0.25, delayFloor: 0.1 }
Object.assign(VARIANTS, {
  noise: motor(NOISE),
  noiseAll: motor(NOISE, ['medium', 'hard', 'brutal', 'uber']),
  fullNoise: motor({ ...FULL, ...NOISE }),
  noDead: motor({ ...without('deadBand') }),
  noDeadNoise: motor({ ...without('deadBand'), ...NOISE }),
  narrowNoise: motor({ ...FULL, ...NOISE, deadBand: 0.12, deadBandDist: 40, deadBandFar: 800 }),
})
Object.assign(VARIANTS, {
  reclick: motor({ ...FULL, ...NOISE, reclick: 0.25 }),
  reclick18: motor({ ...FULL, ...NOISE, reclick: 0.18 }),
  reclickBudget: motor({ ...FULL, ...NOISE, reclick: 0.18, budget: 6, burst: 3 }),
  noise8: motor({ ...FULL, thinkSigma: 0.8, delaySigma: 0.25, delayFloor: 0.1, reclick: 0.18, budget: 6, burst: 3 }),
})
const REC = { ...FULL, ...NOISE, reclick: 0.18, budget: 6, burst: 3 }
Object.assign(VARIANTS, {
  dA: motor({ ...REC, dodgeHold: 0.8, dodgeExit: 1.2 }),
  dB: motor({ ...REC, dodgeRepick: true }),
  dC: motor({ ...REC, dodgeHeading: true }),
  dABC: motor({ ...REC, dodgeHold: 0.8, dodgeExit: 1.2, dodgeRepick: true, dodgeHeading: true }),
  dBC: motor({ ...REC, dodgeRepick: true, dodgeHeading: true }),
})
Object.assign(VARIANTS, { rec: motor(REC) })
Object.assign(VARIANTS, { recAll: motor(REC, ['easy', 'medium', 'hard', 'brutal', 'uber']) })
Object.assign(VARIANTS, {
  thinkN: motor({ thinkSigma: 0.6 }),
  thinkN4: motor({ thinkSigma: 0.4 }),
  phaseOnly: motor({ thinkSigma: 0.0001 }),
  delayN: motor({ delaySigma: 0.25, delayFloor: 0.1 }),
  recFast: motor(REC, ['hard', 'brutal', 'uber']),
})
const REC4 = { ...REC, thinkSigma: 0.4 }
Object.assign(VARIANTS, {
  rec4: motor(REC4),
  rec4All: motor(REC4, ['easy', 'medium', 'hard', 'brutal', 'uber']),
  rec4d15: motor({ ...REC4, delaySigma: 0.15 }),
})
Object.assign(VARIANTS, {
  fullRB: motor({ ...FULL, reclick: 0.18, budget: 6, burst: 3 }),
  fullR: motor({ ...FULL, reclick: 0.18 }),
  fullN4: motor({ ...FULL, thinkSigma: 0.4 }),
  fullN4D: motor({ ...FULL, thinkSigma: 0.4, delaySigma: 0.25, delayFloor: 0.1 }),
})
Object.assign(VARIANTS, {
  rec4r12: motor({ ...REC4, reclick: 0.12 }, ['easy', 'medium', 'hard', 'brutal', 'uber']),
})
Object.assign(VARIANTS, {
  final: motor({ ...REC4, reclick: 0.12, minGap: 0.07 }, ['easy', 'medium', 'hard', 'brutal', 'uber']),
})
