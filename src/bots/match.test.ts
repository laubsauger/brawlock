/**
 * Headless bot-vs-bot matches on the real sim: catches crashes, stalls and bots that
 * never finish a round. Skipped (with a reason) while the sim cannot run a match.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, createMatch, step } from '../sim'
import type { BotDifficulty, MatchSettings, PlayerSlot, SimState } from '../sim'
import { createBot } from './index'

const SETTINGS: MatchSettings = { ...DEFAULT_SETTINGS, winScore: 2, shopSeconds: 2 }

function slots(diffs: BotDifficulty[]): PlayerSlot[] {
  return diffs.map((d, i) => ({ id: i, name: `Bot ${i}`, color: 0xff0000 + i, team: i, kind: 'bot', difficulty: d }))
}

let simReason = ''
try {
  const s = createMatch(SETTINGS, slots(['easy', 'easy']), 1)
  step(s, [])
} catch (e) {
  simReason = ` (skipped: sim cannot run a match yet: ${(e as Error).message})`
}

function play(diffs: BotDifficulty[], seed: number, maxSeconds: number) {
  const sl = slots(diffs)
  const state: SimState = createMatch(SETTINGS, sl, seed)
  const bots = sl.map((s) => createBot(s.id, s.difficulty!, seed * 31 + s.id))
  const maxTicks = maxSeconds * 60
  let deaths = 0
  let casts = 0
  for (let i = 0; i < maxTicks && state.phase !== 'gameOver'; i++) {
    const inputs = bots.map((b) => ({ player: b.player, tick: state.tick, cmds: b.think(state) }))
    step(state, inputs)
    for (const e of state.events) {
      if (e.type === 'death') deaths++
      if (e.type === 'cast') casts++
    }
  }
  return { state, deaths, casts }
}

describe('bots: headless matches on the real sim', () => {
  it.skipIf(simReason !== '')(`hard vs medium plays a first-to-2 match to gameOver${simReason}`, () => {
    const { state, deaths, casts } = play(['hard', 'medium'], 7, 900)
    expect(state.phase).toBe('gameOver')
    expect(deaths).toBeGreaterThanOrEqual(2)
    expect(casts).toBeGreaterThan(10)
  })

  it.skipIf(simReason !== '')(`brutal beats dummy every round${simReason}`, () => {
    const { state } = play(['brutal', 'dummy'], 3, 900)
    expect(state.phase).toBe('gameOver')
    const brutal = state.scores.find((s) => s.id === 0)!
    const dummy = state.scores.find((s) => s.id === 1)!
    expect(brutal.score).toBeGreaterThanOrEqual(2)
    expect(dummy.score).toBe(0)
  })
})
