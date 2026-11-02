import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BotController } from '../../bots/controller'
import { ticks } from '../../sim/config'
import { setTickRate, TICK_HZ, type SimEvent, type TickRate } from '../../sim/types'
import { LAUNCH_DAY, RULES_V2_FROM, defineDay } from './calendar'
import { DAILY_HZ, DailyRun } from './run'
import { TapeRecorder } from './tape'
import { verify } from './verify'

/**
 * The daily run (docs/moonshot/specs/daily.md): only the wave's bots fight, a loss replays the wave
 * at the cost of a life, the clock counts fights only, and the bounty is the hit that caused the
 * knockout. A server must get the same score from the tape alone.
 */
let rate: TickRate
beforeEach(() => {
  rate = TICK_HZ
  setTickRate(DAILY_HZ)
})
afterEach(() => setTickRate(rate))

const PLAYER = { name: 'you', color: 0xff7700 }
const day = defineDay(LAUNCH_DAY + 1)
const toFight = (run: DailyRun) => {
  for (let i = 0; i < ticks(30) && run.state.phase !== 'fight'; i++) run.tick(run.state.phase === 'shop' ? [{ kind: 'shopReady', ready: true }] : [])
}
const pawnOf = (run: DailyRun, owner: number) => run.state.pawns.find((p) => p.owner === owner)!
/** one bookkept tick with crafted events (the state edited as the sim would leave it) */
const tick = (run: DailyRun, events: SimEvent[] = []) => {
  run.state.tick++
  run.observe(events)
}

describe('daily run', () => {
  it('seats only the wave: the first fight is you against one Easy bot', () => {
    const run = new DailyRun(day, 7, PLAYER)
    toFight(run)
    expect(run.state.phase).toBe('fight')
    const alive = run.state.pawns.filter((p) => p.alive).map((p) => p.owner).sort()
    expect(alive).toEqual([0, day.waves[0][0].seat])
  })

  it('Ready ends the shop within a few seconds, and shops add nothing to the clock', () => {
    const run = new DailyRun(day, 7, PLAYER)
    const t0 = run.state.tick
    toFight(run)
    expect(run.state.tick - t0).toBeLessThan(ticks(7))
    expect(run.clockTicks).toBeLessThanOrEqual(1)
  })

  it('a lost round costs a life and replays the wave; the second loss ends the run', () => {
    const run = new DailyRun(day, 7, PLAYER)
    toFight(run)
    tick(run, [{ type: 'roundWin', team: 1, players: [day.waves[0][0].seat] }])
    expect([run.lives, run.wave, run.ended]).toEqual([1, 0, null])
    tick(run, [{ type: 'roundWin', team: -1, players: [] }])
    expect([run.lives, run.ended]).toEqual([0, 'lost'])
  })

  it('a cleared wave seats the next; time stops at the last clear; five clears end it', () => {
    const run = new DailyRun(day, 7, PLAYER)
    toFight(run)
    for (let i = 0; i < ticks(10); i++) tick(run)
    tick(run, [{ type: 'roundWin', team: 0, players: [0] }])
    expect(run.wave).toBe(1)
    const timeAtClear = run.result().timeTicks
    for (let i = 0; i < ticks(5); i++) tick(run)
    expect(run.result().timeTicks).toBe(timeAtClear)
    for (let w = 1; w < 5; w++) tick(run, [{ type: 'roundWin', team: 0, players: [0] }])
    expect(run.ended).toBe('cleared')
    expect(run.result().waves).toBe(5)
  })

  it('a lava death after a bounty push counts; a later push with another spell takes it over', () => {
    for (const later of [false, true]) {
      const run = new DailyRun(day, 7, PLAYER)
      toFight(run)
      const bot = day.waves[0][0].seat
      const v = pawnOf(run, bot)
      const hit = (cause: string): SimEvent => ({ type: 'damage', target: v.id, amount: 40, source: 0, x: v.x, y: v.y, kb: 900, cause })
      v.vx = 900
      v.walkVx = 0
      tick(run, [hit(day.bounty)])
      for (let i = 0; i < ticks(0.3); i++) tick(run)
      v.lavaTicks = 1
      v.vx = 0
      if (later) {
        v.vx = 600
        tick(run, [hit(day.bounty === 'fireball' ? 'lightning' : 'fireball')])
      }
      for (let i = 0; i < ticks(2); i++) tick(run)
      v.alive = false
      tick(run, [{ type: 'death', pawn: v.id, owner: bot, killer: 0, cause: 'lava', x: v.x, y: v.y }])
      expect(run.bountyKos, later ? 'replaced' : 'counted').toBe(later ? 0 : 1)
    }
  })
})

/**
 * Why: under rules 1 the bounty needed the sealing hit, so a Snowball rolling a warlock into the lava
 * (a drag, no hit) never paid (playtest 2026-11-02). Rules 2: the bounty spell touched it, by a hit
 * or a Snowball's chill, in the 4 s before it went down, however it went down.
 */
describe('daily bounty, rules 2', () => {
  const snowDay = { ...defineDay(RULES_V2_FROM + 2), bounty: 'snowball' }
  const down = (run: DailyRun, owner: number, pawn: number) => tick(run, [{ type: 'death', pawn, owner, killer: null, cause: 'lava', x: 0, y: 0 }])

  it('a Snowball chill, then the lava within 4 s, pays the bounty; after 4 s, or from someone else, it does not', () => {
    for (const [wait, source, pays] of [[3, 0, true], [5, 0, false], [3, 1, false]] as const) {
      const run = new DailyRun(snowDay, 7, PLAYER)
      toFight(run)
      const bot = snowDay.waves[0][0].seat
      const v = pawnOf(run, bot)
      tick(run, [{ type: 'modifier', pawn: v.id, id: 'snowball', on: true, source }])
      for (let i = 0; i < ticks(wait); i++) tick(run)
      down(run, bot, v.id)
      expect(run.bountyKos, `${wait} s, source ${source}`).toBe(pays ? 1 : 0)
    }
  })

  it('a bounty hit still counts when another spell pushes it in afterwards', () => {
    const run = new DailyRun({ ...snowDay, bounty: 'homing' }, 7, PLAYER)
    toFight(run)
    const bot = snowDay.waves[0][0].seat
    const v = pawnOf(run, bot)
    const hit = (cause: string): SimEvent => ({ type: 'damage', target: v.id, amount: 30, source: 0, x: 0, y: 0, kb: 700, cause })
    tick(run, [hit('homing')])
    for (let i = 0; i < ticks(1); i++) tick(run)
    tick(run, [hit('fireball')])
    for (let i = 0; i < ticks(1); i++) tick(run)
    down(run, bot, v.id)
    expect(run.bountyKos).toBe(1)
  })
})

describe('daily verification', () => {
  /** a Hard bot plays seat 0 for at most `seconds`; the tape and the run's own result */
  const playAndRecord = (salt: number, seconds: number) => {
    const run = new DailyRun(day, salt, PLAYER)
    const me = new BotController(0, 'hard', 99)
    const tape = new TapeRecorder(day.day, 'test')
    while (!run.ended && run.wave < 1 && run.state.tick < ticks(seconds)) {
      const cmds = me.think(run.state)
      tape.record(run.state.tick, cmds)
      run.tick(cmds)
    }
    const abandoned = !run.ended
    if (abandoned) run.abandon()
    return { tape: tape.finish(run.state.tick, abandoned), result: run.result() }
  }

  it('the tape alone gives the same score, and another salt does not give the same run', () => {
    const a = playAndRecord(11, 60)
    const v = verify({ day: day.day, salt: 11, tape: JSON.parse(JSON.stringify(a.tape)) })
    if (!v.ok) throw new Error(v.reason)
    expect([v.waves, v.timeTicks, v.endTick]).toEqual([a.result.waves, a.result.timeTicks, a.result.endTick])
    const other = verify({ day: day.day, salt: 12, tape: a.tape })
    const again = verify({ day: day.day, salt: 11, tape: a.tape })
    if (!other.ok || !again.ok) throw new Error('verify failed')
    expect(again.hash).toBe(v.hash)
    expect(other.hash).not.toBe(v.hash)
  })

  it('rejects malformed, overlong and overfull tapes, and the wrong day', () => {
    const base = { v: 1, day: day.day, dailyId: 'test', entries: [], end: 10, abandoned: true }
    expect(verify({ day: day.day, salt: 1, tape: 'nope' })).toMatchObject({ ok: false })
    expect(verify({ day: day.day, salt: 1, tape: { ...base, end: ticks(601) } })).toMatchObject({ ok: false, reason: 'too long' })
    expect(verify({ day: day.day, salt: 1, tape: { ...base, entries: [[0, ...Array(17).fill(['s'])]] } })).toMatchObject({ ok: false })
    expect(verify({ day: day.day, salt: 1, tape: { ...base, entries: [[-1, ['s']]] } })).toMatchObject({ ok: false, reason: 'malformed' })
    expect(verify({ day: day.day + 1, salt: 1, tape: base })).toMatchObject({ ok: false, reason: 'wrong day' })
  })
})
