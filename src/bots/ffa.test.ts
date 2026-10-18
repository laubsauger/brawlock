/**
 * FFA behaviour (playtest: a column of bots marching across the map after the weakest player).
 * Local opportunities, fading retaliation and score hysteresis should spread fights without
 * forbidding a good contested finish, forcing retreat or imposing a chase timer.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, createMatch, hashState, step } from '../sim'
import type { BotDifficulty, PlayerSlot, SimState } from '../sim'
import { BotController } from './controller'
import { makePawn, makeState } from './fixtures'

function ffa(diffs: BotDifficulty[], seed: number) {
  const slots: PlayerSlot[] = diffs.map((d, id) => ({ id, name: `${d}${id}`, color: 0xff0000 + id, team: id, kind: 'bot', difficulty: d }))
  const state = createMatch({ ...DEFAULT_SETTINGS }, slots, seed)
  const bots = diffs.map((d, id) => new BotController(id, d, seed * 31 + id))
  return { state, bots }
}

/** Biggest number of living bots after one living player, sampled every 0.5 s of fight. */
function piles(diffs: BotDifficulty[], seed: number, fightSeconds: number): number[] {
  const { state, bots } = ffa(diffs, seed)
  const out: number[] = []
  for (let i = 0; i < 60 * 600 && out.length < fightSeconds * 2; i++) {
    step(state, bots.map((b) => ({ player: b.player, tick: state.tick, cmds: b.think(state) })))
    if (state.phase !== 'fight' || state.tick % 30 !== 0) continue
    const alive = new Set(state.pawns.filter((p) => p.alive).map((p) => p.owner))
    if (alive.size < 4) continue
    const on = new Map<number, number>()
    for (const b of bots) if (alive.has(b.player) && b.targetPlayer !== null && alive.has(b.targetPlayer)) on.set(b.targetPlayer, (on.get(b.targetPlayer) ?? 0) + 1)
    out.push(Math.max(0, ...on.values()))
  }
  return out
}

describe('bots: FFA targeting', () => {
  it('in an 8-bot FFA, half the table or more is rarely after one player', () => {
    // A population-level regression metric, never a limit enforced by the controller.
    for (const lineup of [Array(8).fill('brutal'), Array(8).fill('hard')] as BotDifficulty[][]) {
      const samples = [1, 2, 3].flatMap((seed) => piles(lineup, seed, 60))
      expect(samples.length).toBeGreaterThan(200)
      const mobbed = samples.filter((n) => n >= 4).length / samples.length
      expect(mobbed, `${lineup[0]}: share of samples with 4+ bots on one player`).toBeLessThan(0.15)
    }
  }, 30_000)

  /** A bot at the origin, a weak enemy far off at the edge, and a nearer one. */
  function choice(difficulty: BotDifficulty, near: Parameters<typeof makePawn>[3] = {}, seed = 1, at = { x: 0, y: 0 }) {
    const me = makePawn(0, at.x, at.y)
    const weak = makePawn(1, 1350, 0, { hp: 150, kbPoints: 400 }) // near the edge of layer 15 (r 1400)
    const other = makePawn(2, -350, 120, near)
    const state: SimState = makeState([me, weak, other])
    const bot = new BotController(0, difficulty, seed)
    for (let t = 0; t < 30; t++) {
      state.tick = t
      bot.think(state)
    }
    return bot.targetPlayer
  }

  it('goes after whoever just hit it rather than a weak player across the map', () => {
    for (const d of ['hard', 'brutal', 'uber'] as const) {
      for (let seed = 1; seed <= 6; seed++) {
        const me = makePawn(0, 0, 0, { lastHitter: 2 })
        const state = makeState([me, makePawn(1, 1350, 0, { hp: 150, kbPoints: 400 }), makePawn(2, -350, 120)])
        state.events.push({ type: 'damage', target: me.id, source: 2, amount: 100, x: 0, y: 0, kb: 0 })
        const bot = new BotController(0, d, seed)
        for (let t = 0; t < 30; t++) {
          state.tick = t
          bot.think(state)
          state.events = []
        }
        expect(bot.targetPlayer, `${d} seed ${seed}`).toBe(2)
      }
    }
  })

  it('takes a clearly better chance nearby (an enemy at the edge in reach) over a far, weak one', () => {
    // we stand at (0, 900); player 2 is 570 away by the lava with half its HP gone, the weak
    // one 1600 away across the arena
    for (const d of ['hard', 'brutal', 'uber'] as const)
      for (let seed = 1; seed <= 6; seed++)
        expect(choice(d, { x: -450, y: 1250, hp: 500, kbPoints: 250 }, seed, { x: 0, y: 900 }), `${d} seed ${seed}`).toBe(2)
  })

  it('most bots join a third-party push (someone flying toward the lava nearby) over a far, weak target', () => {
    // player 2 at 600 from the centre, knocked outward at 700 u/s by somebody else's hit;
    // how much a bot cares is its seeded opportunism, so most do, not all
    for (const d of ['brutal', 'uber'] as const) {
      const takers = Array.from({ length: 10 }, (_, k) => choice(d, { x: -600, y: 0, vx: -700, vy: 0 }, k + 1)).filter((t) => t === 2).length
      expect(takers, d).toBeGreaterThanOrEqual(6)
    }
  })

  it('a weak player already surrounded by others is left to them', () => {
    // the weak one is close, but four other warlocks stand around it; a free enemy as near
    const me = makePawn(0, 0, 0)
    const weak = makePawn(1, 500, 0, { hp: 250, kbPoints: 200 })
    const crowd = [2, 3, 4, 5].map((id, i) => makePawn(id, 800 + (i % 2) * 200, i < 2 ? -200 : 200))
    const free = makePawn(6, -520, 0)
    const state = makeState([me, weak, ...crowd, free])
    for (const d of ['hard', 'brutal', 'uber'] as const) {
      const bot = new BotController(0, d, 3)
      for (let t = 0; t < 30; t++) {
        state.tick = t
        bot.think(state)
      }
      expect(bot.targetPlayer, d).toBe(6)
    }
  })

  it('still takes a contested finish when a nearby enemy is flying toward lava', () => {
    const me = makePawn(0, 0, 900)
    const weak = makePawn(1, 150, 1250, { hp: 80, kbPoints: 500, vy: 700 })
    const crowd = [2, 3, 4, 5].map((id, i) => makePawn(id, 600 + (i % 2) * 200, 900 + (i < 2 ? -200 : 200)))
    const free = makePawn(6, -520, 900)
    for (const difficulty of ['hard', 'brutal', 'uber'] as const) {
      const bot = new BotController(0, difficulty, 3)
      bot.think(makeState([me, weak, ...crowd, free]))
      expect(bot.targetPlayer, difficulty).toBe(1)
    }
  })

  it('can switch on the next decision when a better nearby fight develops', () => {
    const first = makePawn(1, 400, 0)
    const second = makePawn(2, -900, 0)
    const state = makeState([makePawn(0, 0, 0), first, second])
    const bot = new BotController(0, 'hard', 1)
    bot.think(state)
    expect(bot.targetPlayer).toBe(1)
    first.x = 1350
    second.x = -200
    for (let tick = 1; tick <= 12; tick++) {
      state.tick = tick
      bot.think(state)
    }
    expect(bot.targetPlayer).toBe(2)
  })

  it('keeps a worthwhile fight through small score fluctuations without a maximum chase timer', () => {
    const state = makeState([makePawn(0, 0, 0), makePawn(1, 400, 0), makePawn(2, -420, 0)])
    const bot = new BotController(0, 'hard', 1)
    for (let tick = 0; tick < 60 * 20; tick++) {
      state.tick = tick
      state.pawns[2].x = -400 + Math.sin(tick / 60) * 15
      bot.think(state)
      expect(bot.targetPlayer).toBe(1)
    }
  })

  it('retaliates against observed damage, then lets that grudge fade despite permanent kill credit', () => {
    const me = makePawn(0, 0, 0, { lastHitter: 2 })
    const state = makeState([me, makePawn(1, 500, 0), makePawn(2, -650, 0)])
    state.events.push({ type: 'damage', target: me.id, source: 2, amount: 100, x: 0, y: 0, kb: 0 })
    const bot = new BotController(0, 'brutal', 1)
    bot.think(state)
    expect(bot.targetPlayer).toBe(2)
    state.events = []
    for (let tick = 1; tick <= 60 * 20; tick++) {
      state.tick = tick
      bot.think(state)
    }
    expect(me.lastHitter).toBe(2)
    expect(bot.targetPlayer).toBe(1)
    // Old kill credit alone should not start another grudge.
    const fresh = new BotController(0, 'brutal', 1)
    fresh.think(state)
    expect(fresh.targetPlayer).toBe(1)
  })

  it('lower health shifts firing positions outward without abandoning the fight', () => {
    const distances = (hp: number) => Array.from({ length: 30 }, (_, index) => {
      const me = makePawn(0, 0, 0, { hp })
      me.slots.fill(null) // Only the movement decision is under test.
      const state = makeState([me, makePawn(1, 250, 0), makePawn(2, -650, 0)])
      const bot = new BotController(0, 'hard', index + 1)
      for (let tick = 0; tick < 30; tick++) {
        state.tick = tick
        const move = bot.think(state).find((command) => command.kind === 'move')
        if (move?.kind === 'move') return Math.hypot(move.x - 250, move.y)
      }
      throw new Error('Bot never issued its movement decision')
    })
    const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
    const healthy = average(distances(1000))
    const hurt = average(distances(500))
    const critical = average(distances(150))
    expect(hurt).toBeGreaterThan(healthy)
    expect(critical).toBeGreaterThan(hurt)
    expect(critical).toBeLessThan(750) // Still a shooting position, not flight across the arena.
  })

  it('8-bot FFA matches are reproducible', () => {
    const run = () => {
      const { state, bots } = ffa(['easy', 'medium', 'hard', 'hard', 'brutal', 'brutal', 'uber', 'medium'], 9)
      for (let i = 0; i < 60 * 90; i++) step(state, bots.map((b) => ({ player: b.player, tick: state.tick, cmds: b.think(state) })))
      return hashState(state)
    }
    expect(run()).toBe(run())
  })
})
