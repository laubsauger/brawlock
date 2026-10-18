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
