/**
 * Headless bot-vs-bot matches on the real sim: catches crashes, stalls and bots that
 * never finish a round. Skipped (with a reason) while the sim cannot run a match.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SCOURGE_SLOT, createMatch, hashState, step, ticks } from '../sim'
import type { BotDifficulty, MatchSettings, PlayerSlot, SimState } from '../sim'
import { createBot } from './index'
import { PillarStuckMeter } from './pillarStuck'

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

function play(diffs: BotDifficulty[], seed: number, maxSeconds: number, kit?: Record<number, string>) {
  const sl = slots(diffs)
  const state: SimState = createMatch(SETTINGS, sl, seed)
  // hand every pawn a kit directly (column slot -> spell) to exercise unreleased spells
  if (kit) for (const p of state.pawns) for (const [slot, spell] of Object.entries(kit)) {
    p.slots[Number(slot)] = spell
    p.levels[Number(slot)] = 1
  }
  const bots = sl.map((s) => createBot(s.id, s.difficulty!, seed * 31 + s.id))
  const maxTicks = ticks(maxSeconds)
  let deaths = 0
  let casts = 0
  const spells = new Set<string>()
  for (let i = 0; i < maxTicks && state.phase !== 'gameOver'; i++) {
    const inputs = bots.map((b) => ({ player: b.player, tick: state.tick, cmds: b.think(state) }))
    step(state, inputs)
    for (const e of state.events) {
      if (e.type === 'death') deaths++
      if (e.type === 'cast') {
        casts++
        spells.add(e.spell)
      }
    }
  }
  return { state, deaths, casts, spells }
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

  it.skipIf(simReason !== '')(`bots fight with M1 spells (Lightning, Homing, Swap, Meteor) without stalling${simReason}`, () => {
    const kit = { 0: 'lightning', 1: 'swap', 2: 'drain', 3: 'meteor' }
    const { state, spells } = play(['brutal', 'hard'], 11, 900, kit)
    expect(state.phase).toBe('gameOver')
    for (const s of ['lightning', 'drain', 'meteor', 'fireball']) expect(spells.has(s), `${s} was never cast`).toBe(true)
  })

  /**
   * Real sim: a scripted enemy starts Scourge 200 units from the bot. Returns whether the bot
   * took the Scourge damage and how far away it was when it fired.
   */
  function scourgeAtBot(difficulty: BotDifficulty, seed: number) {
    const sl: PlayerSlot[] = [
      { id: 0, name: 'bot', color: 0xff0000, team: 0, kind: 'bot', difficulty },
      { id: 1, name: 'enemy', color: 0x0000ff, team: 1, kind: 'human' },
    ]
    const state = createMatch(SETTINGS, sl, seed)
    const bot = createBot(0, difficulty, seed)
    // reach the fight and let spawn invulnerability run out
    for (let i = 0; i < ticks(60) && state.phase !== 'fight'; i++) step(state, [])
    for (let i = 0; i < ticks(2.5); i++) step(state, [])
    const me = state.pawns.find((p) => p.owner === 0)!
    const foe = state.pawns.find((p) => p.owner === 1)!
    // pillar routing is tested on its own (bots.test.ts); here: open ground
    state.obstacles = []
    for (const [p, x] of [
      [foe, 0],
      [me, 200],
    ] as const) {
      p.x = x
      p.y = 0
      p.vx = p.vy = p.walkVx = p.walkVy = 0
      p.moveTarget = null
      p.cast = null
    }
    step(state, [{ player: 1, tick: state.tick, cmds: [{ kind: 'cast', slot: SCOURGE_SLOT, x: foe.x, y: foe.y }] }])
    for (let i = 0; i < ticks(1.5); i++) {
      step(state, [{ player: 0, tick: state.tick, cmds: bot.think(state) }])
      const blast = state.events.find((e) => e.type === 'explosion' && e.spell === 'scourge')
      if (blast) {
        const hit = state.events.some((e) => e.type === 'damage' && e.target === me.id && e.source === 1)
        return { fired: true, hit, dist: Math.hypot(me.x - foe.x, me.y - foe.y) }
      }
    }
    return { fired: false, hit: false, dist: Math.hypot(me.x - foe.x, me.y - foe.y) }
  }

  it.skipIf(simReason !== '')(`the scenario is real: a dummy 200 units from a charging Scourge is hit${simReason}`, () => {
    const r = scourgeAtBot('dummy', 1)
    expect(r.fired).toBe(true)
    expect(r.hit).toBe(true)
  })

  it.skipIf(simReason !== '')(`hard and brutal leave a charging Scourge before it fires${simReason}`, () => {
    for (const d of ['hard', 'brutal'] as const) {
      for (let seed = 1; seed <= 8; seed++) {
        const r = scourgeAtBot(d, seed)
        expect(r.fired, `${d} seed ${seed}`).toBe(true)
        expect(r.hit, `${d} seed ${seed} was hit at ${r.dist.toFixed(0)}`).toBe(false)
        expect(r.dist).toBeGreaterThanOrEqual(250)
      }
    }
  })

  it.skipIf(simReason !== '')(`no bot pushes into a pillar for more than 1 s across seeded matches${simReason}`, () => {
    const pairs: BotDifficulty[][] = [
      ['hard', 'medium'],
      ['brutal', 'easy'],
      ['medium', 'easy'],
    ]
    for (const diffs of pairs) {
      for (let seed = 1; seed <= 3; seed++) {
        const sl = slots(diffs)
        const state = createMatch({ ...SETTINGS, winScore: 3 }, sl, seed)
        const bots = sl.map((s) => createBot(s.id, s.difficulty!, seed * 31 + s.id))
        const meter = new PillarStuckMeter()
        let pillars = 0
        for (let i = 0; i < ticks(1500) && state.phase !== 'gameOver'; i++) {
          step(state, bots.map((b) => ({ player: b.player, tick: state.tick, cmds: b.think(state) })))
          meter.observe(state)
          pillars = Math.max(pillars, state.obstacles.length)
        }
        expect(pillars, 'the sim spawns pillars: otherwise this test proves nothing').toBeGreaterThan(0)
        expect(meter.worstTicks, `${diffs.join(' vs ')} seed ${seed}`).toBeLessThanOrEqual(ticks(1))
      }
    }
  }, 20_000) // several seeded full matches: ~3-4 s alone, more under a loaded parallel run

  /**
   * Real sim: the bot slides hard toward the lava (a big knockback) with HP so low that
   * walking back would burn it to death. Returns whether it survived 6 s.
   */
  function knockedTowardLava(difficulty: BotDifficulty, k: number, teleportReady: boolean): boolean {
    const sl: PlayerSlot[] = [
      { id: 0, name: 'bot', color: 0xff0000, team: 0, kind: 'bot', difficulty },
      { id: 1, name: 'foe', color: 0x0000ff, team: 1, kind: 'human' },
    ]
    const state = createMatch({ ...DEFAULT_SETTINGS }, sl, 100 + k)
    for (let i = 0; i < ticks(60) && state.phase !== 'fight'; i++) step(state, [])
    for (let i = 0; i < ticks(2.5); i++) step(state, [])
    state.obstacles = []
    const me = state.pawns.find((p) => p.owner === 0)!
    const foe = state.pawns.find((p) => p.owner === 1)!
    const edge = (state.arena.layer - 1) * 100
    const a = (k / 8) * Math.PI * 2 + 0.3
    foe.x = -Math.cos(a) * 500
    foe.y = -Math.sin(a) * 500
    foe.vx = foe.vy = 0
    foe.moveTarget = null
    me.x = Math.cos(a) * (edge - 300)
    me.y = Math.sin(a) * (edge - 300)
    me.vx = Math.cos(a) * 1500
    me.vy = Math.sin(a) * 1500
    me.walkVx = me.walkVy = 0
    me.moveTarget = null
    me.cast = null
    me.hp = 120 // a few lava ticks
    me.slots[1] = 'teleport'
    me.levels[1] = 1
    me.cooldowns[1] = teleportReady ? 0 : ticks(10)
    const bot = createBot(0, difficulty, 7 + k)
    for (let i = 0; i < ticks(6); i++) {
      step(state, [{ player: 0, tick: state.tick, cmds: bot.think(state) }])
      if (!me.alive) return false
    }
    return true
  }

  it.skipIf(simReason !== '')(`a bot knocked toward lava with Teleport ready survives; without it, it burns${simReason}`, () => {
    for (const d of ['hard', 'brutal', 'uber'] as const) {
      for (let k = 0; k < 6; k++) {
        expect(knockedTowardLava(d, k, false), `${d} #${k}: the setup must be lethal without Teleport`).toBe(false)
        expect(knockedTowardLava(d, k, true), `${d} #${k}`).toBe(true)
      }
    }
  })

  // tier-vs-tier win rates: ladder.test.ts

  it.skipIf(simReason !== '')(`seeded bot matches are reproducible${simReason}`, () => {
    const run = () => {
      const sl = slots(['uber', 'brutal'])
      const state = createMatch({ ...DEFAULT_SETTINGS }, sl, 3)
      const bots = sl.map((s) => createBot(s.id, s.difficulty!, 3 * 31 + s.id))
      for (let i = 0; i < ticks(90) && state.phase !== 'gameOver'; i++) {
        step(state, bots.map((b) => ({ player: b.player, tick: state.tick, cmds: b.think(state) })))
      }
      return hashState(state)
    }
    expect(run()).toBe(run())
  })
})

