import { describe, expect, it } from 'vitest'
import { TICK_HZ } from '../sim/types'
import { BotController } from './controller'
import { makePawn, makeState } from './fixtures'

describe('bot scheduled decisions', () => {
  it('exposes an order before execution and releases exactly that order at its planned tick', () => {
    const state = makeState([makePawn(0, 0, 0), makePawn(1, 900, 0)])
    const bot = new BotController(0, 'hard', 1)
    expect(bot.think(state)).toEqual([])
    const [planned] = bot.scheduled()
    expect(planned.cmds.length).toBeGreaterThan(0)
    expect(planned.at).toBe(Math.round(bot.params.reactionDelay * TICK_HZ))
    for (let tick = 1; tick < planned.at; tick++) {
      state.tick = tick
      expect(bot.think(state)).toEqual([])
    }
    state.tick = planned.at
    expect(bot.think(state)).toEqual(planned.cmds)
    expect(bot.scheduled().some((frame) => frame.at === planned.at)).toBe(false)
    // A retained schedule remains valid after the live queue releases the order.
    expect(planned.cmds.length).toBeGreaterThan(0)
  })

  it('does not let consumers mutate queued commands', () => {
    const state = makeState([makePawn(0, 0, 0), makePawn(1, 900, 0)])
    const bot = new BotController(0, 'hard', 1)
    bot.think(state)
    const [snapshot] = bot.scheduled()
    const original = structuredClone(snapshot)
    const command = snapshot.cmds[0]
    if (command.kind === 'move' || command.kind === 'cast') command.x = 99999
    snapshot.cmds.push({ kind: 'stop' })
    snapshot.at = 99999
    expect(bot.scheduled()[0]).toEqual(original)
  })

  it('clears old plans on rewind and game over', () => {
    const state = makeState([makePawn(0, 0, 0), makePawn(1, 900, 0)], { tick: 100 })
    const bot = new BotController(0, 'hard', 1)
    bot.think(state)
    expect(bot.scheduled()[0].at).toBeGreaterThan(100)
    state.tick = 0
    bot.think(state)
    expect(bot.scheduled().length).toBeGreaterThan(0)
    expect(bot.scheduled().every((frame) => frame.at < 100)).toBe(true)
    state.phase = 'gameOver'
    state.tick = 1
    bot.think(state)
    expect(bot.scheduled()).toEqual([])
  })
})
