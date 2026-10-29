import { describe, expect, it } from 'vitest'
import { TICK_HZ, type BotDifficulty, type InputCommand, type PlayerId, type SimState } from '../sim/types'
import { MENU_BATTLE_SETTINGS } from '../render/menuStage'
import { makeFireball, makePawn, makeState } from './fixtures'
import { MotionMeter, emptyMotion, mergeMotion, meterBotMatch, motionBefore, sameTickRatio, summarizeMotion, type MotionCounts } from './motion'
import { BOT_PRESETS } from './presets'
// the strong humans the gates come from (scripts/bots/replay-motion.ts over recorded matches)
import humanJson from '../../docs/research/human-motion-2026-10-29.json?raw'

/**
 * Crafted tracks pin each measure to what it is for (docs/moonshot/specs/bot-motion.md, "The
 * plausibility metric"): turning around for nothing is the defect, walking somewhere is not.
 */
const SPEED = 210

/** Walk player 0 along `heading(t)` (a unit vector, or null to stand) for `seconds`, metering each tick. */
function walk(meter: MotionMeter, s: SimState, seconds: number, heading: (t: number) => { x: number; y: number } | null, orders: (t: number) => InputCommand[] = () => [], each?: (t: number) => void) {
  const me = s.pawns[0]
  for (let t = 0; t < seconds * TICK_HZ; t++) {
    each?.(t)
    const before = motionBefore(s)
    const h = heading(t)
    me.walkVx = h ? h.x * SPEED : 0
    me.walkVy = h ? h.y * SPEED : 0
    me.x += me.walkVx / TICK_HZ
    me.y += me.walkVy / TICK_HZ
    s.tick++
    meter.tick(before, [{ player: 0, tick: before.tick, cmds: orders(t) }], s)
  }
}
const east = { x: 1, y: 0 }
const west = { x: -1, y: 0 }
const fresh = () => makeState([makePawn(0, 0, 0)])

describe('motion meter', () => {
  it('a straight walk has no reversals; a stop, turn and go is one', () => {
    const meter = new MotionMeter()
    const s = fresh()
    walk(meter, s, 2, () => east)
    expect(meter.counts(0).reversals).toBe(0)
    // stand 0.3 s, then walk back: within 0.6 s of the last walking tick, so it counts once
    walk(meter, s, 1, (t) => (t < 0.3 * TICK_HZ ? null : west))
    expect(meter.counts(0).reversals).toBe(1)
    // a pause longer than the window is a new walk, not a reversal
    walk(meter, s, 1, (t) => (t < 0.8 * TICK_HZ ? null : east))
    expect(meter.counts(0).reversals).toBe(1)
  })

  it('a ping-pong second is dither: orders, walking, and no ground gained', () => {
    const meter = new MotionMeter()
    const s = fresh()
    const step = Math.round(TICK_HZ / 6)
    // six orders a second, alternating east and west
    walk(meter, s, 3, (t) => (Math.floor(t / step) % 2 ? west : east), (t) => (t % step === 0 ? [{ kind: 'move', x: s.pawns[0].x + (Math.floor(t / step) % 2 ? -300 : 300), y: 0 }] : []))
    const m = summarizeMotion(meter.counts(0))
    expect(m.dither).toBe(1)
    expect(m.clickFlip).toBe(1) // every consecutive pair points the other way
    // the same order rate walking somewhere is not dither
    const straight = new MotionMeter()
    const s2 = fresh()
    walk(straight, s2, 3, () => east, (t) => (t % step === 0 ? [{ kind: 'move', x: s2.pawns[0].x + 300, y: 0 }] : []))
    expect(summarizeMotion(straight.counts(0)).dither).toBe(0)
    expect(summarizeMotion(straight.counts(0)).clickFlip).toBe(0)
  })

  it('a reversal under a bolt is threatened, not free: dodging is the fight, not the dance', () => {
    const meter = new MotionMeter()
    const s = makeState([makePawn(0, 0, 0), makePawn(1, 2000, 2000)])
    walk(meter, s, 1, () => east)
    // an enemy Fireball flies at us; we turn back while it is near
    s.projectiles.push(makeFireball(1, s.pawns[0].x + 400, 0, -900, 0))
    walk(meter, s, 0.5, () => west)
    const c = meter.counts(0)
    expect(c.reversals).toBe(1)
    expect(c.freeReversals).toBe(0)
    // the same turn with no bolt around (for longer than the 0.4 s it is remembered) is free
    s.projectiles.length = 0
    walk(meter, s, 0.5, () => west)
    walk(meter, s, 1, () => east)
    expect(meter.counts(0).freeReversals).toBe(1)
  })

  it('meters only alive fight time', () => {
    const meter = new MotionMeter()
    const s = fresh()
    s.phase = 'shop'
    walk(meter, s, 1, () => east)
    expect(meter.counts(0).seconds).toBe(0)
    s.phase = 'fight'
    s.pawns[0].alive = false
    walk(meter, s, 1, () => east)
    expect(meter.counts(0).seconds).toBe(0)
  })

  it('the same-tick ratio tells a shared think clock from independent ones', () => {
    const s = makeState([makePawn(0, 0, 0), makePawn(1, 500, 0)])
    const decide = (clock: (id: PlayerId, t: number) => boolean) => {
      const meter = new MotionMeter()
      for (let t = 0; t < 30 * TICK_HZ; t++) {
        const before = motionBefore(s)
        s.tick++
        meter.tick(before, [], s, new Set([0, 1].filter((id) => clock(id, t))))
      }
      return sameTickRatio(meter.sameTick('hard')!)
    }
    const every = Math.round(TICK_HZ / 10)
    // lockstep: both on every tenth of a second
    expect(decide((_, t) => t % every === 0)).toBeCloseTo(every, 5)
    // offset clocks of the same rate never coincide
    expect(decide((id, t) => (t + id) % every === 0)).toBe(0)
    // coprime periods meet only as often as chance
    expect(decide((id, t) => t % (id ? 3 : 4) === 0)).toBeCloseTo(1, 1)
  })
})

const LADDER = !!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.LADDER

/**
 * Bots move inside the strong-human band (docs/moonshot/specs/bot-motion.md, thresholds). Seeded
 * bot-only matches, so it is gated like the ladder: `LADDER=1 npx vitest run src/bots/motion.test.ts`
 * after any change that can move how bots order their walking.
 */
describe.skipIf(!LADDER)('bots move like players (LADDER=1)', () => {
  /** per tier: the upper gates, from the strong humans' top match (BeFlat, Laub) */
  const GATE = {
    ordersPerSecond: 6, // humans 5.8
    reversalsPerSecond: 0.35, // 0.33
    dither: 0.09, // 0.088
    flipsPerSecond: 0.35, // 0.31
    // the dance itself; humans reach 0.15-0.20 in single matches, so this is no human top
    freeReversalsPerSecond: 0.12,
  }

  it('the gates sit at or above the strong humans measured on the same meter', () => {
    const human = JSON.parse(humanJson) as { players: Record<string, { ranges: Record<string, [number, number]> }> }
    for (const name of ['BeFlat', 'Laub']) {
      for (const k of ['ordersPerSecond', 'reversalsPerSecond', 'dither', 'flipsPerSecond'] as const) {
        expect(GATE[k], `${k} gate under ${name}'s top match`).toBeGreaterThanOrEqual(human.players[name].ranges[k][1])
      }
    }
  })

  it('in 4-player FFA every tier turns around, dithers and flips no more than strong humans', () => {
    const tiers: BotDifficulty[] = ['medium', 'hard', 'brutal', 'uber']
    const pooled = new Map<BotDifficulty, MotionCounts>()
    for (let m = 0; m < tiers.length; m++) {
      const seats = [...tiers.slice(m), ...tiers.slice(0, m)].map((difficulty) => ({ difficulty }))
      // ten minutes of each match: about 2000 alive fight-seconds per tier in all
      const { meter } = meterBotMatch(seats, { teamMode: 'ffa' }, 1 + m, undefined, 600)
      seats.forEach((s, id) => pooled.set(s.difficulty, mergeMotion(pooled.get(s.difficulty) ?? emptyMotion(), meter.counts(id))))
    }
    const misses: string[] = []
    for (const [tier, c] of pooled) {
      const s = summarizeMotion(c)
      for (const k of Object.keys(GATE) as (keyof typeof GATE)[]) if (s[k] > GATE[k]) misses.push(`${tier} ${k} ${s[k].toFixed(3)} > ${GATE[k]}`)
      // the click rhythm of a fast player; Medium thinks every 0.35 s and clicks like a slow one
      if (BOT_PRESETS[tier].thinkInterval <= 0.15) {
        const [p10, p50, p90] = s.moveGaps
        if (p10 < 0.06 || p50 < 0.08 || p50 > 0.2 || p90 < 0.25 || p90 > 0.6) misses.push(`${tier} move gaps ${s.moveGaps.map((g) => g.toFixed(2)).join('/')}`)
      }
    }
    expect(misses).toEqual([])
  }, 20_000)

  it('the menu backdrop: eight strong bots dodge a lot, but neither dance nor decide in lockstep', () => {
    const seats = Array.from({ length: 8 }, (_, id) => ({ difficulty: (id % 2 ? 'uber' : 'brutal') as BotDifficulty }))
    const { meter } = meterBotMatch(seats, MENU_BATTLE_SETTINGS, 1, () => 1)
    const misses: string[] = []
    for (const tier of ['brutal', 'uber'] as const) {
      const c = seats.reduce((acc, s, id) => (s.difficulty === tier ? mergeMotion(acc, meter.counts(id)) : acc), emptyMotion())
      const s = summarizeMotion(c)
      if (s.freeReversalsPerSecond > 0.12) misses.push(`${tier} free reversals ${s.freeReversalsPerSecond.toFixed(3)}`)
      // more bolts than any human match: dodging is the fight, so dither gets a little more room
      if (s.dither > 0.1) misses.push(`${tier} dither ${s.dither.toFixed(3)}`)
      // today 3.0: every bot of a tier decided on the same 0.1 s clock
      const ratio = sameTickRatio(meter.sameTick(tier)!)
      if (!(ratio <= 1.2)) misses.push(`${tier} same-tick ratio ${ratio.toFixed(2)}`)
    }
    expect(misses).toEqual([])
  }, 20_000)
})
