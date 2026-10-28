// npx vite-node run.ts -- --scenario ffa6|duel|menu --matches N [--variant name] [--pair uber,brutal] [--seed 1] [--detail]
import { timing, picks, line, merge, newAcc, playMatch, roundShare, top, type Acc, type MatchOut, type Seat } from './harness'
import type { BotDifficulty } from '../../../../src/sim/types'
import { VARIANTS } from './variants'
import { BUDGET } from './controller-motor'

const argv = process.argv.slice(2)
const arg = (n: string, f: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : f }
const scenario = arg('scenario', 'ffa6')
const matches = Number(arg('matches', '4'))
const variant = arg('variant', 'base')
const seed0 = Number(arg('seed', scenario === 'ffa6' ? '500' : '1'))
const detail = argv.includes('--detail')
const v = VARIANTS[variant]
if (!v) throw new Error(`unknown variant ${variant}`)

const seat = (label: string, base: BotDifficulty, mod = true): Seat => ({ label, base, over: mod ? v.over?.(base) : undefined, ctor: mod ? v.ctor : undefined })
const outs: MatchOut[] = []
const t0 = Date.now()
for (let m = 0; m < matches; m++) {
  const seed = seed0 + m
  if (scenario === 'ffa6') {
    const tiers: BotDifficulty[] = ['easy', 'medium', 'hard', 'brutal', 'uber', 'hard']
    outs.push(playMatch(tiers.map((t) => seat(t, t)), { teamMode: 'ffa', winScore: 3 }, seed))
  } else if (scenario === 'ffa4') {
    const tiers: BotDifficulty[] = ['medium', 'hard', 'brutal', 'uber']
    const rot = m % 4
    const order = [...tiers.slice(rot), ...tiers.slice(0, rot)]
    outs.push(playMatch(order.map((t) => seat(t, t)), { teamMode: 'ffa' }, seed))
  } else if (scenario === 'menu') {
    const seats = Array.from({ length: 8 }, (_, id) => seat(id % 2 ? 'uber' : 'brutal', id % 2 ? 'uber' : 'brutal'))
    outs.push(playMatch(seats, { winScore: 3, startGold: 110, roundGold: 12, shopSeconds: 7, spectatorBets: false, bounties: false } as any, seed, () => seed))
  } else if (scenario === 'duel') {
    // candidate (variant) vs reference (preset), sides alternate
    const [a, b] = arg('pair', 'uber,brutal').split(',') as BotDifficulty[]
    const cand = seat(`${a}*`, a)
    const ref = seat(b === a ? `${b}` : b, b, false)
    outs.push(playMatch(m % 2 ? [ref, cand] : [cand, ref], {}, seed))
  } else if (scenario === 'mirror') {
    // both seats run the variant (motion only)
    const [a, b] = arg('pair', 'uber,brutal').split(',') as BotDifficulty[]
    outs.push(playMatch(m % 2 ? [seat(b, b), seat(a, a)] : [seat(a, a), seat(b, b)], {}, seed))
  }
}
const by = new Map<string, Acc>()
for (const o of outs) o.seats.forEach((s, i) => { const k = s.label; const a = by.get(k) ?? newAcc(); merge(a, o.acc[i]); by.set(k, a) })
console.log(`# ${scenario} variant=${variant} matches=${matches} seeds ${seed0}.. (${((Date.now() - t0) / 1000).toFixed(0)} s wall)`)
for (const [k, a] of by) console.log(line(k, a))
if (detail) for (const [k, a] of by) {
  console.log(`  ${k} orders by source: ${top(a.byTag, a.orders)}`)
  console.log(`  ${k} redirects by source: ${top(a.redirByTag, a.redirects)}`)
  console.log(`  ${k} reversals by source: ${top(a.revByTag, a.rev)}`)
  console.log(`  ${k} reversal transitions: ${top(a.trans, a.rev, 10)}`)
}
for (const [k, t] of Object.entries(timing)) {
  const g = [...t.gaps].sort((x, y) => x - y)
  const q = (f: number) => (g[Math.min(g.length - 1, Math.floor(f * g.length))] ?? NaN).toFixed(3)
  const mean = g.reduce((x, y) => x + y, 0) / Math.max(1, g.length)
  const lock = t.n && t.a && t.b ? (t.both / t.a) / (t.b / t.n) : NaN
  console.log(`  think ${k.padEnd(7)} gaps p10 ${q(0.1)} p50 ${q(0.5)} p90 ${q(0.9)} mean ${mean.toFixed(3)} | same-tick ratio ${lock.toFixed(2)} (1 = chance)`)
}
if (BUDGET.asked) console.log(`  budget: ${BUDGET.asked} orders, ${(100 * BUDGET.dropped / BUDGET.asked).toFixed(1)}% dropped, ${(100 * BUDGET.bypass / BUDGET.asked).toFixed(1)}% urgent over budget`)
if (detail) console.log('wander picks (kind:reason[:stay]):', top(picks, Object.values(picks).reduce((x, y) => x + y, 0), 14))
if (scenario === 'mirror') {
  const [a, b] = arg('pair', 'uber,brutal').split(',')
  const r = roundShare(outs, a, b)
  console.log(`rounds ${a} vs ${b} (both ${variant}): ${r.w}-${r.l}-${r.d} = ${(100 * (r.w + r.d / 2) / (r.w + r.l + r.d)).toFixed(1)}%`)
}
if (scenario === 'duel') {
  const [a, b] = arg('pair', 'uber,brutal').split(',')
  const r = roundShare(outs, `${a}*`, b)
  const n = r.w + r.l + r.d
  let mw = 0
  for (const o of outs) { const ia = o.seats.findIndex((s) => s.label === `${a}*`); if (o.scores[ia] > o.scores[1 - ia]) mw++ }
  console.log(`rounds ${a}* vs ${b}: ${r.w}-${r.l}-${r.d} = ${(100 * (r.w + r.d / 2) / n).toFixed(1)}%  matches won ${mw}/${outs.length}  avg min ${(outs.reduce((s, o) => s + o.seconds, 0) / outs.length / 60).toFixed(1)}`)
}
