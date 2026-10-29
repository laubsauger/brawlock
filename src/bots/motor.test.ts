/**
 * The motor model's rules that bot-only matches rarely show (docs/moonshot/specs/bot-motion.md,
 * rules 8-11): each test shows the behaviour with the rule and without it, so it fails if the rule
 * stops working. Rules 1-7 are measured as a whole by the gated motion test (motion.test.ts).
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, createMatch, hillSealed, onHill, step, ticks } from '../sim'
import type { BotDifficulty, PlayerSlot, SimState } from '../sim/types'
import { TICK_HZ } from '../sim/types'
import { BotController } from './controller'
import { FIREBALL_SLOT, makePawn, makeState } from './fixtures'
import { MotionMeter, motionBefore, sameTickRatio } from './motion'
import { BOT_PRESETS, type BotParams } from './presets'

const BOT = 0
const ENEMY = 1

describe('motor model', () => {
  it('a faked windup still costs a short flinch (threatInertia), as it costs a player', () => {
    // Why: a read windup that vanished used to vanish from the bot's mind at once, so it snapped
    // back mid-step; a person finishes the flinch, and that is what a fake is for.
    const flinch = (threatInertia: number) => {
      const me = makePawn(BOT, 0, 0)
      me.slots[FIREBALL_SLOT] = null
      const enemy = makePawn(ENEMY, 300, 0, { cast: { slot: FIREBALL_SLOT, spell: 'fireball', ticksLeft: ticks(0.6), x: 0, y: 0, started: true } })
      const state = makeState([me, enemy])
      // fixed timing, so the measured flinch is the rule's alone
      const bot = new BotController(BOT, 'brutal', 3, { ...BOT_PRESETS.brutal, readWindups: 1, thinkSigma: 0, delaySigma: 0, threatInertia })
      let faked = -1
      for (let t = 0; t < ticks(1.5); t++) {
        state.tick = t
        bot.think(state)
        if (bot.decisionTick !== t) continue
        if (faked < 0 && bot.lastAction === 'dodge') {
          faked = t
          enemy.cast = null // the fake: the windup is cancelled, no bolt comes
        } else if (faked >= 0 && bot.lastAction !== 'dodge') return (t - faked) / TICK_HZ
      }
      return Infinity
    }
    expect(flinch(0.2)).toBeGreaterThanOrEqual(0.2)
    expect(flinch(0)).toBeLessThan(0.2)
  })

  it('a crowded hill is decided once per hillDecideSeconds, not flipped on every pick', () => {
    const hillState = () => {
      const me = makePawn(BOT, 700, 0)
      const state = makeState([me, makePawn(ENEMY, 0, 0), makePawn(2, 60, 0)], {
        hill: { layer: 5, nextShrinkTick: -1, team: null, contested: true, heldTicks: 0, nextIncomeTick: -1, stays: [] },
      })
      state.settings.gameMode = 'hill'
      return state
    }
    // the shortest time between two changes of mind, over a few seeds
    const quickest = (params: BotParams) => {
      let shortest = Infinity
      for (let seed = 1; seed <= 8; seed++) {
        const state = hillState()
        const bot = new BotController(BOT, 'hard', seed, params)
        let intent: boolean | null = null
        let since = 0
        for (let t = 0; t < ticks(8); t++) {
          state.tick = t
          bot.think(state)
          if (bot.hillIntent === null || bot.hillIntent === intent) continue
          if (intent !== null) shortest = Math.min(shortest, (t - since) / TICK_HZ)
          intent = bot.hillIntent
          since = t
        }
      }
      return shortest
    }
    expect(quickest(BOT_PRESETS.hard)).toBeGreaterThanOrEqual(2)
    // the same plan redone every pick (the knob near zero) changes its mind within the 2 s
    expect(quickest({ ...BOT_PRESETS.hard, hillDecideSeconds: 1e-6 })).toBeLessThan(2)
  })

  it('no bot walks into the sealed hill: it waits at the field instead', () => {
    const intoField = (difficulty: BotDifficulty, params: BotParams) => {
      const slots: PlayerSlot[] = [0, 1, 2, 3].map((id) => ({ id, name: `B${id}`, color: 0, team: id, kind: 'bot', difficulty }))
      let orders = 0
      for (const seed of [3, 7]) {
        const state = createMatch({ ...DEFAULT_SETTINGS, gameMode: 'hill', winScore: 999, shopSeconds: 3, hillRespawn: true }, slots, seed)
        const bots = slots.map((s) => new BotController(s.id, difficulty, 70 + s.id, params))
        while (state.phase !== 'fight') step(state, bots.map((b) => ({ player: b.player, tick: state.tick, cmds: b.think(state) })))
        while (hillSealed(state)) {
          const inputs = bots.map((b) => ({ player: b.player, tick: state.tick, cmds: b.think(state) }))
          for (const i of inputs) for (const c of i.cmds) if (c.kind === 'move' && onHill(state, c.x, c.y)) orders++
          step(state, inputs)
        }
      }
      return orders
    }
    expect(intoField('hard', BOT_PRESETS.hard)).toBe(0)
    // without hill decisions the bots walk at the sealed hill and stand pushing against its field
    expect(intoField('hard', { ...BOT_PRESETS.hard, hillDecideSeconds: 0 })).toBeGreaterThan(0)
  }, 20_000)

  it('bots of one tier stop deciding on the same ticks (thinkSigma: a random phase and spread)', () => {
    // Why: every Hard-or-better bot decided on one shared 0.1 s clock, a fingerprint for automation
    // detection and the cause of "weird races between them".
    const ratio = (params: BotParams) => {
      const state = makeState([makePawn(0, -500, 0), makePawn(1, 500, 0)])
      const bots = [0, 1].map((id) => new BotController(id, 'hard', 11, params))
      const meter = new MotionMeter()
      for (let t = 0; t < ticks(20); t++) {
        state.tick = t
        for (const b of bots) b.think(state)
        const before = motionBefore(state)
        state.tick++
        meter.tick(before, [], state, new Set(bots.filter((b) => b.decisionTick === t).map((b) => b.player)))
        state.tick--
      }
      return sameTickRatio(meter.sameTick('hard')!)
    }
    expect(ratio(BOT_PRESETS.hard)).toBeLessThan(1.5)
    expect(ratio({ ...BOT_PRESETS.hard, thinkSigma: 0, delaySigma: 0 })).toBeGreaterThan(2.5)
  })

  it('keeps each preset mean through the timing spread, never under a 0.1 s reaction', () => {
    for (const d of ['medium', 'hard', 'brutal', 'uber'] as const) {
      const p = BOT_PRESETS[d]
      expect(p.delaySigma, d).toBeGreaterThan(0)
      let delays = 0
      let fewest = Infinity
      const seeds = 400
      for (let seed = 1; seed <= seeds; seed++) {
        // the first decision is at tick 0, so its order leaves exactly one delay later
        const state: SimState = makeState([makePawn(0, 0, 0), makePawn(1, 900, 0)])
        const bot = new BotController(0, d, seed)
        bot.think(state)
        const at = bot.scheduled()[0]?.at
        if (at === undefined) continue
        delays += at
        fewest = Math.min(fewest, at)
      }
      expect(delays / seeds / TICK_HZ, d).toBeCloseTo(p.reactionDelay, 1)
      expect(fewest / TICK_HZ, d).toBeGreaterThanOrEqual(0.1 - 0.5 / TICK_HZ)
    }
  })
})
