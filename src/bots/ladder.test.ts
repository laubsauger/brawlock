/**
 * Regression guard for the calibrated difficulty ladder (docs/PLAN.md §7). The full rating is
 * `npm run bots:elo` (scripts/bots/elo.ts); this replays a few of its seeded 1v1 matches.
 *
 * The unit is the round, the unit a player feels. Hard, Brutal and Uber are tuned to about 75%
 * round win rate per step (measured: Brutal 77% over Hard, Uber 69% over Brutal): a player who beats one tier most of the time can still take rounds
 * off the next one. A tweak that makes a top step a near-sweep again (as it was before, 85-96%)
 * or erases it fails here. Easy and Medium are meant for new players, so the gaps below Hard stay
 * wide on purpose.
 *
 * The replays play dozens of full first-to-5 matches (about 5 s), so they only run with
 * `LADDER=1 npx vitest run src/bots/ladder.test.ts`: do that after any change to src/bots that
 * can move bot strength (presets, decisions, aim, dodging, shopping).
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, createMatch, step, ticks } from '../sim'
import type { BotDifficulty, PlayerSlot } from '../sim'
import { BOT_ELO, createBot } from './index'
import { expectedScore } from './rating'
// the measurement BOT_ELO is rounded from (presets.ts); a preset change that moves a step needs a new one
import calibrationJson from '../../docs/research/bot-calibration-2026-10-26-windups.json?raw'

const LADDER = !!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.LADDER

/** share of decided rounds `strong` wins over seeded first-to-5 matches, sides swapped */
function roundShare(strong: BotDifficulty, weak: BotDifficulty, seeds: number): number {
  let won = 0
  let lost = 0
  for (let seed = 1; seed <= seeds; seed++) {
    const diffs = seed % 2 ? [strong, weak] : [weak, strong]
    const sl: PlayerSlot[] = diffs.map((d, id) => ({ id, name: d, color: 0xff0000 + id, team: id, kind: 'bot', difficulty: d }))
    const state = createMatch({ ...DEFAULT_SETTINGS }, sl, seed)
    const bots = sl.map((s) => createBot(s.id, s.difficulty!, seed * 31 + s.id))
    for (let i = 0; i < ticks(1500) && state.phase !== 'gameOver'; i++) {
      step(state, bots.map((b) => ({ player: b.player, tick: state.tick, cmds: b.think(state) })))
    }
    expect(state.phase, `${strong} vs ${weak} seed ${seed} never finished`).toBe('gameOver')
    const me = diffs.indexOf(strong)
    won += state.scores.find((s) => s.id === me)!.score
    lost += state.scores.find((s) => s.id === 1 - me)!.score
  }
  return won / (won + lost)
}

describe.runIf(LADDER)('bots: calibrated difficulty ladder (LADDER=1)', () => {
  it('Uber stays clearly above Brutal', () => {
    // Measured 69% of rounds (400 matches; 65% on these 16 seeds). Widening Hard–Brutal took
    // part of Uber's lead (64%), and Uber taking openings at Brutal's rate won a little back.
    // It is still the narrower top step, so the floor is 60%: an erased step fails.
    const share = roundShare('uber', 'brutal', 16)
    expect(share).toBeGreaterThanOrEqual(0.6)
    expect(share).toBeLessThanOrEqual(0.88)
  }, 20_000)

  it('Brutal beats Hard in about 75% of rounds', () => {
    const share = roundShare('brutal', 'hard', 16)
    expect(share).toBeGreaterThanOrEqual(0.6)
    expect(share).toBeLessThanOrEqual(0.88)
  }, 20_000)

  it('the beginner tiers stay far below: Medium beats Easy and Hard beats Medium almost every round', () => {
    expect(roundShare('medium', 'easy', 4)).toBeGreaterThanOrEqual(0.9)
    expect(roundShare('hard', 'medium', 4)).toBeGreaterThanOrEqual(0.9)
  }, 20_000)
})

describe('bots: difficulty labels', () => {
  it('BOT_ELO describes the measured round shares, with Medium anchored at 1000', () => {
    expect(BOT_ELO.medium).toBe(1000)
    const tiers = ['easy', 'medium', 'hard', 'brutal', 'uber'] as const
    for (let i = 1; i < tiers.length; i++) expect(BOT_ELO[tiers[i]]).toBeGreaterThan(BOT_ELO[tiers[i - 1]])
    // independent 400-match measurements of each neighbouring pair
    const { pairs } = (JSON.parse(calibrationJson) as { duels: { pairs: { a: string; b: string; winsA: number; winsB: number }[] } }).duels
    for (let i = 1; i < tiers.length; i++) {
      const [lo, hi] = [tiers[i - 1], tiers[i]]
      const pair = pairs.find((p) => (p.a === lo && p.b === hi) || (p.a === hi && p.b === lo))
      expect(pair, `${hi} over ${lo} measured`).toBeDefined()
      const wins = pair!.a === hi ? pair!.winsA : pair!.winsB
      const losses = pair!.a === hi ? pair!.winsB : pair!.winsA
      const predicted = expectedScore(BOT_ELO[hi], BOT_ELO[lo])
      expect(Math.abs(predicted - wins / (wins + losses)), `${hi} over ${lo}`).toBeLessThan(0.05)
    }
  })
})
