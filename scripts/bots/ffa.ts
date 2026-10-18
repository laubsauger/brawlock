/**
 * FFA behaviour metrics for bots (seeded, headless, real sim):
 *   npx vite-node scripts/bots/ffa.ts -- [--matches 12] [--lineup hard,mixed,brutal] [--seed 1] [--workers 8]
 *
 * Lineups (8 bots each): `hard` (quick play's default table), `mixed` (easy..uber), `brutal`.
 * Sampled every 0.5 s of fight:
 * - focus: bots after the same player (mean over targeted players, and the largest pile);
 * - spread: mean pairwise distance between living bots; mob: share of samples with 4+ bots
 *   within 450 of each other's centre all after one player;
 * - kills on the weakest: share of credited kills whose victim had the lowest HP share of
 *   everyone alive 3 s before (when the kill was set up, not while it burned);
 * - round length (fight seconds per round) and rounds per match (first to 5, capped at 25 min).
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { BotController } from '../../src/bots'
import { DEFAULT_SETTINGS, createMatch, step } from '../../src/sim'
import type { BotDifficulty, PlayerSlot } from '../../src/sim'

const argv = process.argv.slice(2)
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}
const MATCHES = Number(arg('matches', '12'))
const SEED = Number(arg('seed', '1'))
const WORKERS = Number(arg('workers', '8'))
const SHARD = arg('shard', '')
const LINEUPS: Record<string, BotDifficulty[]> = {
  hard: Array(8).fill('hard'),
  mixed: ['easy', 'medium', 'medium', 'hard', 'hard', 'brutal', 'brutal', 'uber'],
  brutal: Array(8).fill('brutal'),
}
const NAMES = arg('lineup', 'hard,mixed,brutal').split(',')

interface Result {
  lineup: string
  seed: number
  samples: number
  focusSum: number
  focusN: number
  maxFocusSum: number
  pairDistSum: number
  mobSamples: number
  kills: number
  weakestKills: number
  seconds: number
  rounds: number
  fightSeconds: number
}

function play(lineup: string, seed: number): Result {
  const diffs = LINEUPS[lineup]
  const slots: PlayerSlot[] = diffs.map((d, id) => ({ id, name: `${d}${id}`, color: 0xff0000 + id, team: id, kind: 'bot', difficulty: d }))
  const state = createMatch({ ...DEFAULT_SETTINGS }, slots, seed)
  const bots = diffs.map((d, id) => new BotController(id, d, seed * 31 + id))
  const r: Result = { lineup, seed, samples: 0, focusSum: 0, focusN: 0, maxFocusSum: 0, pairDistSum: 0, mobSamples: 0, kills: 0, weakestKills: 0, seconds: 0, rounds: 0, fightSeconds: 0 }
  // HP shares of the living, every 0.5 s, for "was the victim the weakest 3 s before"
  const history: Map<number, number>[] = []
  let ticks = 0
  for (; ticks < 1500 * 60 && state.phase !== 'gameOver'; ticks++) {
    if (state.tick % 30 === 0) {
      history.push(new Map(state.pawns.filter((p) => p.alive).map((p) => [p.owner, p.hp / p.maxHp])))
      if (history.length > 6) history.shift()
    }
    step(state, bots.map((b) => ({ player: b.player, tick: state.tick, cmds: b.think(state) })))
    if (state.phase === 'fight') r.fightSeconds += 1 / 60
    for (const e of state.events) {
      if (e.type === 'roundWin') r.rounds++
      if (e.type !== 'death' || e.killer === null || e.killer === e.owner) continue
      r.kills++
      const then = history[0]
      const mine = then?.get(e.owner)
      if (mine !== undefined && [...then.values()].every((s) => mine <= s + 1e-9)) r.weakestKills++
    }
    if (state.phase !== 'fight' || state.tick % 30 !== 0) continue
    const alive = state.pawns.filter((p) => p.alive)
    if (alive.length < 3) continue
    r.samples++
    const on = new Map<number, number[]>()
    for (const b of bots) {
      const t = b.targetPlayer
      const me = alive.find((p) => p.owner === b.player)
      if (t === null || !me || !alive.some((p) => p.owner === t)) continue
      on.set(t, [...(on.get(t) ?? []), b.player])
    }
    let maxPile = 0
    for (const list of on.values()) {
      r.focusSum += list.length
      r.focusN++
      maxPile = Math.max(maxPile, list.length)
      // a mob: 4+ chasers of one player bunched within 450 of their centroid
      if (list.length >= 4) {
        const ps = list.map((id) => alive.find((p) => p.owner === id)!)
        const cx = ps.reduce((s, p) => s + p.x, 0) / ps.length
        const cy = ps.reduce((s, p) => s + p.y, 0) / ps.length
        if (ps.filter((p) => Math.hypot(p.x - cx, p.y - cy) < 450).length >= 4) r.mobSamples++
      }
    }
    r.maxFocusSum += maxPile
    let pd = 0
    let pn = 0
    for (let i = 0; i < alive.length; i++)
      for (let j = i + 1; j < alive.length; j++) {
        pd += Math.hypot(alive[i].x - alive[j].x, alive[i].y - alive[j].y)
        pn++
      }
    r.pairDistSum += pd / pn
  }
  r.seconds = ticks / 60
  return r
}

const jobs = NAMES.flatMap((l) => Array.from({ length: MATCHES }, (_, g) => ({ lineup: l, seed: SEED + g })))

if (SHARD) {
  const [k, n] = SHARD.split('/').map(Number)
  jobs.forEach((j, i) => {
    if (i % n === k) process.stdout.write(JSON.stringify(play(j.lineup, j.seed)) + '\n')
  })
} else {
  const results: Result[] = []
  const script = fileURLToPath(import.meta.url)
  const t0 = Date.now()
  await Promise.all(
    Array.from({ length: WORKERS }, (_, k) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn('npx', ['vite-node', script, '--', ...argv, '--shard', `${k}/${WORKERS}`], { stdio: ['ignore', 'pipe', 'inherit'] })
        let buf = ''
        child.stdout.on('data', (d: Buffer) => {
          buf += d.toString()
          let nl: number
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (line.startsWith('{')) results.push(JSON.parse(line))
          }
        })
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${k} exited with ${code}`))))
      }),
    ),
  )
  console.log(`8-bot FFA, ${MATCHES} matches per lineup, first to ${DEFAULT_SETTINGS.winScore} (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
  console.log('lineup   bots/target  biggest pile  mean dist  mob samples  kills on weakest  round s  rounds  capped')
  for (const l of NAMES) {
    const rs = results.filter((r) => r.lineup === l)
    const sum = (f: (r: Result) => number) => rs.reduce((s, r) => s + f(r), 0)
    const samples = sum((r) => r.samples)
    console.log(
      `${l.padEnd(8)} ${(sum((r) => r.focusSum) / sum((r) => r.focusN)).toFixed(2).padStart(11)}  ${(sum((r) => r.maxFocusSum) / samples).toFixed(2).padStart(12)}  ${(sum((r) => r.pairDistSum) / samples).toFixed(0).padStart(9)}  ${((100 * sum((r) => r.mobSamples)) / samples).toFixed(1).padStart(10)}%  ${((100 * sum((r) => r.weakestKills)) / sum((r) => r.kills)).toFixed(0).padStart(15)}%  ${(sum((r) => r.fightSeconds) / sum((r) => r.rounds)).toFixed(0).padStart(7)}  ${(sum((r) => r.rounds) / rs.length).toFixed(1).padStart(6)}  ${rs.filter((r) => r.seconds >= 1500).length}/${rs.length}`,
    )
  }
}
