// Research experiment for docs/moonshot/04-keystones.md: casual-table bot-only rounds under
// different starting arena sizes and shrink periods. Hacks state from outside; no source change.
// Run: npx vite-node docs/moonshot/research/pace-experiment.ts [matches per scenario, default 6]
// Measured 2026-10-28 with 8 matches per scenario (seeds 100-107), five Medium and five Hard bots.
// Results (seconds; match in minutes, first to 3 in a ten-warlock FFA):
//   scenario                    first death p50/p90  round p50/p90  match p50  rounds
//   A baseline layer 21, 10 s        66 / 113          177 / 187       30         9
//   B layer 17, 10 s                 61 /  88          137 / 148       28        10
//   C layer 21, 6 s                  55 /  79          111 / 116       19         8
//   D layer 17, 6 s                  41 /  59           90 /  94       20        10
//   E layer 17, 8 s x alive/n        46 /  68          100 / 105       17         8
//   F layer 15, 6 s                  38 /  50           76 /  81       16         9
//   G layer 15, 6 s x alive/n        37 /  51           70 /  73       19        12
import { BotController } from '../../../src/bots'
import { DEFAULT_SETTINGS, createMatch, step } from '../../../src/sim'
import { TICK_HZ, type PlayerSlot, type BotDifficulty } from '../../../src/sim'

type Scn = { name: string; layer: number | null; period: (alive: number, n: number) => number }
const N = 10
const scenarios: Scn[] = [
  { name: 'A baseline L21 10s', layer: null, period: () => 10 },
  { name: 'B L17 10s', layer: 17, period: () => 10 },
  { name: 'C L21 6s', layer: null, period: () => 6 },
  { name: 'D L17 6s', layer: 17, period: () => 6 },
  { name: 'E L17 accel 8s*alive/n (min 3)', layer: 17, period: (a, n) => Math.max(3, 8 * a / n) },
  { name: 'F L15 6s', layer: 15, period: () => 6 },
  { name: 'G L15 accel 6s*alive/n (min 2.5)', layer: 15, period: (a, n) => Math.max(2.5, 6 * a / n) },
]
const MATCHES = Number(process.argv[2] ?? 6)
const mix: BotDifficulty[] = ['medium', 'medium', 'medium', 'medium', 'medium', 'hard', 'hard', 'hard', 'hard', 'hard']
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN }
for (const sc of scenarios) {
  const first: number[] = [], len: number[] = [], deathT: number[] = [], matchSec: number[] = [], roundsPer: number[] = []
  for (let m = 0; m < MATCHES; m++) {
    const seed = 100 + m
    const slots: PlayerSlot[] = mix.map((d, id) => ({ id, name: d + id, color: 0x100000 * (id + 1), team: id, kind: 'bot', difficulty: d }))
    const state = createMatch({ ...DEFAULT_SETTINGS, teamMode: 'ffa', winScore: 3, startGold: 50, roundGold: 15, killGold: 2, winGold: 3 }, slots, seed)
    const bots = slots.map((s) => new BotController(s.id, s.difficulty!, seed * 31 + s.id))
    let prev = state.phase, fightStart = 0, firstDeath = -1, lastShrinkTarget = -1, rounds = 0
    const maxT = 3600 * TICK_HZ
    for (let t = 0; t < maxT && state.phase !== 'gameOver'; t++) {
      step(state, bots.map((b) => ({ player: b.player, tick: state.tick, cmds: b.think(state) })))
      const alive = state.pawns.filter((p) => p.alive).length
      if (state.phase === 'fight' && prev !== 'fight') {
        fightStart = state.tick; firstDeath = -1; rounds++
        if (sc.layer !== null && sc.layer < state.arena.layer) {
          const maxR = (sc.layer - 1) * 100 - 300
          let far = 0
          for (const p of state.pawns) if (p.alive) far = Math.max(far, Math.hypot(p.x, p.y))
          const k = far > maxR ? maxR / far : 1
          for (const p of state.pawns) { p.x *= k; p.y *= k; p.moveTarget = null }
          state.arena.layer = sc.layer
        }
        state.arena.nextShrinkTick = state.tick + Math.round(sc.period(alive, N) * TICK_HZ)
        lastShrinkTarget = state.arena.nextShrinkTick
      }
      if (state.phase === 'fight') {
        // re-time each scheduled shrink to the scenario's period
        if (state.arena.nextShrinkTick !== lastShrinkTarget && state.arena.nextShrinkTick > 0) {
          state.arena.nextShrinkTick = state.tick + Math.round(sc.period(alive, N) * TICK_HZ) - 1
          lastShrinkTarget = state.arena.nextShrinkTick
        }
      }
      if (state.phase === 'fight' || prev === 'fight')
        for (const e of state.events) if (e.type === 'death') {
          const s = (state.tick - fightStart) / TICK_HZ
          deathT.push(s)
          if (firstDeath < 0) { firstDeath = s; first.push(s) }
        }
      if (prev === 'fight' && state.phase !== 'fight') len.push((state.tick - fightStart) / TICK_HZ)
      prev = state.phase
    }
    matchSec.push(state.tick / TICK_HZ); roundsPer.push(rounds)
  }
  const f = (x: number) => x.toFixed(0)
  console.log(`${sc.name.padEnd(36)} first death p50 ${f(pct(first, .5))} p90 ${f(pct(first, .9))} | round p50 ${f(pct(len, .5))} p90 ${f(pct(len, .9))} | deaths p50 ${f(pct(deathT, .5))} | match p50 ${f(pct(matchSec, .5) / 60)} min, rounds ${pct(roundsPer, .5)}`)
}
