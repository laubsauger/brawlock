import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, createMatch, step } from '../sim'
import { onHill } from '../sim/hill'
import { TICK_HZ } from '../sim/types'
import { BOT_PRESETS, BotController } from './index'

/** Bots play a hill match: the share of fight ticks with a bot on the hill. */
function play(drive: boolean, seconds: number) {
  const settings = { ...DEFAULT_SETTINGS, gameMode: 'hill' as const, winScore: 999, shopSeconds: 3, hillRespawn: true }
  const slots = [0, 1, 2, 3].map((id) => ({ id, name: `B${id}`, color: 0, team: id, kind: 'bot' as const, difficulty: 'hard' as const }))
  const state = createMatch(settings, slots, 7)
  const params = { ...BOT_PRESETS.hard, hillDrive: drive ? BOT_PRESETS.hard.hillDrive : 0 }
  const bots = slots.map((s) => new BotController(s.id, 'hard', 70 + s.id, params))
  let fight = 0
  let occupied = 0
  for (let i = 0; i < seconds * TICK_HZ && state.phase !== 'gameOver'; i++) {
    step(state, bots.map((b) => ({ player: b.player, tick: state.tick, cmds: b.think(state) })))
    if (state.phase !== 'fight') continue
    fight++
    if (state.pawns.some((p) => p.alive && onHill(state, p.x, p.y))) occupied++
  }
  return { occupied: occupied / Math.max(1, fight) }
}

describe('bots in King of the Hill', () => {
  it('go for the hill: someone stands on it most of the fight, far more than bots that ignore it', () => {
    const hill = play(true, 60)
    const blind = play(false, 60)
    expect(hill.occupied).toBeGreaterThan(0.6)
    expect(hill.occupied).toBeGreaterThan(blind.occupied + 0.15)
  }, 20_000)
})
