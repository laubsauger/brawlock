import { cloneState, createMatch, step as stepSim } from '../sim'
import { DEFAULT_SETTINGS, OBSTACLE_RADII } from '../sim/config'
import type { InputCommand, PlayerInput, PlayerSlot, SimEvent, SimState, Vec2 } from '../sim/types'
import { layerRadius } from './arenaGeom'

/** A quiet sparring lesson: aim at a rival, answer the shot, then recover the stance.
 * Shared simulation owns turning, casting, flight, reflection, damage and movement.
 * Only the choreography and gentle training settings belong to this render-only stage. */
export const MENU_LAYER = 14
export const MENU_FOCUS_ANGLE = -0.62
const ATTACK_EVERY = 240
const INTRO_TICKS = 120
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
        if (answer === 'shield' && moment === 24) inputs.push(input(defender, cast(SHIELD, sim.pawns[defender])))
        if (answer === 'sidestep' && moment === 18) inputs.push(input(defender, { kind: 'move', ...inward(defender) }))
        if (answer === 'teleport' && moment === 32) inputs.push(input(defender, cast(TELEPORT, inward(defender))))
        if (moment === 130) {
          // A quiet reset of the exercise, rather than a match that escalates into deaths.
          for (const pawn of sim.pawns) {
            pawn.hp = pawn.maxHp
            pawn.kbPoints = 0
            inputs.push(input(pawn.owner, { kind: 'move', ...homes[pawn.owner] }))
          }
        }
        if (moment === 210) {
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

/** A coven portrait, rather than a match: ten existing warlocks hold a quiet
 * ceremony on the arena rim. Cast states direct the existing rig and pooled
 * windup effects; no combat runs, so nothing fires into scenery or hurts a peer. */
export function createMenuTableau(theme = Math.floor(Math.random() * 3), seed = 41): MenuStage {
  const out = { x: Math.cos(MENU_FOCUS_ANGLE), y: Math.sin(MENU_FOCUS_ANGLE) }
  const tangent = { x: -out.y, y: out.x }
  const centre = layerRadius(MENU_LAYER) - 460
  const at = (along: number, depth: number): Vec2 => ({
    x: out.x * (centre + depth) + tangent.x * along,
    y: out.y * (centre + depth) + tangent.y * along,
  })
  // A forward conductor, a staggered inner crescent, then the five outer
  // witnesses. The gaps preserve hands/hood silhouettes instead of a flat wall.
  const marks = [
    [0, -250], [-215, -125], [215, -100], [-420, 35], [420, 65],
    [-560, 230], [-290, 240], [0, 255], [285, 265], [550, 245],
  ] as const
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
    Object.assign(pawn, at(marks[i][0], marks[i][1]))
    // Converging three-quarter stances face the audience, not one another.
    pawn.facing = Math.atan2(-out.y * 1500 - tangent.y * marks[i][0] * 0.35, -out.x * 1500 - tangent.x * marks[i][0] * 0.35)
    pawn.modifiers = []
    pawn.invulnerable = false
    pawn.cast = null
  }
  const radii = OBSTACLE_RADII[theme]
  sim.obstacles = [-1, 1].map((side, index) => ({
    id: sim.nextEntityId++, ...at(side * 770, -25), radius: radii[index], hp: 400, variant: index,
  }))

  // Only three channels can overlap. The conductor anchors the image; the
  // two slower replies travel across the crescent, with long idle rests.
  const gestures = [
    { player: 0, spell: 'gravity', start: 0, duration: 540 },
    { player: 3, spell: 'meteor', start: 210, duration: 300 },
    { player: 8, spell: 'shield', start: 420, duration: 240 },
    { player: 2, spell: 'lightning', start: 810, duration: 300 },
    { player: 6, spell: 'meteor', start: 1050, duration: 300 },
    { player: 0, spell: 'gravity', start: 1170, duration: 450 },
    { player: 4, spell: 'shield', start: 1470, duration: 240 },
  ] as const
  const cycle = 1920
  return {
    focus: at(0, 30),
    out,
    step() {
      sim.events.length = 0
      const moment = sim.tick % cycle
      for (const gesture of gestures) {
        const pawn = sim.pawns[gesture.player]
        const age = moment - gesture.start
        if (age === 0) {
          pawn.cast = {
            slot: 0, spell: gesture.spell, ticksLeft: gesture.duration,
            x: pawn.x + Math.cos(pawn.facing) * 260,
            y: pawn.y + Math.sin(pawn.facing) * 260, started: true,
          }
          sim.events.push({ type: 'castStart', pawn: pawn.id, spell: gesture.spell, ticks: gesture.duration })
        } else if (age > 0 && age < gesture.duration && pawn.cast?.spell === gesture.spell) {
          pawn.cast.ticksLeft = gesture.duration - age
        } else if (age === gesture.duration) {
          pawn.cast = null
          // A restrained hand/floor flourish, using the existing cast effect.
          // No projectile, explosion, damage, or simulation command is created.
          sim.events.push({ type: 'cast', pawn: pawn.id, spell: gesture.spell, x: pawn.x, y: pawn.y, level: 1 })
        }
      }
      sim.tick++
      const state = cloneState(sim)
      return { state, events: state.events }
    },
  }
}
