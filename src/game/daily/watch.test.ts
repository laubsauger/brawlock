import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BotController } from '../../bots/controller'
import { hashState } from '../../sim/snapshot'
import { setTickRate, TICK_HZ, type TickRate } from '../../sim/types'
import { ReplayPlayer } from '../replay/player'
import { LAUNCH_DAY, defineDay } from './calendar'
import { DAILY_HZ, DailyRun } from './run'
import { TapeRecorder } from './tape'
import { dailyReplay } from './watch'

let rate: TickRate
beforeEach(() => {
  rate = TICK_HZ
  setTickRate(DAILY_HZ)
})
afterEach(() => setTickRate(rate))

/**
 * Why: Watch on the board and on your result replays a run from its tape. The director seats each
 * wave between steps, which a replay cannot step into, so the replay must carry those states or it
 * desyncs at the first cleared wave.
 */
describe('daily Watch', () => {
  it('a run becomes a replay that plays to the same end, across a cleared wave, without desync', () => {
    const day = LAUNCH_DAY + 4
    const run = new DailyRun(defineDay(day), 77, { name: 'you', color: 0xff7700 })
    const me = new BotController(0, 'brutal', 5)
    const tape = new TapeRecorder(day, 'test')
    let cleared = -1
    while (!run.ended && run.state.tick < 120 * DAILY_HZ && (cleared < 0 || run.state.tick < cleared + 10 * DAILY_HZ)) {
      const cmds = me.think(run.state)
      tape.record(run.state.tick, cmds)
      run.tick(cmds)
      if (cleared < 0 && run.wave > 0) cleared = run.state.tick
    }
    expect(run.wave).toBeGreaterThan(0)
    const d = dailyReplay({ day, salt: 77, tape: tape.finish(run.state.tick, !run.ended), id: 'a1', date: 0, netId: 'n', player: { name: 'you', color: 0xff7700 } })!
    expect(d.resyncs.length).toBeGreaterThan(0)
    const p = new ReplayPlayer(d, 'n')
    while (!p.done) p.stepOnce()
    expect(p.desync).toBeNull()
    expect(hashState({ ...p.state, events: [] })).toBe(hashState({ ...run.state, events: [] }))
  })
})
