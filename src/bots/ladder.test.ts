/**
 * Regression guard for the calibrated difficulty ladder (docs/PLAN.md §7). The full rating is
 * `npm run bots:elo` (scripts/bots/elo.ts); this replays a few of its seeded 1v1 matches.
 *
 * The unit is the round, the unit a player feels. Hard, Brutal and Uber are tuned to about 75%
 * round win rate per step: a player who beats one tier most of the time can still take rounds
 * off the next one. A tweak that makes a top step a near-sweep again (as it was before, 85-96%)
 * or erases it fails here. Easy and Medium are meant for new players, so the gaps below Hard stay
 * wide on purpose.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, createMatch, step } from '../sim'
import type { BotDifficulty, PlayerSlot } from '../sim'
import { BOT_ELO, createBot } from './index'
import { expectedScore } from './rating'

/** share of decided rounds `strong` wins over seeded first-to-5 matches, sides swapped */
function roundShare(strong: BotDifficulty, weak: BotDifficulty, seeds: number): number {
  let won = 0
  let lost = 0
  for (let seed = 1; seed <= seeds; seed++) {
    const diffs = seed % 2 ? [strong, weak] : [weak, strong]
    const sl: PlayerSlot[] = diffs.map((d, id) => ({ id, name: d, color: 0xff0000 + id, team: id, kind: 'bot', difficulty: d }))
    const state = createMatch({ ...DEFAULT_SETTINGS }, sl, seed)
    const bots = sl.map((s) => createBot(s.id, s.difficulty!, seed * 31 + s.id))
    for (let i = 0; i < 1500 * 60 && state.phase !== 'gameOver'; i++) {
      step(state, bots.map((b) => ({ player: b.player, tick: state.tick, cmds: b.think(state) })))
    }
    expect(state.phase, `${strong} vs ${weak} seed ${seed} never finished`).toBe('gameOver')
    const me = diffs.indexOf(strong)
    won += state.scores.find((s) => s.id === me)!.score
    lost += state.scores.find((s) => s.id === 1 - me)!.score
  }
  return won / (won + lost)
}

describe('bots: calibrated difficulty ladder', () => {
  it('Uber beats Brutal in about 75% of rounds', () => {
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

  it('BOT_ELO describes the measured round shares, with Medium anchored at 1000', () => {
    expect(BOT_ELO.medium).toBe(1000)
    const tiers = ['easy', 'medium', 'hard', 'brutal', 'uber'] as const
    for (let i = 1; i < tiers.length; i++) expect(BOT_ELO[tiers[i]]).toBeGreaterThan(BOT_ELO[tiers[i - 1]])
    // Independent 200-match measurements, seeds 1–200, recorded in
    // docs/research/bot-calibration-2026-10-20.json. Labels describe observed
    // strength; the target 75% gaps above are a separate balancing objective.
    for (const [hi, lo, wins, losses] of [
      ['medium', 'easy', 1000, 23],
      ['hard', 'medium', 1000, 24],
      ['brutal', 'hard', 867, 556],
      ['uber', 'brutal', 941, 380],
    ] as const) {
      const predicted = expectedScore(BOT_ELO[hi], BOT_ELO[lo])
      const measured = wins / (wins + losses)
      expect(Math.abs(predicted - measured), `${hi} over ${lo}`).toBeLessThan(0.05)
    }
  })
})
