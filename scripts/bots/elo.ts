/**
 * Bot difficulty ladder, rated headless on the real sim (docs/PLAN.md §7).
 *   npm run bots:elo -- [--games 100] [--ffa 0] [--workers 8] [--seed 1]
 *                       [--tiers easy,medium,hard,brutal,uber] [--params file.json] [--vs tier] [--out file.json]
 *
 * Seeded 1v1 round-robin: every pair of tiers plays `--games` full matches with the default
 * match settings (first to 5), sides swapped every other seed. `--ffa N` adds N 4-player FFA
 * pods per 4-tier combination.
 *
 * The rating unit is the ROUND, the unit a player feels (a first-to-5 match amplifies every
 * gap): each round is a set of pairwise games decided by who outlived whom (the round winner
 * beats everyone, then later deaths beat earlier ones, the same tick is a draw). Elo by
 * maximum likelihood (Bradley–Terry, src/bots/rating.ts) over all 1v1 rounds, Medium = 1000.
 * Rounds of one match are not independent (gold and items carry over), so the 95% intervals
 * come from a bootstrap over whole matches, per pair. Match win rates are listed too.
 *
 * Same seeds give the same games: the bots and the sim are deterministic. Jobs are split over
 * `--workers` child processes, so the result does not depend on the worker count.
 *
 * `--params file.json` rates candidate presets while tuning: { "name": { "base": "hard",
 * ...BotParams overrides } }. The names can then be used in --tiers; `--vs uber` plays only the
 * pairs that include Uber.
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BOT_PRESETS, BotController, type BotParams } from '../../src/bots'
import { Rng } from '../../src/bots/prng'
import { bradleyTerry, type PairRecord, type Rating } from '../../src/bots/rating'
import { DEFAULT_SETTINGS, createMatch, step } from '../../src/sim'
import { TICK_HZ } from '../../src/sim/types'
import type { BotDifficulty, PlayerSlot } from '../../src/sim'

const argv = process.argv.slice(2)
function arg(name: string, fallback: string): string {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}

const GAMES = Number(arg('games', '100'))
const FFA = Number(arg('ffa', '0'))
const WORKERS = Number(arg('workers', '8'))
const SEED = Number(arg('seed', '1'))
const TIERS = arg('tiers', 'easy,medium,hard,brutal,uber').split(',')
const PARAMS_FILE = arg('params', '')
const OUT = arg('out', '')
const SHARD = arg('shard', '')
/** only pairs that include this tier (a gauntlet against one reference) */
const VS = arg('vs', '')
/** a match that runs this long (sim seconds) is scored as it stands */
const MAX_SECONDS = 1500
const BOOTSTRAP = 500

const custom: Record<string, { base: BotDifficulty } & Partial<BotParams>> = PARAMS_FILE
  ? JSON.parse(readFileSync(PARAMS_FILE, 'utf8'))
  : {}

function paramsOf(tier: string): { difficulty: BotDifficulty; params: BotParams } {
  const c = custom[tier]
  if (c) {
    const { base, ...over } = c
    return { difficulty: base, params: { ...BOT_PRESETS[base], ...over } }
  }
  if (!(tier in BOT_PRESETS)) throw new Error(`unknown tier ${tier}`)
  return { difficulty: tier as BotDifficulty, params: BOT_PRESETS[tier as BotDifficulty] }
}

interface Job {
  kind: 'duel' | 'ffa'
  tiers: string[]
  seed: number
}

interface GameResult {
  job: number
  kind: Job['kind']
  tiers: string[]
  /** final match score per slot */
  scores: number[]
  /** per round, per slot: the tick it died (SURVIVED when it outlived the round) */
  rounds: number[][]
  seconds: number
}

function jobs(): Job[] {
  const out: Job[] = []
  for (let i = 0; i < TIERS.length; i++)
    for (let j = i + 1; j < TIERS.length; j++)
      for (let g = 0; g < GAMES; g++) {
        if (VS && TIERS[i] !== VS && TIERS[j] !== VS) continue
        const pair = [TIERS[i], TIERS[j]]
        out.push({ kind: 'duel', tiers: g % 2 ? pair.reverse() : pair, seed: SEED + g })
      }
  if (FFA > 0 && TIERS.length >= 4) {
    const combos: string[][] = []
    const pick = (from: number, acc: string[]) => {
      if (acc.length === 4) return void combos.push(acc)
      for (let k = from; k < TIERS.length; k++) pick(k + 1, [...acc, TIERS[k]])
    }
    pick(0, [])
    for (const c of combos)
      for (let g = 0; g < FFA; g++) {
        const rot = g % 4
        out.push({ kind: 'ffa', tiers: [...c.slice(rot), ...c.slice(0, rot)], seed: SEED + 10_000 + g })
      }
  }
  return out
}

const SURVIVED = 1e9

function play(job: Job, index: number): GameResult {
  const slots: PlayerSlot[] = job.tiers.map((t, id) => ({
    id,
    name: t,
    color: 0xff0000 + id,
    team: id,
    kind: 'bot',
    difficulty: paramsOf(t).difficulty,
  }))
  const state = createMatch({ ...DEFAULT_SETTINGS }, slots, job.seed)
  const bots = job.tiers.map((t, id) => {
    const p = paramsOf(t)
    return new BotController(id, p.difficulty, job.seed * 31 + id, p.params)
  })
  const rounds: number[][] = []
  let died: number[] = []
  let prev = state.phase
  const maxTicks = MAX_SECONDS * TICK_HZ
  let ticks = 0
  for (; ticks < maxTicks && state.phase !== 'gameOver'; ticks++) {
    step(
      state,
      bots.map((b) => ({ player: b.player, tick: state.tick, cmds: b.think(state) })),
    )
    if (state.phase === 'fight' && prev !== 'fight') died = job.tiers.map(() => SURVIVED)
    // the round's last death lands on the tick the phase changes
    if (state.phase === 'fight' || prev === 'fight')
      for (const e of state.events) if (e.type === 'death') died[e.owner] = state.tick
    if (prev === 'fight' && state.phase !== 'fight') rounds.push(died)
    prev = state.phase
  }
  return {
    job: index,
    kind: job.kind,
    tiers: job.tiers,
    scores: job.tiers.map((_, id) => state.scores.find((s) => s.id === id)?.score ?? 0),
    rounds,
    seconds: ticks / TICK_HZ,
  }
}

async function main() {
  const all = jobs()
  const t0 = Date.now()
  const results: GameResult[] = []
  const script = fileURLToPath(import.meta.url)
  const passArgs = argv.filter((_, i) => argv[i] !== '--out' && argv[i - 1] !== '--out')
  await Promise.all(
    Array.from({ length: WORKERS }, (_, k) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn('npx', ['vite-node', script, '--', ...passArgs, '--shard', `${k}/${WORKERS}`], {
          stdio: ['ignore', 'pipe', 'inherit'],
        })
        let buf = ''
        child.stdout.on('data', (d: Buffer) => {
          buf += d.toString()
          let nl: number
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (!line.startsWith('{')) continue
            results.push(JSON.parse(line))
            if (results.length % 50 === 0 || results.length === all.length)
              process.stderr.write(`\r${results.length}/${all.length} games, ${((Date.now() - t0) / 1000).toFixed(0)} s`)
          }
        })
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${k} exited with ${code}`))))
      }),
    ),
  )
  process.stderr.write('\n')
  if (results.length !== all.length) throw new Error(`expected ${all.length} games, got ${results.length}`)
  results.sort((a, b) => a.job - b.job)
  report(results, (Date.now() - t0) / 1000)
}

const order = (t: string) => TIERS.indexOf(t)
const pairKey = (a: string, b: string) => (order(a) < order(b) ? `${a}|${b}` : `${b}|${a}`)

/** pairwise round records of one game, the tier listed first in TIERS as `a` */
function roundRecords(r: GameResult): PairRecord[] {
  const out: PairRecord[] = []
  for (let x = 0; x < r.tiers.length; x++)
    for (let y = x + 1; y < r.tiers.length; y++) {
      let [i, j] = [x, y]
      if (order(r.tiers[i]) > order(r.tiers[j])) [i, j] = [j, i]
      const rec: PairRecord = { a: r.tiers[i], b: r.tiers[j], winsA: 0, winsB: 0, draws: 0 }
      for (const died of r.rounds) {
        if (died[i] > died[j]) rec.winsA++
        else if (died[j] > died[i]) rec.winsB++
        else rec.draws++
      }
      out.push(rec)
    }
  return out
}

function sum(recs: PairRecord[]): PairRecord[] {
  const m = new Map<string, PairRecord>()
  for (const r of recs) {
    const k = pairKey(r.a, r.b)
    const s = m.get(k) ?? { a: r.a, b: r.b, winsA: 0, winsB: 0, draws: 0 }
    s.winsA += r.winsA
    s.winsB += r.winsB
    s.draws += r.draws
    m.set(k, s)
  }
  return [...m.values()]
}

/** BT ratings plus 95% intervals from resampling whole games within each line-up */
function rate(games: GameResult[]): Record<string, Rating & { lo: number; hi: number }> {
  const players = TIERS.filter((t) => games.some((g) => g.tiers.includes(t)))
  const anchor = players.includes('medium') ? 'medium' : players[0]
  const per = games.map(roundRecords)
  const point = bradleyTerry(players, sum(per.flat()), anchor)
  const groups = new Map<string, PairRecord[][]>()
  games.forEach((g, i) => {
    const k = [...g.tiers].sort().join('|')
    groups.set(k, [...(groups.get(k) ?? []), per[i]])
  })
  const rng = new Rng(12345)
  const samples: Record<string, number[]> = Object.fromEntries(players.map((p) => [p, []]))
  for (let b = 0; b < BOOTSTRAP; b++) {
    const sample: PairRecord[] = []
    for (const g of groups.values()) for (let k = 0; k < g.length; k++) sample.push(...g[rng.int(g.length)])
    const r = bradleyTerry(players, sum(sample), anchor)
    for (const p of players) samples[p].push(r[p].elo)
  }
  return Object.fromEntries(
    players.map((p) => {
      const d = samples[p].sort((x, y) => x - y)
      const lo = d[Math.floor(0.025 * d.length)]
      const hi = d[Math.ceil(0.975 * d.length) - 1]
      return [p, { ...point[p], lo, hi, ci95: (hi - lo) / 2 }]
    }),
  )
}

function report(results: GameResult[], wall: number) {
  const pct = (x: number) => `${(100 * x).toFixed(0)}%`
  const byOrder = (x: PairRecord, y: PairRecord) => order(x.a) - order(y.a) || order(x.b) - order(y.b)
  const duels = results.filter((r) => r.kind === 'duel')
  const rounds = sum(duels.flatMap(roundRecords)).sort(byOrder)
  console.log(`\n1v1 round-robin: ${GAMES} matches per pair, first to ${DEFAULT_SETTINGS.winScore}, seeds ${SEED}..${SEED + GAMES - 1}`)
  console.log('stronger vs weaker    rounds W-L-D   round%   matches W-L-D   match%   avg min')
  for (const r of rounds) {
    const games = duels.filter((g) => g.tiers.includes(r.a) && g.tiers.includes(r.b))
    let [w, l, d] = [0, 0, 0]
    for (const g of games) {
      const [sa, sb] = [g.scores[g.tiers.indexOf(r.a)], g.scores[g.tiers.indexOf(r.b)]]
      if (sb > sa) w++
      else if (sa > sb) l++
      else d++
    }
    const capped = games.filter((g) => g.seconds >= MAX_SECONDS).length
    const n = r.winsA + r.winsB + r.draws
    const minutes = games.reduce((s, g) => s + g.seconds, 0) / games.length / 60
    console.log(
      `${`${r.b} vs ${r.a}`.padEnd(21)} ${`${r.winsB}-${r.winsA}-${r.draws}`.padEnd(13)} ${pct((r.winsB + r.draws / 2) / n).padStart(5)}    ` +
        `${`${w}-${l}-${d}`.padEnd(14)} ${pct((w + d / 2) / games.length).padStart(5)}   ${minutes.toFixed(1).padStart(6)}` +
        (capped ? `  (${capped} hit the ${MAX_SECONDS} s cap)` : ''),
    )
  }
  const elo = duels.length ? rate(duels) : {}
  if (duels.length) console.log(`\nround Elo (Bradley–Terry MLE, medium = 1000; 95% CI: bootstrap over matches, ${BOOTSTRAP} resamples)`)
  const rated = TIERS.filter((t) => elo[t])
  rated.forEach((t, i) => {
    const r = elo[t]
    const gap = i > 0 ? `  +${(r.elo - elo[rated[i - 1]].elo).toFixed(0)} over ${rated[i - 1]}` : ''
    console.log(`${t.padEnd(10)} ${r.elo.toFixed(0).padStart(6)}  [${r.lo.toFixed(0)}, ${r.hi.toFixed(0)}]${gap}`)
  })
  let ffaElo: ReturnType<typeof rate> | null = null
  const pods = results.filter((r) => r.kind === 'ffa')
  if (pods.length) {
    console.log(`\n4-player FFA pods: ${FFA} per 4-tier combination; rounds by who outlived whom`)
    for (const r of sum(pods.flatMap(roundRecords)).sort(byOrder)) {
      const n = r.winsA + r.winsB + r.draws
      console.log(`${`${r.b} vs ${r.a}`.padEnd(21)} ${`${r.winsB}-${r.winsA}-${r.draws}`.padEnd(13)} ${pct((r.winsB + r.draws / 2) / n).padStart(5)}`)
    }
    const f = rate(pods)
    ffaElo = f
    for (const t of TIERS.filter((u) => f[u])) console.log(`${t.padEnd(10)} ${f[t].elo.toFixed(0).padStart(6)}  [${f[t].lo.toFixed(0)}, ${f[t].hi.toFixed(0)}]`)
  }
  console.log(`\n${results.length} games in ${wall.toFixed(0)} s wall (${WORKERS} workers)`)
  if (OUT) writeFileSync(OUT, JSON.stringify({ games: GAMES, ffa: FFA, seed: SEED, tiers: TIERS, rounds, elo, ffaElo, results }))
}

if (SHARD) {
  // worker: play every job whose index falls in this shard, one JSON line each
  const [k, n] = SHARD.split('/').map(Number)
  jobs().forEach((job, i) => {
    if (i % n === k) process.stdout.write(JSON.stringify(play(job, i)) + '\n')
  })
} else {
  await main()
}
