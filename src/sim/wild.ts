/**
 * Wild (docs/moonshot/specs/wild.md): the classic game with an omen over every round, a custom
 * lobby option. At the shop before each round from the second on, one omen is drawn from the
 * lobby's deck (never the same twice running) and for that round the world has one new rule:
 * - Blood Moon: knockback x1.5
 * - Slick Stone: friction 0.975 (every slide runs long)
 * - Overcharge: cooldowns run at double speed
 * - Sudden Collapse: a ring every 4 s
 * - Meteor Shower: neutral meteors fall near warlocks, more often as the round goes on
 * - Pillar Storm: pillars burst out of the floor at warned spots, explode when broken
 * Wild also turns on spell reactions (Shatter, Nova, Fork; see the spells). Off, nothing here runs
 * and the classic game is untouched (no random draw is taken).
 */
import { isLocationSafe } from './arena'
import { OBSTACLE_HP, ticks } from './config'
import { cos, sin, TAU } from './math'
import { spawnProjectile } from './projectiles'
import { random, randomInt } from './rng'
import { SPELLS, attr } from './spells/data'
import { NEUTRAL_OWNER, isRoundParticipant } from './teams'
import type { MatchSettings, SimState } from './types'

export type OmenId = 'bloodMoon' | 'slickStone' | 'overcharge' | 'suddenCollapse' | 'meteorShower' | 'pillarStorm'
/** the first deck (2026-10-29); the lobby's bitmask follows this order */
export const OMEN_IDS: readonly OmenId[] = ['bloodMoon', 'slickStone', 'overcharge', 'suddenCollapse', 'meteorShower', 'pillarStorm']
export const ALL_OMENS = (1 << OMEN_IDS.length) - 1

export const WILD_KB = 1.5
export const WILD_FRICTION = 0.975
export const WILD_COOLDOWN_RATE = 2
export const WILD_SHRINK_SECONDS = 4
/** Meteor Shower: first fall, then a shrinking gap (s) */
const METEOR_FIRST = 3
const METEOR_GAP = 4.5
const METEOR_GAP_MIN = 2
const METEOR_GAP_STEP = 0.3
/** the shower's meteors hit like a level-3 Meteor */
const METEOR_LEVEL = 3
/** Pillar Storm: first warning, the gap between, and how long a warning lasts (s) */
const PILLAR_FIRST = 4
const PILLAR_GAP = 5.5
export const PILLAR_WARN = 1.1
export const PILLAR_RADIUS = 90
const PILLAR_SECONDS = 6
/** a spot near a warlock: within this distance of one */
const NEAR = 220

/** Wild applies: the lobby switched it on, in classic Rounds outside ranked. */
export function wildOn(settings: Pick<MatchSettings, 'wild' | 'gameMode' | 'rankedRounds'>): boolean {
  return settings.wild === true && settings.gameMode === 'rounds' && !settings.rankedRounds
}

export function omenOf(state: Pick<SimState, 'omen'>): OmenId | null {
  return state.omen ?? null
}

/** knockback multiplier this round (Blood Moon) */
export function kbMultiplierOf(state: Pick<SimState, 'settings' | 'omen'>): number {
  return state.settings.kbMultiplier * (state.omen === 'bloodMoon' ? WILD_KB : 1)
}

/** friction this round (Slick Stone) */
export function frictionOf(state: Pick<SimState, 'settings' | 'omen'>): number {
  return state.omen === 'slickStone' ? WILD_FRICTION : state.settings.friction
}

/** cooldown ticks per tick this round (Overcharge) */
export function cooldownRateOf(state: Pick<SimState, 'omen'>): number {
  return state.omen === 'overcharge' ? WILD_COOLDOWN_RATE : 1
}

/** The omen of round `round` (drawn at its shop): none in the first round or without Wild. */
export function drawOmen(state: SimState, round: number): void {
  const previous = state.omen ?? null
  delete state.omen
  delete state.omenClock
  if (!wildOn(state.settings) || round <= 1) return
  const mask = state.settings.wildOmens ?? ALL_OMENS
  let deck = OMEN_IDS.filter((_, i) => (mask & (1 << i)) !== 0)
  if (deck.length > 1) deck = deck.filter((o) => o !== previous)
  if (deck.length === 0) return
  const omen = deck[randomInt(state, 0, deck.length - 1)]
  state.omen = omen
  state.events.push({ type: 'omen', omen, round })
}

/** A safe spot near a living warlock (or nowhere). */
function spotNearWarlock(state: SimState): { x: number; y: number } | null {
  const alive = state.pawns.filter((p) => p.alive && isRoundParticipant(state, p.owner))
  if (alive.length === 0) return null
  for (let i = 0; i < 6; i++) {
    const p = alive[randomInt(state, 0, alive.length - 1)]
    const a = random(state) * TAU
    const r = random(state) * NEAR
    const x = p.x + cos(a) * r
    const y = p.y + sin(a) * r
    if (isLocationSafe(state, x, y)) return { x, y }
  }
  return null
}

/** One fight tick of the round's omen: the shower's meteors and the storm's pillars. */
export function omenTick(state: SimState): void {
  const omen = state.omen
  if (state.phase !== 'fight' || (omen !== 'meteorShower' && omen !== 'pillarStorm')) return
  const clock = (state.omenClock ??= { next: ticks(omen === 'meteorShower' ? METEOR_FIRST : PILLAR_FIRST), count: 0, pillars: [] })
  clock.next -= 1
  if (omen === 'pillarStorm') {
    for (const p of clock.pillars) p.left -= 1
    for (const p of clock.pillars.filter((q) => q.left <= 0)) {
      state.obstacles.push({ id: state.nextEntityId++, x: p.x, y: p.y, radius: PILLAR_RADIUS, hp: OBSTACLE_HP, variant: -1, ticksLeft: ticks(PILLAR_SECONDS), owner: NEUTRAL_OWNER })
    }
    clock.pillars = clock.pillars.filter((q) => q.left > 0)
  }
  if (clock.next > 0) return
  clock.count++
  const spot = spotNearWarlock(state)
  if (omen === 'meteorShower') {
    clock.next = ticks(Math.max(METEOR_GAP_MIN, METEOR_GAP - METEOR_GAP_STEP * clock.count))
    if (spot) spawnMeteor(state, spot.x, spot.y)
  } else {
    clock.next = ticks(PILLAR_GAP)
    if (spot) {
      clock.pillars.push({ x: spot.x, y: spot.y, left: ticks(PILLAR_WARN) })
      state.events.push({ type: 'omenWarning', omen, x: spot.x, y: spot.y, ticks: ticks(PILLAR_WARN) })
    }
  }
}

/** A neutral Meteor falling on (x, y): it hovers, then dives, like a cast one (its hover is the warning). */
function spawnMeteor(state: SimState, x: number, y: number): void {
  const def = SPELLS.meteor
  const level = METEOR_LEVEL
  const a = random(state) * TAU
  const back = attr(def, 'spawn_back', level)
  spawnProjectile(state, NEUTRAL_OWNER, 'meteor', x - cos(a) * back, y - sin(a) * back, 0, 0, 0, {
    level,
    lifetime: null,
    data: {
      tx: x, ty: y, z: attr(def, 'spawn_z', level), z0: attr(def, 'spawn_z', level),
      hoverTicks: ticks(attr(def, 'hover_time', level)), fallTicks: ticks(attr(def, 'fall_time', level)),
      fallTime: attr(def, 'fall_time', level), hoverTime: attr(def, 'hover_time', level),
      elapsed: 0, falling: 0, vz: 0,
      damageMin: attr(def, 'damage_min', level), damageMax: attr(def, 'damage_max', level),
      radius: attr(def, 'radius', level), kb: attr(def, 'knockback_factor', level), omen: 1,
    },
  })
}
