/**
 * Shield awareness (playtest bug): bots kept firing into a shielded enemy and died to their own
 * reflected shots. A Shield reflects and steals enemy projectiles (Swap, Gravity and Warpzone
 * excepted; Boomerang and Link are reflected but stay the caster's); Lightning stops at the
 * bubble. Alteration's bubble swaps the first projectile with its caster.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, DT, FIREBALL_SLOT, TICK_HZ, createMatch, step, ticks } from '../sim'
import type { BotDifficulty, InputCommand, PawnState, PlayerSlot, SimState } from '../sim'
import { BOT_PRESETS, createBot } from './index'
import { makeFireball, makePawn, makeState } from './fixtures'

const SHIELD_SLOT = 4 // column 5
const BOT = 0
const ENEMY = 1

/**
 * A scripted human turtle: stands near the centre, shields enemy shots and fires a Fireball at
 * the bot every few seconds (so the bot carries damage and knockback, as in a fight). `early`:
 * it also raises the bubble as soon as the bot comes within 900 (baiting shots into it).
 */
function turtle(state: SimState, me: PawnState, foe: PawnState, early: boolean): InputCommand[] {
  if (!me.alive || state.phase !== 'fight') return []
  const ready = me.slots[SHIELD_SLOT] === 'shield' && me.cooldowns[SHIELD_SLOT] === 0 && !me.modifiers.some((m) => m.id === 'shield')
  const shield: InputCommand[] = [{ kind: 'cast', slot: SHIELD_SLOT, x: me.x, y: me.y }]
  if (ready && early && foe.alive && Math.hypot(foe.x - me.x, foe.y - me.y) < 900) return shield
  if (ready) {
    for (const p of state.projectiles) {
      if (p.owner === me.owner) continue
      const dx = me.x - p.x
      const dy = me.y - p.y
      if (Math.hypot(dx, dy) < 320 && p.vx * dx + p.vy * dy > 0) return shield
    }
  }
  if (foe.alive && me.cooldowns[FIREBALL_SLOT] === 0 && !me.cast && state.tick % ticks(2.5) === 0) return [{ kind: 'cast', slot: FIREBALL_SLOT, x: foe.x, y: foe.y }]
  return Math.hypot(me.x, me.y) > 250 ? [{ kind: 'move', x: 0, y: 0 }] : []
}

/** Tracks shots a Shield stole and counts the ones that hit their own caster. */
function reflectWatch() {
  const reflected = new Map<number, number>() // projectile id -> original owner
  const hits = new Map<number, number>() // victim owner -> count
  const hitIds: number[] = [] // the projectiles that did
  return {
    hits,
    hitIds,
    observe(state: SimState) {
      for (const e of state.events) {
        if (e.type === 'shieldReflect' && e.stolen) {
          const pr = state.projectiles.find((p) => p.id === e.projectile)
          if (pr && pr.data.origOwner !== undefined) reflected.set(pr.id, pr.data.origOwner)
        }
        if (e.type === 'projectileHit' && e.target !== null && reflected.has(e.id)) {
          const victim = state.pawns.find((p) => p.id === e.target)
          if (victim && victim.owner === reflected.get(e.id)) {
            hits.set(victim.owner, (hits.get(victim.owner) ?? 0) + 1)
            hitIds.push(e.id)
          }
        }
      }
    },
  }
}

/** Real sim: a bot against the shield turtle (Shield level 7: 8 s cooldown) for `seconds`. */
function againstTurtle(difficulty: BotDifficulty, seed: number, early: boolean, seconds = 180) {
  const slots: PlayerSlot[] = [
    { id: BOT, name: 'bot', color: 0xff0000, team: 0, kind: 'bot', difficulty },
    { id: ENEMY, name: 'turtle', color: 0x0000ff, team: 1, kind: 'human' },
  ]
  const state = createMatch({ ...DEFAULT_SETTINGS, winScore: 99 }, slots, seed)
  const bot = createBot(BOT, difficulty, seed * 31)
  expect(BOT_PRESETS[difficulty].reactionDelay, 'decisions are read from the reaction queue').toBeGreaterThan(0)
  const watch = reflectWatch()
  let shots = 0
  // was the turtle's bubble up when the bot decided the cast its projectiles come from?
  let lastAt = -1
  let decidedIntoBubble = false
  const intoBubble = new Map<number, boolean>() // our projectile id -> decided while a bubble was up
  for (let i = 0; i < ticks(seconds); i++) {
    const t = state.pawns.find((p) => p.owner === ENEMY)!
    const b = state.pawns.find((p) => p.owner === BOT)!
    t.slots[SHIELD_SLOT] = 'shield'
    t.levels[SHIELD_SLOT] = 7
    const cmds = bot.think(state)
    const queued = bot.scheduled!()
    const last = queued[queued.length - 1]
    if (last && last.at > lastAt) {
      lastAt = last.at
      if (last.cmds.some((c) => c.kind === 'cast')) decidedIntoBubble = t.modifiers.some((m) => m.id === 'shield')
    }
    step(state, [
      { player: BOT, tick: state.tick, cmds },
      { player: ENEMY, tick: state.tick, cmds: turtle(state, t, b, early) },
    ])
    for (const p of state.projectiles) {
      if ((p.owner === BOT || p.data.origOwner === BOT) && !intoBubble.has(p.id)) intoBubble.set(p.id, decidedIntoBubble)
    }
    watch.observe(state)
    for (const e of state.events) if (e.type === 'cast' && e.pawn === b.id && e.spell !== 'teleport') shots++
  }
  const into = watch.hitIds.filter((id) => intoBubble.get(id)).length
  return { selfHits: watch.hits.get(BOT) ?? 0, intoBubble: into, shots }
}

/** Fixture: the bot at the origin with only a Fireball to shoot, the enemy `d` units east. */
function duel(d: number, enemyPatch: Partial<PawnState> = {}) {
  const me = makePawn(BOT, 0, 0)
  const foe = makePawn(ENEMY, d, 0, enemyPatch)
  foe.slots[FIREBALL_SLOT] = null
  return makeState([me, foe])
}

/** First tick the bot casts its Fireball at the enemy, running the enemy's bubble down as it goes. */
function firstFireball(difficulty: BotDifficulty, state: SimState, n = ticks(7)): number | null {
  const bot = createBot(BOT, difficulty, 5)
  const foe = state.pawns.find((p) => p.owner === ENEMY)!
  for (let t = 0; t < n; t++) {
    state.tick = t
    if (bot.think(state).some((c) => c.kind === 'cast' && c.slot === FIREBALL_SLOT)) return t
    for (const m of foe.modifiers) if (m.ticksLeft > 0) m.ticksLeft--
    foe.modifiers = foe.modifiers.filter((m) => m.ticksLeft !== 0)
  }
  return null
}

describe('bots: Shield awareness', () => {
  it('holds fire while a Shield bubble would still be up when the Fireball arrives, then fires', () => {
    for (const d of ['medium', 'hard', 'brutal', 'uber'] as const) {
      // a long bubble (4 s: duration mastery) on an enemy 700 away that does not own Shield
      // itself (an ally's): the shot takes reaction + 0.2 s windup + 0.5 s flight to the bubble
      const UP = ticks(4)
      const bubble = () => duel(700, { modifiers: [{ id: 'shield', ticksLeft: UP, source: ENEMY, data: { radius: 200 } }] })
      const arrive = (BOT_PRESETS[d].reactionDelay + 0.2 + (700 - 200) / 1000) * TICK_HZ
      // without the bubble this bot fires while such a bubble would still be up ...
      const free = firstFireball(d, duel(700), ticks(25))
      expect(free, d).not.toBeNull()
      expect(UP - free!, `${d}: the control must shoot into the bubble`).toBeGreaterThan(arrive)
      // ... with it, only once the shot would get there after the bubble drops
      const t = firstFireball(d, bubble(), ticks(25))
      expect(t, d).not.toBeNull()
      expect(UP - t!, `${d} fired with ${UP - t!} ticks of bubble left, arriving in ${arrive.toFixed(0)}`).toBeLessThanOrEqual(arrive)
      // from release (t is when the order reaches the sim) the bolt's front (radius 25) reaches
      // the bubble after the 0.2 s windup; the bubble must be gone 0.1 s before that, not a tick
      // or two (the old self-hits; Uber here had 5.5 ticks)
      const front = (0.2 + (700 - 200 - 25) / 1000) * TICK_HZ
      expect(front - (UP - t!), `${d}: ticks between the bubble dropping and the bolt arriving`).toBeGreaterThanOrEqual(ticks(0.1))
    }
  })

  it('wastes no Lightning on a bubble: the beam stops there', () => {
    const s = duel(500, { modifiers: [{ id: 'alteration', ticksLeft: ticks(10), source: ENEMY, data: { radius: 120 } }] })
    const me = s.pawns[0]
    me.slots[0] = 'lightning'
    me.slots[FIREBALL_SLOT] = null
    const bot = createBot(BOT, 'hard', 3)
    for (let t = 0; t < ticks(5); t++) {
      s.tick = t
      expect(bot.think(s).some((c) => c.kind === 'cast' && c.slot === 0), `tick ${t}`).toBe(false)
    }
  })

  it('takes no close shot at an enemy holding a ready Shield (it would be back before a sidestep), shoots from afar', () => {
    const owns = (dist: number) => {
      const s = duel(dist)
      s.pawns[1].slots[SHIELD_SLOT] = 'shield'
      s.pawns[1].levels[SHIELD_SLOT] = 1
      return s
    }
    for (const d of ['medium', 'hard', 'brutal', 'uber'] as const) expect(firstFireball(d, owns(450), ticks(5)), `${d} at 450`).toBeNull()
    // (Uber's shot gate skips long shots at a target free to walk: tested elsewhere)
    for (const d of ['medium', 'hard', 'brutal'] as const) expect(firstFireball(d, owns(950), ticks(10)), `${d} at 950`).not.toBeNull()
    // not so a Drain: stolen, it re-aims at the closest pawn but its new owner, the caster.
    // (Most of the bait shots that came back did so as a Drain: 7 of 8 over 200 turtle runs.)
    const DRAIN_SLOT = 2
    for (const d of ['medium', 'hard', 'brutal'] as const) {
      const s = owns(950)
      s.pawns[0].slots[FIREBALL_SLOT] = null
      s.pawns[0].slots[DRAIN_SLOT] = 'drain'
      s.pawns[0].levels[DRAIN_SLOT] = 1
      const bot = createBot(BOT, d, 5)
      for (let t = 0; t < ticks(10); t++) {
        s.tick = t
        expect(bot.think(s).some((c) => c.kind === 'cast' && c.slot === DRAIN_SLOT), `${d} Drain at 950, tick ${t}`).toBe(false)
      }
    }
  })

  it('dodges its own Fireball coming back off a Shield (a bot that stands still is hit)', () => {
    const run = (difficulty: BotDifficulty | null, k: number) => {
      const slots: PlayerSlot[] = [
        { id: BOT, name: 'bot', color: 0xff0000, team: 0, kind: 'bot', difficulty: difficulty ?? 'dummy' },
        { id: ENEMY, name: 'turtle', color: 0x0000ff, team: 1, kind: 'human' },
      ]
      const state = createMatch({ ...DEFAULT_SETTINGS }, slots, 50 + k)
      for (let i = 0; i < ticks(60) && state.phase !== 'fight'; i++) step(state, [])
      for (let i = 0; i < ticks(2.5); i++) step(state, [])
      state.obstacles = []
      const me = state.pawns.find((p) => p.owner === BOT)!
      const foe = state.pawns.find((p) => p.owner === ENEMY)!
      const a = (k / 6) * Math.PI * 2
      for (const [p, r] of [
        [me, -350],
        [foe, 350],
      ] as const) {
        p.x = Math.cos(a) * r
        p.y = Math.sin(a) * r
        p.vx = p.vy = p.walkVx = p.walkVy = 0
        p.moveTarget = null
      }
      foe.slots[SHIELD_SLOT] = 'shield'
      foe.levels[SHIELD_SLOT] = 1
      const bot = difficulty ? createBot(BOT, difficulty, 9 + k) : null
      const watch = reflectWatch()
      // our Fireball is already on its way (cast before the bot takes over)
      step(state, [{ player: BOT, tick: state.tick, cmds: [{ kind: 'cast', slot: FIREBALL_SLOT, x: foe.x, y: foe.y }] }])
      for (let i = 0; i < ticks(3); i++) {
        const shield =
          foe.cooldowns[SHIELD_SLOT] === 0 && state.projectiles.some((p) => p.owner === BOT && Math.hypot(p.x - foe.x, p.y - foe.y) < 450)
        step(state, [
          { player: BOT, tick: state.tick, cmds: bot ? bot.think(state) : [] },
          { player: ENEMY, tick: state.tick, cmds: shield ? [{ kind: 'cast', slot: SHIELD_SLOT, x: foe.x, y: foe.y }] : [] },
        ])
        watch.observe(state)
      }
      return watch.hits.get(BOT) ?? 0
    }
    for (let k = 0; k < 4; k++) {
      expect(run(null, k), `#${k}: the reflected shot must come back on course`).toBe(1)
      for (const d of ['hard', 'brutal', 'uber'] as const) expect(run(d, k), `${d} #${k}`).toBe(0)
    }
  })

  it('raises its own Shield against a bolt about to hit (hard and up every time, easy rarely), not for a miss', () => {
    const incoming = (difficulty: BotDifficulty, seed: number, offset = 0, spell = 'fireball') => {
      const me = makePawn(BOT, 0, 0)
      me.slots[SHIELD_SLOT] = 'shield'
      me.levels[SHIELD_SLOT] = 1
      me.slots[FIREBALL_SLOT] = null
      const s = makeState([me, makePawn(ENEMY, 2000, 0)])
      const bolt = makeFireball(ENEMY, 900, offset, -1000, 0)
      bolt.spell = spell
      s.projectiles.push(bolt)
      const bot = createBot(BOT, difficulty, seed)
      for (let t = 0; t < ticks(2 / 3); t++) {
        s.tick = t
        if (bot.think(s).some((c) => c.kind === 'cast' && c.slot === SHIELD_SLOT)) return true
        bolt.x += bolt.vx * DT
      }
      return false
    }
    for (const d of ['hard', 'brutal', 'uber'] as const) {
      for (let seed = 1; seed <= 5; seed++) {
        expect(incoming(d, seed), `${d} seed ${seed}`).toBe(true)
        expect(incoming(d, seed, 250), `${d} seed ${seed}: a bolt passing 250 wide is no reason`).toBe(false)
        expect(incoming(d, seed, 0, 'gravity'), `${d} seed ${seed}: Gravity is not reflected`).toBe(false)
      }
    }
    const easy = Array.from({ length: 20 }, (_, i) => incoming('easy', i + 1)).filter(Boolean).length
    expect(easy).toBeLessThan(10)
  })

  it('against a shield user, bots almost never eat their own reflected shots (were 30-40 per 16 min)', () => {
    // before the fix: 31-43 own shots back per difficulty over 4 x 240 s against the reactive
    // turtle, 4-13 against the early one. Until 2026-10-21 4 remained here, each a shot decided
    // while the bubble was up and timed to meet it a few ticks before it dropped (no closing
    // speed, the bolt's centre instead of its front, a margin the wrong way); 83 of 111 over 600
    // runs (5 tiers x 60 seeds x both turtles). The bot now holds until the bubble will be gone
    // 0.1 s before its shot gets there, so none of those may come back. Left over, 4 in the same
    // 600 runs: a bait shot from the stand-off at a Shield raised only after release, which the
    // bot then fails to step out of. One such is allowed here so a reseeded bot does not trip it.
    let total = 0
    let intoBubble = 0
    for (const early of [false, true])
      for (const d of ['medium', 'hard', 'uber'] as const)
        for (let seed = 1; seed <= 2; seed++) {
          const r = againstTurtle(d, seed, early)
          expect(r.shots, `${d} still fights`).toBeGreaterThan(10)
          total += r.selfHits
          intoBubble += r.intoBubble
        }
    expect(intoBubble, 'own shots back from a bubble that was up when the bot chose to shoot').toBe(0)
    expect(total).toBeLessThanOrEqual(1)
  }, 60_000)
})
