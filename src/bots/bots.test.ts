import { describe, expect, it } from 'vitest'
import { DT } from '../sim/types'
import type { BotDifficulty, InputCommand, SimState, Vec2 } from '../sim/types'
import { createBot, BOT_PRESETS, type Bot } from './index'
import { BotController } from './controller'
import { interceptTime, leadPoint } from './aim'
import { isSafe } from './arena'
import { dangerAt } from './danger'
import { isBuyable } from './spells'
import { FIREBALL_SLOT, TELEPORT_SLOT, makeFireball, makePawn, makeState } from './fixtures'

const BOT = 0
const ENEMY = 1
const HIT_DIST = 25 + 30 // fireball radius + pawn radius

/**
 * Minimal kinematics standing in for the sim: pawns walk straight to their move target
 * at moveSpeed, a cast or stop halts them, projectiles fly straight. Enough to tell
 * whether a decision changes the outcome of an incoming shot.
 */
function runKinematic(
  bot: Bot | null,
  state: SimState,
  ticks: number,
  onTick?: (tick: number, s: SimState) => void,
): { minDist: number; hit: boolean; log: { tick: number; cmds: InputCommand[] }[] } {
  const me = state.pawns.find((p) => p.owner === BOT)!
  let goal: Vec2 | null = null
  let minDist = Infinity
  let hit = false
  const log: { tick: number; cmds: InputCommand[] }[] = []
  for (let t = 0; t < ticks; t++) {
    state.tick = t
    onTick?.(t, state)
    const cmds = bot ? bot.think(state) : []
    if (cmds.length) log.push({ tick: t, cmds })
    for (const c of cmds) {
      if (c.kind === 'move') goal = { x: c.x, y: c.y }
      else if (c.kind === 'stop' || c.kind === 'cast') goal = null
    }
    me.vx = 0
    me.vy = 0
    if (goal) {
      const dx = goal.x - me.x
      const dy = goal.y - me.y
      const d = Math.hypot(dx, dy)
      const stepLen = Math.min(d, me.moveSpeed * DT)
      if (d > 1e-6) {
        me.vx = (dx / d) * me.moveSpeed
        me.vy = (dy / d) * me.moveSpeed
        me.x += (dx / d) * stepLen
        me.y += (dy / d) * stepLen
      }
    }
    for (const p of state.projectiles) {
      p.x += p.vx * DT
      p.y += p.vy * DT
      const d = Math.hypot(p.x - me.x, p.y - me.y)
      minDist = Math.min(minDist, d)
      if (d < HIT_DIST) hit = true
    }
    state.projectiles = state.projectiles.filter((p) => Math.hypot(p.x - me.x, p.y - me.y) >= HIT_DIST)
  }
  return { minDist, hit, log }
}

/** Bot at the origin, enemy out of every range; an enemy fireball appears at tick 1, 900 units out, aimed at the bot. */
function incomingShot(difficulty: BotDifficulty | null, withShot = true) {
  const state = makeState([makePawn(BOT, 0, 0), makePawn(ENEMY, 1500, 600)])
  const bot = difficulty ? createBot(BOT, difficulty, 7) : null
  return runKinematic(bot, state, 90, (t, s) => {
    if (t === 1 && withShot) s.projectiles.push(makeFireball(ENEMY, 900, 0, -1000, 0))
  })
}

describe('bots: presets', () => {
  it('every difficulty stays human-plausible (reaction >= 150 ms, aim error > 0)', () => {
    for (const d of ['easy', 'medium', 'hard', 'brutal'] as const) {
      expect(BOT_PRESETS[d].reactionDelay).toBeGreaterThanOrEqual(0.15)
      expect(BOT_PRESETS[d].aimErrorRad).toBeGreaterThan(0)
    }
  })

  it('harder presets think at least as often as the original intervals', () => {
    expect(BOT_PRESETS.easy.thinkInterval).toBe(1.0)
    expect(BOT_PRESETS.medium.thinkInterval).toBe(0.5)
    expect(BOT_PRESETS.hard.thinkInterval).toBe(0.2)
    expect(BOT_PRESETS.brutal.thinkInterval).toBeLessThan(BOT_PRESETS.hard.thinkInterval)
  })
})

describe('bots: dummy', () => {
  it('never issues a command, even when shot at, on lava or able to buy', () => {
    const me = makePawn(BOT, 1500, 0) // lava: layer 5 has radius 400
    me.slots[TELEPORT_SLOT] = 'teleport'
    me.levels[TELEPORT_SLOT] = 1
    const state = makeState([me, makePawn(ENEMY, 200, 0)], { arena: { layer: 5, nextShrinkTick: -1, theme: 0 } })
    state.scores[0].gold = 100
    state.projectiles.push(makeFireball(ENEMY, 900, 0, -1000, 0))
    const bot = createBot(BOT, 'dummy', 1)
    for (let t = 0; t < 600; t++) {
      state.tick = t
      state.phase = t < 300 ? 'shop' : 'fight'
      expect(bot.think(state)).toEqual([])
    }
  })
})

describe('bots: never mutate state', () => {
  it('think leaves the SimState untouched', () => {
    const state = makeState([makePawn(BOT, 0, 0), makePawn(ENEMY, 400, 100)])
    state.projectiles.push(makeFireball(ENEMY, 700, 0, -1000, 0))
    const before = JSON.stringify(state)
    const bot = createBot(BOT, 'brutal', 3)
    for (let t = 0; t < 120; t++) {
      state.tick = t
      const snapshot = JSON.stringify({ ...state, tick: 0 })
      bot.think(state)
      expect(JSON.stringify({ ...state, tick: 0 })).toBe(snapshot)
    }
    state.tick = 0
    expect(JSON.stringify(state)).toBe(before)
  })
})

describe('bots: dodging an incoming fireball', () => {
  it('the scenario is a real threat: a pawn that does nothing gets hit', () => {
    const r = incomingShot(null)
    expect(r.hit).toBe(true)
  })

  for (const d of ['hard', 'brutal'] as const) {
    it(`${d} steps out of the fireball's path and is not hit`, () => {
      const r = incomingShot(d)
      expect(r.hit).toBe(false)
      expect(r.minDist).toBeGreaterThan(HIT_DIST)
      // and the reaction is a sideways step, not a lucky wander: some move after the shot
      // appeared heads mostly perpendicular to the fireball's path (y), away from it
      const sideways = r.log.some(
        (e) =>
          e.tick > 1 &&
          e.cmds.some((c) => c.kind === 'move' && Math.abs(c.y) > 2 * Math.abs(c.x) && Math.abs(c.y) > 1000),
      )
      expect(sideways).toBe(true)
    })
  }

  it('dodges hold across seeds for hard and brutal', () => {
    for (const d of ['hard', 'brutal'] as const) {
      for (let seed = 1; seed <= 20; seed++) {
        const state = makeState([makePawn(BOT, 0, 0), makePawn(ENEMY, 1500, 600)])
        const r = runKinematic(createBot(BOT, d, seed), state, 90, (t, s) => {
          if (t === 1) s.projectiles.push(makeFireball(ENEMY, 900, 0, -1000, 0))
        })
        expect(r.hit, `${d} seed ${seed}`).toBe(false)
      }
    }
  })

  it('easy does not react before its next think: its commands until impact ignore the shot', () => {
    const withShot = incomingShot('easy', true)
    const without = incomingShot('easy', false)
    // impact would be ~tick 52; easy thinks at tick 0 and next at tick 60
    const upTo = (log: typeof withShot.log) => JSON.stringify(log.filter((e) => e.tick <= 52))
    expect(upTo(withShot.log)).toBe(upTo(without.log))
  })
})

describe('bots: lead aim', () => {
  /** Closest approach of a straight projectile and a constant-velocity target. */
  function closestApproach(shooter: Vec2, aim: Vec2, speed: number, target: Vec2, v: Vec2, launchDelay = 0) {
    const d = Math.hypot(aim.x - shooter.x, aim.y - shooter.y)
    const dir = { x: (aim.x - shooter.x) / d, y: (aim.y - shooter.y) / d }
    let best = Infinity
    for (let t = 0; t < 3; t += 1 / 2000) {
      const tx = target.x + v.x * (t + launchDelay)
      const ty = target.y + v.y * (t + launchDelay)
      const px = shooter.x + dir.x * speed * t
      const py = shooter.y + dir.y * speed * t
      best = Math.min(best, Math.hypot(tx - px, ty - py))
    }
    return best
  }

  it('solves the intercept: the shot meets a walking target within the projectile radius', () => {
    const shooter = { x: 0, y: 0 }
    const target = { x: 600, y: 200 }
    const v = { x: -60, y: -210 }
    const hitPoint = leadPoint(shooter, target, v, 1000)
    expect(closestApproach(shooter, hitPoint, 1000, target, v)).toBeLessThan(25)
    // aiming straight at the target would miss
    expect(closestApproach(shooter, target, 1000, target, v)).toBeGreaterThan(HIT_DIST)
  })

  it('accounts for a launch delay (cast point)', () => {
    const shooter = { x: 0, y: 0 }
    const target = { x: -500, y: 400 }
    const v = { x: 210, y: 0 }
    const hitPoint = leadPoint(shooter, target, v, 1000, 0.2)
    expect(closestApproach(shooter, hitPoint, 1000, target, v, 0.2)).toBeLessThan(25)
  })

  it('reports no intercept for a target outrunning the projectile', () => {
    expect(interceptTime(500, 0, 2000, 0, 1000)).toBeNull()
  })

  it('a brutal bot leads a walking target and its fireball connects', () => {
    const target = makePawn(ENEMY, 700, -350)
    const v = { x: 0, y: 210 }
    const state = makeState([makePawn(BOT, 0, 0), target])
    const bot = createBot(BOT, 'brutal', 11)
    let shot: { tick: number; x: number; y: number } | null = null
    for (let t = 0; t < 240 && !shot; t++) {
      state.tick = t
      target.vx = v.x
      target.vy = v.y
      for (const c of bot.think(state)) {
        if (c.kind === 'cast' && c.slot === FIREBALL_SLOT) shot = { tick: t, x: c.x, y: c.y }
      }
      target.x += v.x * DT
      target.y += v.y * DT
    }
    expect(shot).not.toBeNull()
    // the fireball leaves after the 0.2 s cast point; the target keeps walking
    const miss = closestApproach({ x: 0, y: 0 }, shot!, 1000, { x: target.x, y: target.y }, v, 0.2 - DT)
    expect(miss).toBeLessThan(HIT_DIST)
  })
})

describe('bots: lava escape', () => {
  function onLavaWithTeleport(cooldown = 0): SimState {
    const me = makePawn(BOT, 1000, 0)
    me.slots[TELEPORT_SLOT] = 'teleport'
    me.levels[TELEPORT_SLOT] = 1
    me.cooldowns[TELEPORT_SLOT] = cooldown
    // layer 8: platform radius 700, so x = 1000 is lava
    return makeState([me, makePawn(ENEMY, -300, 200)], { arena: { layer: 8, nextShrinkTick: -1, theme: 0 } })
  }

  for (const d of ['easy', 'hard', 'brutal'] as const) {
    it(`${d}: teleports to a safe tile within range when standing on lava`, () => {
      const state = onLavaWithTeleport()
      expect(isSafe(8, 1000, 0)).toBe(false)
      const bot = createBot(BOT, d, 5)
      let cast: InputCommand | null = null
      for (let t = 0; t < 600 && !cast; t++) {
        state.tick = t
        cast = bot.think(state).find((c) => c.kind === 'cast' && c.slot === TELEPORT_SLOT) ?? null
      }
      expect(cast).not.toBeNull()
      const c = cast as Extract<InputCommand, { kind: 'cast' }>
      expect(isSafe(8, c.x, c.y)).toBe(true)
      expect(Math.hypot(c.x - 1000, c.y)).toBeLessThanOrEqual(770 + 1e-6)
    })
  }

  it('brutal teleports on its first decision (no dithering on lava)', () => {
    const state = onLavaWithTeleport()
    const bot = createBot(BOT, 'brutal', 9) as BotController
    const delay = Math.round(BOT_PRESETS.brutal.reactionDelay / DT)
    for (let t = 0; t <= delay; t++) {
      state.tick = t
      const cmds = bot.think(state)
      if (t === delay) expect(cmds.some((c) => c.kind === 'cast' && c.slot === TELEPORT_SLOT)).toBe(true)
    }
  })

  it('with Teleport on cooldown, a lava-aware bot walks toward the nearest tile', () => {
    const state = onLavaWithTeleport(600)
    const bot = createBot(BOT, 'hard', 5) as BotController
    let move: InputCommand | null = null
    for (let t = 0; t < 60 && !move; t++) {
      state.tick = t
      move = bot.think(state).find((c) => c.kind === 'move') ?? null
    }
    expect(move).not.toBeNull()
    const m = move as Extract<InputCommand, { kind: 'move' }>
    expect(isSafe(8, m.x, m.y)).toBe(true)
    expect(m.x).toBeLessThan(1000) // inward
  })
})

describe('bots: scourge and shop', () => {
  it('starts Scourge when an enemy stands in reach', () => {
    const state = makeState([makePawn(BOT, 0, 0), makePawn(ENEMY, 150, 0)])
    const bot = createBot(BOT, 'hard', 2)
    let scourged = false
    for (let t = 0; t < 600 && !scourged; t++) {
      state.tick = t
      scourged = bot.think(state).some((c) => c.kind === 'cast' && c.slot === 7)
    }
    expect(scourged).toBe(true)
  })

  it('cancels a Scourge windup to dodge a fireball', () => {
    const me = makePawn(BOT, 0, 0, { cast: { slot: 7, spell: 'scourge', ticksLeft: 40, x: 0, y: 0 } })
    const state = makeState([me, makePawn(ENEMY, 150, 0)])
    state.projectiles.push(makeFireball(ENEMY, 0, 800, 0, -1000))
    const bot = createBot(BOT, 'hard', 2) as BotController
    state.tick = 0
    bot.think(state)
    expect(bot.lastAction).toBe('cancelScourge')
  })

  it('buys a spell in the shop phase when it can afford one, and not during a fight', () => {
    const fight = makeState([makePawn(BOT, 0, 0), makePawn(ENEMY, 900, 0)])
    fight.scores[0].gold = 30
    const b1 = createBot(BOT, 'medium', 4)
    const fightCmds: InputCommand[] = []
    for (let t = 0; t < 120; t++) {
      fight.tick = t
      fightCmds.push(...b1.think(fight))
    }
    expect(fightCmds.some((c) => c.kind === 'buySpell')).toBe(false)

    const shop = makeState([makePawn(BOT, 0, 0), makePawn(ENEMY, 900, 0)], { phase: 'shop' })
    shop.scores[0].gold = 30
    const b2 = createBot(BOT, 'medium', 4)
    const shopCmds: InputCommand[] = []
    for (let t = 0; t < 120; t++) {
      shop.tick = t
      shopCmds.push(...b2.think(shop))
    }
    expect(shopCmds.some((c) => c.kind === 'buySpell')).toBe(true)
  })

  it('a rejected purchase is not spammed during the shop phase, but retried next shop phase', () => {
    const state = makeState([makePawn(BOT, 0, 0), makePawn(ENEMY, 900, 0)], { phase: 'shop' })
    state.scores[0].gold = 30
    const bot = createBot(BOT, 'brutal', 4)
    const bought: { tick: number; spell: string }[] = []
    for (let t = 0; t < 60 * 20; t++) {
      state.tick = t
      // the "sim" here never grants anything: every purchase is rejected
      state.phase = t < 600 ? 'shop' : t < 660 ? 'fight' : 'shop'
      for (const c of bot.think(state)) if (c.kind === 'buySpell') bought.push({ tick: t, spell: c.spell })
    }
    const first = bought.filter((b) => b.tick < 600)
    const second = bought.filter((b) => b.tick >= 660)
    // each buyable spell tried at most once per shop phase
    expect(first.length).toBeGreaterThan(0)
    expect(new Set(first.map((b) => b.spell)).size).toBe(first.length)
    expect(second.length).toBeGreaterThan(0)
  })

  it('only buys spells the sim can cast', () => {
    const state = makeState([makePawn(BOT, 0, 0), makePawn(ENEMY, 900, 0)], { phase: 'shop' })
    state.scores[0].gold = 500
    for (let seed = 1; seed <= 30; seed++) {
      const bot = createBot(BOT, 'medium', seed)
      for (let t = 0; t < 120; t++) {
        state.tick = t
        for (const c of bot.think(state)) if (c.kind === 'buySpell') expect(isBuyable(c.spell)).toBe(true)
      }
    }
  })
})

describe('bots: danger field', () => {
  it('matches the original scale: on-course 1000, path 332 units aside ~3, receding 0', () => {
    const fb = makeFireball(ENEMY, 1000, 0, -1000, 0)
    expect(dangerAt([fb], 0, 0)).toBeCloseTo(1000)
    expect(dangerAt([fb], 0, 332)).toBeCloseTo(3, 1)
    expect(dangerAt([makeFireball(ENEMY, 1000, 0, 1000, 0)], 0, 0)).toBe(0)
    expect(dangerAt([makeFireball(ENEMY, 2500, 0, -1000, 0)], 0, 0)).toBe(0)
  })
})

describe('bots: determinism', () => {
  it('same seed and states give the same commands', () => {
    const run = () => {
      const state = makeState([makePawn(BOT, 0, 0), makePawn(ENEMY, 500, 300)])
      return runKinematic(createBot(BOT, 'medium', 99), state, 300).log
    }
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()))
  })
})

