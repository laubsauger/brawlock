/**
 * Elo by maximum likelihood (Bradley–Terry) for the bot difficulty ladder
 * (scripts/bots/elo.ts, docs/PLAN.md §7).
 *
 * P(i beats j) = 1 / (1 + 10^((Rj - Ri) / 400)). All games are fitted at once (no sequential
 * updates, so game order does not matter). One player is the anchor (fixed rating); the 95%
 * intervals come from the Fisher information and are relative to that anchor.
 *
 * A perfect record (40-0) has no finite maximum. `priorDraws` adds that many virtual draws to
 * every pair that played (as BayesElo does), which keeps such ratings finite: they then read
 * as "at least this far apart", not as a measurement.
 */
import { exp, pow } from '../sim/math'

export interface PairRecord {
  a: string
  b: string
  /** games a won */
  winsA: number
  /** games b won */
  winsB: number
  draws: number
}

export interface Rating {
  elo: number
  /** half-width of the 95% interval, Elo (0 for the anchor) */
  ci95: number
}

const ELO_PER_NAT = 400 / Math.LN10

export function bradleyTerry(
  players: string[],
  records: PairRecord[],
  anchor: string,
  anchorElo = 1000,
  priorDraws = 1,
): Record<string, Rating> {
  const n = players.length
  const idx = new Map(players.map((p, i) => [p, i]))
  const a0 = idx.get(anchor)
  if (a0 === undefined) throw new Error(`anchor ${anchor} is not a player`)
  // games[i][j] and score[i][j] (wins + half the draws, plus the prior)
  const games = players.map(() => new Array<number>(n).fill(0))
  const score = players.map(() => new Array<number>(n).fill(0))
  for (const r of records) {
    const i = idx.get(r.a)
    const j = idx.get(r.b)
    if (i === undefined || j === undefined) throw new Error(`unknown player in ${r.a} vs ${r.b}`)
    const total = r.winsA + r.winsB + r.draws
    if (total === 0) continue
    games[i][j] += total
    games[j][i] += total
    score[i][j] += r.winsA + r.draws / 2
    score[j][i] += r.winsB + r.draws / 2
  }
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      if (i !== j && games[i][j] > 0) {
        games[i][j] += priorDraws
        score[i][j] += priorDraws / 2
      }

  const free = players.map((_, i) => i).filter((i) => i !== a0)
  const theta = new Array<number>(n).fill(0)
  let info: number[][] = []
  for (let iter = 0; iter < 200; iter++) {
    const grad = new Array<number>(n).fill(0)
    const hess = players.map(() => new Array<number>(n).fill(0))
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        if (i === j || games[i][j] === 0) continue
        const p = 1 / (1 + exp(theta[j] - theta[i]))
        grad[i] += score[i][j] - games[i][j] * p
        const w = games[i][j] * p * (1 - p)
        hess[i][i] += w
        hess[i][j] -= w
      }
    info = free.map((i) => free.map((j) => hess[i][j]))
    const step = solve(
      info,
      free.map((i) => grad[i]),
    )
    let biggest = 0
    free.forEach((i, k) => {
      // damped Newton: a near-separable record can propose huge steps
      const d = Math.max(-2, Math.min(2, step[k]))
      theta[i] += d
      biggest = Math.max(biggest, Math.abs(d))
    })
    if (biggest < 1e-10) break
  }
  const cov = invert(info)
  const out: Record<string, Rating> = {}
  players.forEach((p, i) => {
    const k = free.indexOf(i)
    out[p] = {
      elo: anchorElo + ELO_PER_NAT * (theta[i] - theta[a0]),
      ci95: k < 0 ? 0 : 1.96 * ELO_PER_NAT * Math.sqrt(Math.max(0, cov[k][k])),
    }
  })
  return out
}

/** Expected score of a player rated `ra` against one rated `rb`. */
export function expectedScore(ra: number, rb: number): number {
  return 1 / (1 + pow(10, (rb - ra) / 400))
}

/** Wilson 95% interval for a win share (draws count half). */
export function wilson(score: number, games: number): [number, number] {
  if (games === 0) return [0, 1]
  const z = 1.96
  const p = score / games
  const d = 1 + (z * z) / games
  const c = (p + (z * z) / (2 * games)) / d
  const h = (z * Math.sqrt((p * (1 - p)) / games + (z * z) / (4 * games * games))) / d
  return [Math.max(0, c - h), Math.min(1, c + h)]
}

function solve(m: number[][], b: number[]): number[] {
  const n = b.length
  const a = m.map((row, i) => [...row, b[i]])
  for (let c = 0; c < n; c++) {
    let piv = c
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r
    ;[a[c], a[piv]] = [a[piv], a[c]]
    if (Math.abs(a[c][c]) < 1e-300) throw new Error('singular information matrix: some player has no games')
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = a[r][c] / a[c][c]
      for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k]
    }
  }
  return a.map((row, i) => row[n] / row[i])
}

function invert(m: number[][]): number[][] {
  return m.map((_, j) => solve(m, m.map((__, i) => (i === j ? 1 : 0)))).map((_, i, cols) => cols.map((col) => col[i]))
}
