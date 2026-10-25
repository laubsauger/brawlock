import { cloneState, createMatch, step as stepSim } from '../sim'
import { DEFAULT_SETTINGS, OBSTACLE_RADII, ticks } from '../sim/config'
import { spawnProjectile } from '../sim/projectiles'
import { DT, onTickRate } from '../sim/types'
import type { InputCommand, PlayerInput, PlayerSlot, SimEvent, SimState, Vec2 } from '../sim/types'
import { layerRadius } from './arenaGeom'
import { BotController } from '../bots'
import { Rng } from '../bots/prng'

/** A quiet sparring lesson: aim at a rival, answer the shot, then recover the stance.
 * Shared simulation owns turning, casting, flight, reflection, damage and movement.
 * Only the choreography and gentle training settings belong to this render-only stage. */
export const MENU_LAYER = 14
export const MENU_FOCUS_ANGLE = -0.62
let ATTACK_EVERY = 0
let INTRO_TICKS = 0
onTickRate(() => {
  ATTACK_EVERY = ticks(4)
  INTRO_TICKS = ticks(2)
})
const PHRASE_BEATS = 8
const FIREBALL = 0
const SHIELD = 1
const TELEPORT = 2
const ANSWERS = ['hit', 'shield', 'sidestep', 'hit', 'teleport', 'hit', 'hit', 'hit'] as const

export interface MenuStage {
  step(): { state: SimState; events: SimEvent[] }
  readonly focus: Vec2
  readonly out: Vec2
}

/** Real, private combat. Bots shop from their seeded build pools, move, dodge,
 * land hits and finish rounds; nothing is registered as a player session. */
export function createMenuBattle(seed = Math.floor(Math.random() * 0x1_0000_0000)): MenuStage {
  const rng = new Rng(seed)
  const names = ['Sunbinder', 'Tidecaller', 'Nightveil', 'Ashkeeper', 'Stormwatch', 'Runewarden', 'Mosscloak', 'Dusksinger']
  const colors = [0xffb957, 0x4bdac9, 0xb98cff, 0xe66d52, 0x80bafa, 0xd1a367, 0x86b874, 0xd57fb4]
  const slots: PlayerSlot[] = names.map((name, id) => ({ id, name, color: colors[id], team: id, kind: 'bot', difficulty: id % 2 ? 'uber' : 'brutal' }))
  let bots: BotController[] = []
  let sim: SimState
  const advance = () => stepSim(sim, bots.map((bot) => ({ player: bot.player, tick: sim.tick, cmds: bot.think(sim) })))
  const begin = (tick: number) => {
    const matchSeed = rng.int(0x1_0000_0000)
    sim = createMatch({ ...DEFAULT_SETTINGS, winScore: 3, startGold: 110, roundGold: 12, shopSeconds: 7, spectatorBets: false, bounties: false }, slots, matchSeed)
    // Keep the renderer's event timeline monotonic across fresh matches.
    sim.tick = tick
    bots = slots.map((slot) => new BotController(slot.id, slot.difficulty!, matchSeed))
    // Finish genuine buying and the opening approach before showing a new
    // match. Subsequent rounds retain their short visible recovery and shop.
    for (let i = 0; i < ticks(11); i++) advance()
    sim.settings.shopSeconds = 2
  }
  begin(0)
  const focus = { x: 0, y: 0 }
  const follow = () => {
    const alive = sim.pawns.filter((pawn) => pawn.alive)
    if (!alive.length) return
    let x = 0
    let y = 0
    for (const pawn of alive) { x += pawn.x; y += pawn.y }
    // Two-second tracking eases through knockbacks and deaths instead of
    // making the lens chase every projectile or switch targets abruptly.
    focus.x += (x / alive.length - focus.x) * 0.48 * DT
    focus.y += (y / alive.length - focus.y) * 0.48 * DT
  }
  return {
    focus,
    out: { x: Math.cos(MENU_FOCUS_ANGLE), y: Math.sin(MENU_FOCUS_ANGLE) },
    step() {
      if (sim.phase === 'gameOver') begin(sim.tick)
      advance()
      follow()
      const state = cloneState(sim)
      return { state, events: state.events }
    },
  }
}

export function createMenuStage(theme = Math.floor(Math.random() * 3), seed = 41): MenuStage {
  const out = { x: Math.cos(MENU_FOCUS_ANGLE), y: Math.sin(MENU_FOCUS_ANGLE) }
  const tangent = { x: -out.y, y: out.x }
  const centre = layerRadius(MENU_LAYER) - 300
  const at = (along: number, depth: number): Vec2 => ({
    x: out.x * (centre + depth) + tangent.x * along,
    y: out.y * (centre + depth) + tangent.y * along,
  })
  const homes = [at(-310, -40), at(310, -40)]
  const slots: PlayerSlot[] = [
    { id: 0, name: 'Emberveil', color: 0xff5a36, team: 0, kind: 'bot' },
    { id: 1, name: 'Tidecaller', color: 0x2ee6c9, team: 1, kind: 'bot' },
  ]
  const sim = createMatch({ ...DEFAULT_SETTINGS, shopSeconds: 0, dmgMultiplier: 0.35, kbMultiplier: 0.25 }, slots, seed)
  sim.phase = 'fight'
  sim.phaseTicksLeft = -1
  sim.round = 1
  sim.arena = { layer: MENU_LAYER, nextShrinkTick: -1, theme }
  sim.events = []
  for (const [index, pawn] of sim.pawns.entries()) {
    Object.assign(pawn, homes[index])
    const other = homes[1 - index]
    pawn.facing = Math.atan2(other.y - pawn.y, other.x - pawn.x)
    pawn.modifiers = []
    pawn.invulnerable = false
    pawn.slots = ['fireball', 'shield', 'teleport']
    pawn.levels = [1, 1, 1]
    pawn.cooldowns = [0, 0, 0]
  }
  // Theme ruins frame the lesson from behind; neither blocks the attack lane or a dodge.
  const radii = OBSTACLE_RADII[theme]
  sim.obstacles = [-1, 1].map((side, index) => ({
    id: sim.nextEntityId++, ...at(side * 610, -300), radius: radii[index], hp: 400, variant: index,
  }))

  let attacker = 0
  let defender = 1
  let answer: typeof ANSWERS[number] = 'hit'
  let beatStart = -1
  const input = (player: number, ...cmds: InputCommand[]): PlayerInput => ({ player, tick: sim.tick, cmds })
  const cast = (slot: number, point: Vec2): InputCommand => ({ kind: 'cast', slot, x: point.x, y: point.y })
  const inward = (player: number) => ({ x: homes[player].x - out.x * 180, y: homes[player].y - out.y * 180 })

  return {
    focus: at(0, -40),
    out,
    step() {
      const inputs: PlayerInput[] = []
      const elapsed = sim.tick - INTRO_TICKS
      if (elapsed >= 0 && elapsed % ATTACK_EVERY === 0) {
        const beat = elapsed / ATTACK_EVERY
        const phrase = Math.floor(beat / PHRASE_BEATS)
        attacker = beat % 2
        defender = 1 - attacker
        answer = ANSWERS[(beat + phrase) % PHRASE_BEATS]
        beatStart = sim.tick
        inputs.push(input(attacker, cast(FIREBALL, sim.pawns[defender])), input(defender, { kind: 'stop' }))
      }
      if (beatStart >= 0) {
        const moment = sim.tick - beatStart
        if (answer === 'shield' && moment === ticks(0.4)) inputs.push(input(defender, cast(SHIELD, sim.pawns[defender])))
        if (answer === 'sidestep' && moment === ticks(0.3)) inputs.push(input(defender, { kind: 'move', ...inward(defender) }))
        if (answer === 'teleport' && moment === ticks(0.53)) inputs.push(input(defender, cast(TELEPORT, inward(defender))))
        if (moment === ticks(2.17)) {
          // A quiet reset of the exercise, rather than a match that escalates into deaths.
          for (const pawn of sim.pawns) {
            pawn.hp = pawn.maxHp
            pawn.kbPoints = 0
            inputs.push(input(pawn.owner, { kind: 'move', ...homes[pawn.owner] }))
          }
        }
        if (moment === ticks(3.5)) {
          for (const pawn of sim.pawns) {
            const rival = sim.pawns[1 - pawn.owner]
            pawn.facing = Math.atan2(rival.y - pawn.y, rival.x - pawn.x)
          }
        }
      }
      stepSim(sim, inputs)
      const state = cloneState(sim)
      return { state, events: state.events }
    },
  }
}

/** A rehearsed coven exercise. Cast/release/flight/impact use the same snapshot
 * and event contracts as combat, without running AI, damage or match physics.
 * Each ray ends in the clear floor inside the crescent, never in a peer or ruin. */
export function createMenuTableau(theme = Math.floor(Math.random() * 3), seed = 41): MenuStage {
  const out = { x: Math.cos(MENU_FOCUS_ANGLE), y: Math.sin(MENU_FOCUS_ANGLE) }
  const tangent = { x: -out.y, y: out.x }
  const centre = layerRadius(MENU_LAYER) - 460
  const at = (along: number, depth: number): Vec2 => ({
    x: out.x * (centre + depth) + tangent.x * along,
    y: out.y * (centre + depth) + tangent.y * along,
  })
  const target = at(0, -330)
  // A shallow crescent leaves each performer's hands and entire firing lane
  // visible. Its open side faces the camera; the practice floor is in front.
  const angles = [-1.2, -0.94, -0.69, -0.44, -0.18, 0.18, 0.44, 0.69, 0.94, 1.2]
  const colors = [0xffb957, 0x4bdac9, 0xb98cff, 0xe66d52, 0x80bafa, 0xd1a367, 0x86b874, 0xd57fb4, 0x87c8d0, 0xd4bd8a]
  const names = ['Sunbinder', 'Tidecaller', 'Nightveil', 'Ashkeeper', 'Stormwatch', 'Runewarden', 'Mosscloak', 'Dusksinger', 'Frostseer', 'Dawnguard']
  const slots: PlayerSlot[] = names.map((name, id) => ({ id, name, color: colors[id], team: id, kind: 'bot' }))
  const sim = createMatch({ ...DEFAULT_SETTINGS, shopSeconds: 0 }, slots, seed)
  sim.phase = 'fight'
  sim.phaseTicksLeft = -1
  sim.round = 1
  sim.arena = { layer: MENU_LAYER, nextShrinkTick: -1, theme }
  sim.events = []
  for (let i = 0; i < sim.pawns.length; i++) {
    const pawn = sim.pawns[i]
    const radius = i % 2 ? 595 : 550
    Object.assign(pawn, at(Math.sin(angles[i]) * radius, -330 + Math.cos(angles[i]) * radius))
    pawn.facing = Math.atan2(target.y - pawn.y, target.x - pawn.x)
    pawn.modifiers = []
    pawn.invulnerable = false
    pawn.cast = null
  }
  const radii = OBSTACLE_RADII[theme]
  sim.obstacles = [-1, 1].map((side, index) => ({
    id: sim.nextEntityId++, ...at(side * 770, -25), radius: radii[index], hp: 400, variant: index,
  }))

  // A paired opening, then individual replies with breathing room. All ten
  // release once per 31-second phrase; no charge is abandoned or held forever.
  // Start, duration and cycle in seconds.
  const gestures = [
    { player: 0, spell: 'fireball', start: 0.4, duration: 0.7 },
    { player: 9, spell: 'homing', start: 1.1, duration: 0.8 },
    { player: 2, spell: 'homing', start: 3.5, duration: 0.7 },
    { player: 7, spell: 'fireball', start: 6.5, duration: 0.6 },
    { player: 4, spell: 'fireball', start: 9.5, duration: 0.7 },
    { player: 5, spell: 'homing', start: 12.5, duration: 0.8 },
    { player: 1, spell: 'fireball', start: 15.5, duration: 0.6 },
    { player: 8, spell: 'homing', start: 18.5, duration: 0.7 },
    { player: 3, spell: 'homing', start: 21.5, duration: 0.8 },
    { player: 6, spell: 'fireball', start: 24.5, duration: 0.6 },
  ] as const
  const cycle = 31
  return {
    focus: at(0, -30),
    out,
    step() {
      sim.events.length = 0
      // This is a straight rehearsed flight, not collision or combat simulation.
      // Lifetime is the measured distance to the practice point, so the final
      // step cannot overshoot it or leave an immortal projectile behind.
      for (let i = sim.projectiles.length - 1; i >= 0; i--) {
        const projectile = sim.projectiles[i]
        const fraction = Math.min(1, projectile.ticksLeft)
        projectile.x += projectile.vx * DT * fraction
        projectile.y += projectile.vy * DT * fraction
        projectile.ticksLeft -= 1
        if (projectile.ticksLeft <= 0) {
          sim.events.push({ type: 'projectileHit', id: projectile.id, spell: projectile.spell, x: projectile.x, y: projectile.y, target: null })
          sim.projectiles.splice(i, 1)
        }
      }
      const moment = sim.tick % ticks(cycle)
      for (const gesture of gestures) {
        const pawn = sim.pawns[gesture.player]
        const age = moment - ticks(gesture.start)
        const duration = ticks(gesture.duration)
        if (age === 0) {
          pawn.cast = { slot: 0, spell: gesture.spell, ticksLeft: duration, ...target, started: true }
          sim.events.push({ type: 'castStart', pawn: pawn.id, spell: gesture.spell, ticks: duration })
        } else if (age > 0 && age < duration) {
          pawn.cast!.ticksLeft = duration - age
        } else if (age === duration) {
          pawn.cast = null
          sim.events.push({ type: 'cast', pawn: pawn.id, spell: gesture.spell, ...target, level: 1 })
          const dx = target.x - pawn.x
          const dy = target.y - pawn.y
          const distance = Math.hypot(dx, dy)
          const speed = 500
          const muzzle = 55
          spawnProjectile(sim, pawn.owner, gesture.spell,
            pawn.x + dx / distance * muzzle, pawn.y + dy / distance * muzzle,
            dx / distance * speed, dy / distance * speed, 25,
            { lifetime: (distance - muzzle) / speed, rangeMastery: false, level: 1, data: { target: -1 } })
        }
      }
      sim.tick++
      const state = cloneState(sim)
      return { state, events: state.events }
    },
  }
}
