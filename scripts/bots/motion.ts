/**
 * How the bots move, on the shared motion meter (src/bots/motion.ts; docs/moonshot/specs/bot-motion.md).
 *   npm run bots:motion -- [--scenario ffa4|menu|duel] [--matches 8] [--seed 1] [--params file.json]
 *                          [--tiers medium,hard,brutal,uber]
 *
 * ffa4: 4-player FFA, the tiers' seats rotated every match. menu: the menu backdrop (eight bots,
 * Brutal and Uber alternating, its own settings). duel: the first two tiers 1v1, sides swapped.
 * `--params` takes the same file as bots:elo ({ "name": { "base": "hard", ...overrides } }), so a
 * candidate preset is measured under its name. Prints one line per tier, then the think timing.
 */
import { readFileSync } from 'node:fs'
import { BOT_PRESETS, type BotParams } from '../../src/bots'
import { emptyMotion, mergeMotion, meterBotMatch, sameTickRatio, summarizeMotion, type MotionCounts, type MotionSeat } from '../../src/bots/motion'
import { MENU_BATTLE_SETTINGS } from '../../src/render/menuStage'
import type { BotDifficulty, MatchSettings } from '../../src/sim'

const argv = process.argv.slice(2)
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}
const scenario = arg('scenario', 'ffa4')
const matches = Number(arg('matches', '8'))
const seed0 = Number(arg('seed', '1'))
const custom: Record<string, { base: BotDifficulty } & Partial<BotParams>> = arg('params', '') ? JSON.parse(readFileSync(arg('params', ''), 'utf8')) : {}
const tiers = arg('tiers', scenario === 'duel' ? 'uber,brutal' : 'medium,hard,brutal,uber').split(',')

function seatOf(tier: string): MotionSeat & { label: string } {
  const c = custom[tier]
  if (c) {
    const { base, ...over } = c
    return { label: tier, difficulty: base, params: { ...BOT_PRESETS[base], ...over } }
  }
  if (!(tier in BOT_PRESETS)) throw new Error(`unknown tier ${tier}`)
  return { label: tier, difficulty: tier as BotDifficulty }
}

const byLabel = new Map<string, MotionCounts>()
const lock = new Map<string, { ticks: number; a: number; b: number; both: number }>()
const started = Date.now()
for (let m = 0; m < matches; m++) {
  const seed = seed0 + m
  let seats: (MotionSeat & { label: string })[]
  let settings: Partial<MatchSettings> = {}
  let botSeed: ((id: number) => number) | undefined
  if (scenario === 'menu') {
    seats = Array.from({ length: 8 }, (_, id) => seatOf(id % 2 ? 'uber' : 'brutal'))
    settings = MENU_BATTLE_SETTINGS
    botSeed = () => seed
  } else if (scenario === 'duel') {
    seats = (m % 2 ? [tiers[1], tiers[0]] : [tiers[0], tiers[1]]).map(seatOf)
  } else {
    const rot = m % tiers.length
    seats = [...tiers.slice(rot), ...tiers.slice(0, rot)].map(seatOf)
    settings = { teamMode: 'ffa' }
  }
  const { meter, state } = meterBotMatch(seats, settings, seed, botSeed)
  seats.forEach((s, id) => byLabel.set(s.label, mergeMotion(byLabel.get(s.label) ?? emptyMotion(), meter.counts(id))))
  for (const s of new Set(state.slots.map((sl) => sl.difficulty!))) {
    const l = meter.sameTick(s)
    if (!l) continue
    const into = lock.get(s) ?? { ticks: 0, a: 0, b: 0, both: 0 }
    for (const k of ['ticks', 'a', 'b', 'both'] as const) into[k] += l[k]
    lock.set(s, into)
  }
}

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-')
console.log(`# ${scenario}, ${matches} matches from seed ${seed0} (${((Date.now() - started) / 1000).toFixed(0)} s)`)
console.log('tier        fight-s orders/s rev/s  free  dither idle  flip  flips/s short  gaps p10/p50/p90  think p10/p50/p90/mean')
for (const [label, c] of byLabel) {
  const s = summarizeMotion(c)
  console.log(`${label.padEnd(11)} ${f(s.seconds, 0).padStart(7)} ${f(s.ordersPerSecond).padStart(8)} ${f(s.reversalsPerSecond).padStart(5)} ${f(s.freeReversalsPerSecond).padStart(5)} ${f(s.dither, 3).padStart(6)} ${f(s.idle).padStart(5)} ${f(s.clickFlip, 3).padStart(5)} ${f(s.flipsPerSecond).padStart(7)} ${f(s.shortClick).padStart(5)}  ${s.moveGaps.map((g) => f(g)).join('/').padStart(14)}  ${s.thinkGaps.map((g) => f(g, 3)).join('/')}`)
}
for (const [tier, l] of lock) console.log(`same-tick ratio ${tier.padEnd(7)} ${f(sameTickRatio(l))} (1 = chance)`)
