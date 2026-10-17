import { describe, expect, it } from 'vitest'
import { DT } from '../sim/types'
import type { BotDifficulty, InputCommand, SimState, Vec2 } from '../sim/types'
import { createBot, BOT_PRESETS, type Bot } from './index'
import { BotController } from './controller'
import { interceptTime, leadPoint } from './aim'
import { isSafe } from './arena'
import { dangerAt } from './danger'
import { escapeRange } from './spells'
import { firstBlocking, routeAround } from './pillars'
import { RELEASED_SPELLS } from '../sim'
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

  it('Uber is better by decisions, not by superhuman inputs', () => {
    const u = BOT_PRESETS.uber
    expect(u.reactionDelay).toBeGreaterThanOrEqual(0.12) // no faster than a sharp human
    expect(u.aimErrorRad).toBeGreaterThan(0) // never pixel-perfect
    expect(u.thinkInterval).toBeGreaterThanOrEqual(BOT_PRESETS.brutal.thinkInterval) // no per-tick corrections
  })

  it('harder presets think at least as often as the original intervals', () => {
    // Easy is the original AI for new players: it must never get faster (ladder: PLAN §7)
    expect(BOT_PRESETS.easy.thinkInterval).toBe(1.0)
    expect(BOT_PRESETS.medium.thinkInterval).toBeLessThanOrEqual(0.5)
    expect(BOT_PRESETS.hard.thinkInterval).toBeLessThanOrEqual(0.2)
    expect(BOT_PRESETS.brutal.thinkInterval).toBeLessThanOrEqual(BOT_PRESETS.hard.thinkInterval)
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
        for (const c of bot.think(state)) if (c.kind === 'buySpell') expect(RELEASED_SPELLS.has(c.spell)).toBe(true)
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


describe('bots: M1 spells', () => {
  /** Run a bot until it casts from `slot` (or give up); the target walks at `v`. */
  function firstCast(bot: Bot, state: SimState, slot: number, ticks = 600, walk?: { pawn: number; vx: number; vy: number }) {
    for (let t = 0; t < ticks; t++) {
      state.tick = t
      const p = walk ? state.pawns.find((q) => q.owner === walk.pawn)! : null
      if (p && walk) {
        p.vx = walk.vx
        p.vy = walk.vy
      }
      const c = bot.think(state).find((x) => x.kind === 'cast' && x.slot === slot)
      if (c && c.kind === 'cast') return { tick: t, x: c.x, y: c.y }
      if (p && walk) {
        p.x += walk.vx * DT
        p.y += walk.vy * DT
      }
    }
    return null
  }

  it('never wastes Lightning on an enemy out of its 600 reach, uses it inside', () => {
    const far = makePawn(BOT, 0, 0)
    far.slots[0] = 'lightning'
    far.slots[FIREBALL_SLOT] = null // only Lightning to shoot
    const s1 = makeState([far, makePawn(ENEMY, 900, 0)])
    expect(firstCast(createBot(BOT, 'easy', 3), s1, 0)).toBeNull()
    const near = makePawn(BOT, 0, 0)
    near.slots[0] = 'lightning'
    near.slots[FIREBALL_SLOT] = null
    const s2 = makeState([near, makePawn(ENEMY, 450, 0)])
    expect(firstCast(createBot(BOT, 'easy', 3), s2, 0)).not.toBeNull()
  })

  it('brutal detonates its own Fireball with Lightning as it passes an enemy', () => {
    const me = makePawn(BOT, 0, 0)
    me.slots[0] = 'lightning'
    me.cooldowns[FIREBALL_SLOT] = 600 // Fireball already in flight
    const enemy = makePawn(ENEMY, 520, 160)
    const state = makeState([me, enemy])
    // our Fireball flying past the enemy, ~100 units off its path, inside Lightning's reach
    state.projectiles.push({ ...makeFireball(BOT, 200, 60, 1000, 0), id: 77 })
    const bot = createBot(BOT, 'brutal', 21) as BotController
    let combo: { x: number; y: number } | null = null
    for (let t = 0; t < 30 && !combo; t++) {
      state.tick = t
      const c = bot.think(state).find((x) => x.kind === 'cast' && x.slot === 0)
      if (c && c.kind === 'cast') combo = c
    }
    expect(combo).not.toBeNull()
    // aimed at the Fireball (where it will be), not at the enemy
    expect(Math.abs(combo!.y - 60)).toBeLessThan(5)
  })

  it('escapes lava with Swap to safe ground within its reach', () => {
    const me = makePawn(BOT, 1000, 0)
    me.slots[TELEPORT_SLOT] = 'swap'
    me.levels[TELEPORT_SLOT] = 1
    const state = makeState([me, makePawn(ENEMY, -300, 200)], { arena: { layer: 8, nextShrinkTick: -1, theme: 0 } })
    const reach = escapeRange('swap', 1)
    expect(reach).toBeGreaterThan(900)
    const c = firstCast(createBot(BOT, 'brutal', 5), state, TELEPORT_SLOT)
    expect(c).not.toBeNull()
    expect(isSafe(8, c!.x, c!.y)).toBe(true)
    expect(Math.hypot(c!.x - 1000, c!.y)).toBeLessThanOrEqual(reach + 1e-6)
  })

  it('aims Meteor where a walking target will be when it lands', () => {
    const me = makePawn(BOT, 0, 0)
    me.slots[3] = 'meteor'
    me.slots[FIREBALL_SLOT] = null
    const state = makeState([me, makePawn(ENEMY, 600, -300)])
    const shot = firstCast(createBot(BOT, 'brutal', 8), state, 3, 600, { pawn: ENEMY, vx: 0, vy: 210 })
    expect(shot).not.toBeNull()
    const enemy = state.pawns[1]
    // lands 0.2 s cast point + 1.15 s fall after the order executes; meteor radius >= 225
    const landY = enemy.y + 210 * (0.2 + 1.15)
    expect(Math.hypot(shot!.x - enemy.x, shot!.y - landY)).toBeLessThan(225)
    // aiming at the target's current position would have missed by the walk distance
    expect(Math.hypot(enemy.x - enemy.x, landY - enemy.y)).toBeGreaterThan(225)
  })

  it('hard Thrusts into a close enemy only when the ground past them is safe', () => {
    const setup = (enemyX: number, layer: number) => {
      const me = makePawn(BOT, 0, 0)
      me.slots[1] = 'thrust'
      me.levels[1] = 1
      me.slots[FIREBALL_SLOT] = null
      me.cooldowns[7] = 600 // no Scourge, so the dash is the only close-range option
      return makeState([me, makePawn(ENEMY, enemyX, 0)], { arena: { layer, nextShrinkTick: -1, theme: 0 } })
    }
    expect(firstCast(createBot(BOT, 'hard', 4), setup(300, 15), 1, 300)).not.toBeNull()
    // layer 5 (radius 400): past the enemy at x=300 is lava, so no dash
    expect(firstCast(createBot(BOT, 'hard', 4), setup(300, 5), 1, 300)).toBeNull()
    // easy keeps the original behaviour: Thrust only to leave lava
    expect(firstCast(createBot(BOT, 'easy', 4), setup(300, 15), 1, 300)).toBeNull()
  })
})

describe('bots: area threats (charging Scourge, Meteor, Gravity)', () => {
  const SCOURGE_HIT = 250 + 30 // hit radius plus our body

  /**
   * Enemy at the origin charging Scourge (0.9 s); the bot walks (210 u/s) or blinks per its
   * orders. Returns the bot's distance from the caster when the Scourge fires.
   */
  function scourgeEscape(difficulty: BotDifficulty, seed: number, startDist: number, teleport = false, layer = 15) {
    const me = makePawn(BOT, startDist, 0)
    if (teleport) {
      me.slots[TELEPORT_SLOT] = 'teleport'
      me.levels[TELEPORT_SLOT] = 1
    }
    me.slots[FIREBALL_SLOT] = null // keep the test about moving
    const enemy = makePawn(ENEMY, 0, 0, { cast: { slot: 7, spell: 'scourge', ticksLeft: 54, x: 0, y: 0, started: true } })
    const state = makeState([me, enemy], { arena: { layer, nextShrinkTick: -1, theme: 0 } })
    const bot = createBot(BOT, difficulty, seed)
    let goal: Vec2 | null = null
    let lava = false
    for (let t = 0; t < 54; t++) {
      state.tick = t
      for (const c of bot.think(state)) {
        if (c.kind === 'move') goal = { x: c.x, y: c.y }
        else if (c.kind === 'stop') goal = null
        else if (c.kind === 'cast' && c.slot === TELEPORT_SLOT && me.cooldowns[TELEPORT_SLOT] <= 0) {
          const d = Math.hypot(c.x - me.x, c.y - me.y)
          const k = Math.min(1, 770 / Math.max(1, d))
          me.x += (c.x - me.x) * k
          me.y += (c.y - me.y) * k
          me.cooldowns[TELEPORT_SLOT] = 600
          goal = null
        } else if (c.kind === 'cast') goal = null
      }
      me.vx = 0
      me.vy = 0
      if (goal) {
        const dx = goal.x - me.x
        const dy = goal.y - me.y
        const d = Math.hypot(dx, dy)
        if (d > 1e-6) {
          const step = Math.min(d, me.moveSpeed * DT)
          me.vx = (dx / d) * me.moveSpeed
          me.vy = (dy / d) * me.moveSpeed
          me.x += (dx / d) * step
          me.y += (dy / d) * step
        }
      }
      if (!isSafe(layer, me.x, me.y)) lava = true
      enemy.cast!.ticksLeft -= 1
    }
    return { dist: Math.hypot(me.x, me.y), lava }
  }

  for (const d of ['hard', 'brutal'] as const) {
    it(`${d} walks out of a charging Scourge before it fires (every seed)`, () => {
      for (let seed = 1; seed <= 20; seed++) {
        const r = scourgeEscape(d, seed, 200)
        expect(r.dist, `${d} seed ${seed}`).toBeGreaterThanOrEqual(SCOURGE_HIT)
      }
    })

    it(`${d} blinks out with Teleport when it stands too deep to walk out in time`, () => {
      for (let seed = 1; seed <= 10; seed++) {
        const walking = scourgeEscape(d, seed, 60)
        expect(walking.dist, 'walking from 60 cannot make it: the test needs the blink').toBeLessThan(SCOURGE_HIT)
        expect(scourgeEscape(d, seed, 60, true).dist, `${d} seed ${seed}`).toBeGreaterThanOrEqual(SCOURGE_HIT)
      }
    })
  }

  it('never flees into lava, even when that is the only way out of the blast', () => {
    // layer 4 (radius 300, solid ground to |x| < 288): clearing 280 + margin straight away from
    // a caster at the origin means stepping into lava; a Scourge hit is the lesser evil
    expect(isSafe(4, 330, 0)).toBe(false)
    for (const d of ['medium', 'hard', 'brutal'] as const) {
      for (let seed = 1; seed <= 10; seed++) {
        expect(scourgeEscape(d, seed, 150, false, 4).lava, `${d} seed ${seed}`).toBe(false)
      }
    }
  })

  it('routes around a pillar instead of fleeing into it', () => {
    const me = makePawn(BOT, 150, 0)
    me.slots[FIREBALL_SLOT] = null
    const enemy = makePawn(ENEMY, 0, 0, { cast: { slot: 7, spell: 'scourge', ticksLeft: 54, x: 0, y: 0, started: true } })
    const state = makeState([me, enemy])
    // a pillar right on the straight way out
    state.obstacles.push({ id: 90, x: 260, y: 0, radius: 60, hp: 400, variant: 0 })
    const bot = createBot(BOT, 'hard', 1)
    let move: Extract<InputCommand, { kind: 'move' }> | null = null
    for (let t = 0; t < 30 && !move; t++) {
      state.tick = t
      const c = bot.think(state).find((x) => x.kind === 'move')
      if (c && c.kind === 'move') move = c
    }
    expect(move).not.toBeNull()
    // the straight line from the bot to its target passes the pillar with room for our body
    const dx = move!.x - me.x
    const dy = move!.y - me.y
    const len = Math.hypot(dx, dy)
    const along = ((260 - me.x) * dx + (0 - me.y) * dy) / len
    const closest = along <= 0 ? Math.hypot(260 - me.x, me.y) : along >= len ? Math.hypot(260 - move!.x, move!.y) : Math.abs((260 - me.x) * dy - (0 - me.y) * dx) / len
    expect(closest).toBeGreaterThanOrEqual(60 + 30)
  })

  it('easy sometimes reacts too late; hard never does', () => {
    let easyOut = 0
    for (let seed = 1; seed <= 20; seed++) if (scourgeEscape('easy', seed, 200).dist >= SCOURGE_HIT) easyOut++
    expect(easyOut).toBeLessThan(20)
  })

  it('walks out of a Meteor landing spot before it lands', () => {
    for (const d of ['hard', 'brutal'] as const) {
      const me = makePawn(BOT, 0, 0)
      me.slots[FIREBALL_SLOT] = null
      const state = makeState([me, makePawn(ENEMY, -900, 0)])
      state.projectiles.push({
        id: 61,
        owner: ENEMY,
        spell: 'meteor',
        x: 120,
        y: 0,
        vx: 0,
        vy: 0,
        radius: 0,
        ticksLeft: 0,
        data: { tx: 120, ty: 0, radius: 225, hoverTicks: 33, fallTicks: 36, elapsed: 0, falling: 0, noTimer: 1 },
      })
      const bot = createBot(BOT, d, 3)
      let goal: Vec2 | null = null
      for (let t = 0; t < 69; t++) {
        state.tick = t
        for (const c of bot.think(state)) if (c.kind === 'move') goal = { x: c.x, y: c.y }
        if (goal) {
          const dx = goal.x - me.x
          const dy = goal.y - me.y
          const len = Math.hypot(dx, dy)
          if (len > 1e-6) {
            me.vx = (dx / len) * 210
            me.vy = (dy / len) * 210
            me.x += (dx / len) * Math.min(len, 210 * DT)
            me.y += (dy / len) * Math.min(len, 210 * DT)
          }
        }
        state.projectiles[0].data.elapsed += 1
      }
      expect(Math.hypot(me.x - 120, me.y), d).toBeGreaterThanOrEqual(225 + 30)
    }
  })

  it('steps out of a Gravity orb damage zone', () => {
    const me = makePawn(BOT, 0, 0)
    me.slots[FIREBALL_SLOT] = null
    const state = makeState([me, makePawn(ENEMY, -900, 0)])
    state.projectiles.push({ id: 62, owner: ENEMY, spell: 'gravity', x: 100, y: 50, vx: 0, vy: 0, radius: 25, ticksLeft: 200, data: { dpsRadius: 250 } })
    const bot = createBot(BOT, 'hard', 3) as BotController
    let goal: Vec2 | null = null
    for (let t = 0; t < 120; t++) {
      state.tick = t
      for (const c of bot.think(state)) if (c.kind === 'move') goal = { x: c.x, y: c.y }
      if (goal) {
        const dx = goal.x - me.x
        const dy = goal.y - me.y
        const len = Math.hypot(dx, dy)
        if (len > 1e-6) {
          me.x += (dx / len) * Math.min(len, 210 * DT)
          me.y += (dy / len) * Math.min(len, 210 * DT)
        }
      }
    }
    expect(Math.hypot(me.x - 100, me.y - 50)).toBeGreaterThanOrEqual(250 + 30)
  })
})

describe('bots: pillars', () => {
  const pillar = (x: number, y: number, radius = 60) => ({ id: 900 + x, x, y, radius, hp: 400, variant: 0 })

  it('never picks a wander or route target inside a pillar', () => {
    for (const d of ['easy', 'medium', 'hard', 'brutal'] as const) {
      const me = makePawn(BOT, 0, 0)
      me.slots[FIREBALL_SLOT] = null
      const state = makeState([me, makePawn(ENEMY, 1200, 600)])
      for (let i = 0; i < 12; i++) state.obstacles.push(pillar(-600 + i * 110, (i % 3) * 200 - 200, 50))
      const bot = createBot(BOT, d, 7)
      for (let t = 0; t < 60 * 30; t++) {
        state.tick = t
        for (const c of bot.think(state)) {
          if (c.kind !== 'move') continue
          for (const o of state.obstacles) expect(Math.hypot(c.x - o.x, c.y - o.y), d).toBeGreaterThanOrEqual(o.radius + 30)
        }
      }
    }
  })

  it('walks around a pillar standing between it and its goal', () => {
    const me = makePawn(BOT, 0, 0)
    const state = makeState([me, makePawn(ENEMY, 1200, 600)])
    state.obstacles.push(pillar(150, 0))
    const via = routeAround(state, me, { x: 400, y: 0 }, 15)
    // the leg to the waypoint passes the pillar with room for our body
    expect(firstBlocking(state, me, via, 0)).toBeNull()
    expect(Math.abs(via.y)).toBeGreaterThan(60)
    // and an open path is left alone
    expect(routeAround(state, me, { x: 0, y: 400 }, 15)).toEqual({ x: 0, y: 400 })
  })

  it('never dodges into a pillar', () => {
    for (const d of ['easy', 'hard', 'brutal'] as const) {
      // a fireball along x toward the bot; the natural dodge (+y) is walled by a pillar
      const me = makePawn(BOT, 0, 5)
      me.slots[FIREBALL_SLOT] = null
      const state = makeState([me, makePawn(ENEMY, 1500, 600)])
      state.obstacles.push(pillar(0, 110, 50))
      state.projectiles.push(makeFireball(ENEMY, 700, 0, -1000, 0))
      const bot = createBot(BOT, d, 2) as BotController
      let dodge: Extract<InputCommand, { kind: 'move' }> | null = null
      for (let t = 0; t < 80 && !dodge; t++) {
        state.tick = t
        const c = bot.think(state).find((x) => x.kind === 'move')
        if (c && c.kind === 'move' && bot.lastAction === 'dodge') dodge = c
      }
      expect(dodge, d).not.toBeNull()
      const len = Math.hypot(dodge!.x - me.x, dodge!.y - me.y)
      const ahead = { x: me.x + ((dodge!.x - me.x) / len) * 150, y: me.y + ((dodge!.y - me.y) / len) * 150 }
      expect(firstBlocking(state, me, ahead, 0), d).toBeNull()
    }
  })

  it('a pillar between the bot and a bolt is cover: hard and brutal stay in it, easy steps out', () => {
    const run = (d: BotDifficulty) => {
      const me = makePawn(BOT, 0, 0)
      me.slots[FIREBALL_SLOT] = null
      const state = makeState([me, makePawn(ENEMY, 1500, 600)])
      state.obstacles.push(pillar(250, 0, 60)) // on the bolt's line, between it and us
      state.projectiles.push(makeFireball(ENEMY, 800, 0, -1000, 0))
      const bot = createBot(BOT, d, 4) as BotController
      const actions = new Set<string>()
      for (let t = 0; t < 30; t++) {
        state.tick = t
        bot.think(state)
        actions.add(bot.lastAction)
      }
      return actions
    }
    for (const d of ['hard', 'brutal'] as const) expect(run(d).has('dodge'), d).toBe(false)
    expect(run('easy').has('dodge')).toBe(true)
  })
})

describe('bots: Scourge timing', () => {
  /** Run a bot for `seconds` next to an enemy standing at distance d; was Scourge started? */
  function scourges(difficulty: BotDifficulty, d: number, hp = 1000, seconds = 10): boolean {
    const me = makePawn(BOT, 0, 0, { hp })
    me.slots[FIREBALL_SLOT] = null // only Scourge to use
    const state = makeState([me, makePawn(ENEMY, d, 0)])
    const bot = createBot(BOT, difficulty, 5)
    for (let t = 0; t < seconds * 60; t++) {
      state.tick = t
      if (bot.think(state).some((c) => c.kind === 'cast' && c.slot === 7)) return true
    }
    return false
  }

  it('no difficulty starts a Scourge into an empty radius (enemy just outside its 250 reach)', () => {
    for (const d of ['easy', 'medium', 'hard', 'brutal', 'uber'] as const) expect(scourges(d, 270), d).toBe(false)
  })

  it('...but every difficulty does Scourge an enemy standing inside it', () => {
    for (const d of ['easy', 'medium', 'hard', 'brutal', 'uber'] as const) expect(scourges(d, 110), d).toBe(true)
  })

  it('value-based Scourge holds at low HP when the blast would not kill', () => {
    for (const d of ['hard', 'brutal', 'uber'] as const) expect(scourges(d, 110, 150), d).toBe(false)
  })

  it('a rooted enemy at the rim is worth it: it cannot walk out during the windup', () => {
    for (const d of ['brutal', 'uber'] as const) {
      const me = makePawn(BOT, 0, 0)
      me.slots[FIREBALL_SLOT] = null
      const rooted = makePawn(ENEMY, 215, 0, { modifiers: [{ id: 'grip', ticksLeft: 200, source: BOT, data: {} }] })
      const state = makeState([me, rooted])
      const bot = createBot(BOT, d, 5)
      let cast = false
      for (let t = 0; t < 600 && !cast; t++) {
        state.tick = t
        cast = bot.think(state).some((c) => c.kind === 'cast' && c.slot === 7)
      }
      expect(cast, d).toBe(true)
    }
  })
})

describe('bots: Uber build plan', () => {
  it('buys Teleport first, then Lightning, then Fireball upgrades, in order and as gold allows', () => {
    const state = makeState([makePawn(BOT, 0, 0), makePawn(ENEMY, 900, 0)], { phase: 'shop' })
    state.scores[0].gold = 30
    const bot = createBot(BOT, 'uber', 4)
    const buys: string[] = []
    for (let t = 0; t < 60 * 5; t++) {
      state.tick = t
      for (const c of bot.think(state)) {
        if (c.kind === 'buySpell' || c.kind === 'buyItem') {
          const id = c.kind === 'buySpell' ? c.spell : c.item
          buys.push(id)
          // grant it like the sim would, so the plan moves on
          const me = state.pawns[0]
          if (id === 'teleport') { me.slots[1] = 'teleport'; me.levels[1] = 1; state.scores[0].gold -= 12 }
          if (id === 'lightning') { me.slots[0] = 'lightning'; me.levels[0] = 1; state.scores[0].gold -= 11 }
          if (id === 'fireball') { me.levels[FIREBALL_SLOT] += 1; state.scores[0].gold -= 7 }
        }
      }
    }
    expect(buys).toEqual(['teleport', 'lightning', 'fireball'])
  })
})

