// Research experiment for docs/moonshot/specs/faster-casual.md. Drives the real sim and bots
// from outside (no repo change). Run from the repo root:
//   npx vite-node <this file> -- <scenario names comma-separated|all> <matches> <firstSeed>
// Prints one JSON line per scenario with raw per-match data for aggregation.
import { BotController } from '../../../src/bots'
import { DEFAULT_SETTINGS, createMatch, step, ticks } from '../../../src/sim'
import { TICK_HZ, type BotDifficulty, type MatchSettings, type PlayerSlot } from '../../../src/sim'
import { spawnPosition } from '../../../src/sim/spawn'
import { PI } from '../../../src/sim/math'

type Scn = {
  name: string
  settings: Partial<MatchSettings>
  /** fight start layer for scoring rounds (null = sim's 13 + players) */
  layer: number | null
  /** shrink period for scoring rounds, s (null = sim's) */
  period: number | null
  /** shop phase cut to at most this many seconds (null = sim's 25 s / 15 s final) */
  shop: number | null
}
const FT3 = { winScore: 3 }
const SCHED = { rankedRounds: 5 as const }
const ALL: Scn[] = [
  { name: 'A ft3 L21 10s shop25', settings: FT3, layer: null, period: null, shop: null },
  { name: 'B sched5 L21 8s shop25', settings: SCHED, layer: null, period: null, shop: null },
  { name: 'C sched5 L17 8s shop25', settings: SCHED, layer: 17, period: null, shop: null },
  { name: 'D sched5 L15 8s shop25', settings: SCHED, layer: 15, period: null, shop: null },
  { name: 'E sched5 L17 6s shop25', settings: SCHED, layer: 17, period: 6, shop: null },
  { name: 'F sched5 L15 6s shop25', settings: SCHED, layer: 15, period: 6, shop: null },
  { name: 'G sched5 L15 6s shop12', settings: SCHED, layer: 15, period: 6, shop: 12 },
  { name: 'H sched5 L17 6s shop12', settings: SCHED, layer: 17, period: 6, shop: 12 },
  { name: 'I ft3 L15 6s shop25', settings: FT3, layer: 15, period: 6, shop: null },
  { name: 'J ft3 L15 6s shop12', settings: FT3, layer: 15, period: 6, shop: 12 },
  { name: 'K sched5 L15 6s shop6', settings: SCHED, layer: 15, period: 6, shop: 6 },
  { name: 'L sched5 L16 7s shop12', settings: SCHED, layer: 16, period: 7, shop: 12 },
  { name: 'M ft3 L21 10s shop12', settings: FT3, layer: null, period: null, shop: 12 },
  { name: 'N sched5 L21 10s shop25', settings: SCHED, layer: null, period: 10, shop: null },
  { name: 'O sched5 L15 7s shop25', settings: SCHED, layer: 15, period: 7, shop: null },
  { name: 'P sched5 L15 7s shop12', settings: SCHED, layer: 15, period: 7, shop: 12 },
  { name: 'Q sched5 L15 6s shop25 seeds2', settings: SCHED, layer: 15, period: 6, shop: null },
  { name: 'R ft3 L21 10s shop25 seeds2', settings: FT3, layer: null, period: null, shop: null },
]
const args = process.argv.slice(2).filter((a) => a !== '--')
const pick = args[0] ?? 'all'
const MATCHES = Number(args[1] ?? 8)
const SEED0 = Number(args[2] ?? 100)
const scenarios = pick === 'all' ? ALL : ALL.filter((s) => pick.split(',').includes(s.name.split(' ')[0]))
const mix: BotDifficulty[] = ['medium', 'medium', 'medium', 'medium', 'medium', 'hard', 'hard', 'hard', 'hard', 'hard']

for (const sc of scenarios) {
  const t0 = Date.now()
  const out: Record<string, unknown>[] = []
  for (let m = 0; m < MATCHES; m++) {
    const seed = SEED0 + m
    const slots: PlayerSlot[] = mix.map((d, id) => ({ id, name: d + id, color: 0x100000 * (id + 1), team: id, kind: 'bot', difficulty: d }))
    const state = createMatch({ ...DEFAULT_SETTINGS, teamMode: 'ffa', startGold: 50, roundGold: 15, killGold: 2, winGold: 3, ...sc.settings } as MatchSettings, slots, seed)
    const bots = slots.map((s) => new BotController(s.id, s.difficulty!, seed * 31 + s.id))
    const cutShop = () => { if (sc.shop !== null) state.phaseTicksLeft = Math.min(state.phaseTicksLeft, ticks(sc.shop)) }
    cutShop()
    let prev = state.phase, fightStart = 0, shopStart = 0, firstDeath = -1, final = false
    const rounds: { first: number; len: number; final: boolean; winners: number[]; deaths: number[] }[] = []
    let cur: { first: number; len: number; final: boolean; winners: number[]; deaths: number[] } | null = null
    const shops: { len: number; lastBuy: number[]; unspent: number[] }[] = []
    let shop = { len: 0, lastBuy: new Array(10).fill(-1), unspent: [] as number[] }
    const maxT = 3600 * TICK_HZ
    for (let t = 0; t < maxT && state.phase !== 'gameOver'; t++) {
      step(state, bots.map((b) => ({ player: b.player, tick: state.tick, cmds: b.think(state) })))
      const startedAt = state.tick - 1 // the tick phaseTick ran at
      if (state.phase === 'shop' && prev !== 'shop') {
        cutShop(); shopStart = state.tick
        shop = { len: 0, lastBuy: new Array(10).fill(-1), unspent: [] }
      }
      if (prev === 'shop' && state.phase !== 'shop') {
        shop.len = (state.tick - shopStart) / TICK_HZ
        shop.unspent = state.scores.map((s) => s.gold)
        shops.push(shop)
      }
      if (state.phase === 'shop' || prev === 'shop') for (const e of state.events) if (e.type === 'purchase') shop.lastBuy[e.player] = (state.tick - shopStart) / TICK_HZ
      if (state.phase === 'fight' && prev !== 'fight') {
        fightStart = state.tick; firstDeath = -1
        final = !!state.rankedFinal
        cur = { first: -1, len: 0, final, winners: [], deaths: [] }
        if (!final && sc.layer !== null && sc.layer < state.arena.layer) {
          // as if startRound had used the smaller layer: same spawn rule (capped ring)
          state.arena.layer = sc.layer
          for (const p of state.pawns) if (p.alive) {
            const sp = spawnPosition(state, p.owner)
            p.x = sp.x; p.y = sp.y; p.facing = sp.angle + PI > PI ? sp.angle - PI : sp.angle + PI; p.moveTarget = null
          }
        }
        if (!final && sc.period !== null) state.arena.nextShrinkTick = startedAt + ticks(sc.period)
      }
      if (state.phase === 'fight' && !final && sc.period !== null && state.events.some((e) => e.type === 'arenaShrink')) state.arena.nextShrinkTick = startedAt + ticks(sc.period)
      for (const e of state.events) {
        if (e.type === 'death' && cur && (state.phase === 'fight' || prev === 'fight')) {
          const s = (state.tick - fightStart) / TICK_HZ
          cur.deaths.push(s)
          if (firstDeath < 0) { firstDeath = s; cur.first = s }
        }
        if (e.type === 'roundWin' && cur) cur.winners = e.players.slice()
      }
      if (prev === 'fight' && state.phase !== 'fight' && cur) { cur.len = (state.tick - fightStart) / TICK_HZ; rounds.push(cur); cur = null }
      prev = state.phase
    }
    const winners = state.events.find((e) => e.type === 'gameOver')
    out.push({
      seed, sec: state.tick / TICK_HZ, rounds, shops,
      scores: state.scores.map((s) => s.score), spent: state.scores.map((s) => s.spent), gold: state.scores.map((s) => s.gold),
      winners: winners && winners.type === 'gameOver' ? winners.winners : null,
      finalists: state.rankedFinal?.contenders ?? null,
    })
  }
  console.log(JSON.stringify({ name: sc.name, ms: Date.now() - t0, matches: out }))
}
