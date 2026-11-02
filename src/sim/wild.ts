/**
 * Wild (docs/moonshot/specs/wild.md): the classic game with omens over the rounds, a custom lobby
 * option. At the shop before each round from the second on, omens are drawn from the lobby's deck
 * (none of last round's when the deck allows) and for that round the world has their rules:
 * - Blood Moon: knockback x1.5
 * - Slick Stone: friction 0.975 (every slide runs long)
 * - Overcharge: cooldowns run at double speed
 * - Sudden Collapse: a ring every 4 s
 * - Meteor Shower: neutral meteors fall near warlocks, more often as the round goes on
 * - Pillar Storm: pillars burst out of the floor at warned spots, explode when broken
 * - Cursed Bomb: a bomb with a fuse sticks to a warlock; a hit or a touch passes it on; when the
 *   fuse runs out it throws whoever holds it and everyone near
 * - Gale: a turning wind pushes every warlock and bends every bolt
 * - Shuffle: every few seconds, after a warning, the warlocks trade places in pairs
 * - Vengeful Spirits: a knocked-out warlock returns as a spirit over the lava and haunts the
 *   living with weak bolts (sim/spirits.ts)
 * One omen in the second and third rounds, two from the fourth, three (a Cataclysm) in a round
 * that can decide the match. Wild also turns on spell reactions (Shatter, Nova, Fork, Clash; see
 * the spells and `clash` below). Off, nothing here runs and the classic game is untouched (no
 * random draw is taken).
 */
import { isLocationSafe } from './arena'
import { OBSTACLE_HP, PAWN_RADIUS, frictionPerTick, ticks } from './config'
import { receiveDamage } from './combat'
import { cos, sin, TAU } from './math'
import { scheduledRoundsOf } from './mode'
import { kindOf, spawnProjectile, timeScale } from './projectiles'
import { random, randomInt } from './rng'
import { SPELLS, attr } from './spells/data'
import { spiritTick } from './spirits'
import { NEUTRAL_OWNER, isEnemy, isRoundParticipant, pawnOf } from './teams'
import { DT, type MatchSettings, type PawnState, type PlayerId, type ProjectileState, type SimState } from './types'

export type OmenId =
  | 'bloodMoon' | 'slickStone' | 'overcharge' | 'suddenCollapse' | 'meteorShower' | 'pillarStorm'
  | 'cursedBomb' | 'gale' | 'shuffle' | 'spirits'
/** the deck; the lobby's bitmask follows this order (new omens only ever append) */
export const OMEN_IDS: readonly OmenId[] = ['bloodMoon', 'slickStone', 'overcharge', 'suddenCollapse', 'meteorShower', 'pillarStorm', 'cursedBomb', 'gale', 'shuffle', 'spirits']
export const ALL_OMENS = (1 << OMEN_IDS.length) - 1

export const WILD_KB = 1.5
export const WILD_FRICTION = 0.975
export const WILD_COOLDOWN_RATE = 2
export const WILD_SHRINK_SECONDS = 4
/** omens a round gets: one from the second round, two from the fourth, three when it can decide the match */
export const OMENS_FROM_ROUND = [2, 4] as const
export const CATACLYSM_OMENS = 3
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
/** Cursed Bomb: the first one arms this long into the fight; the fuse shortens per bomb (s) */
const BOMB_FIRST = 3
export const BOMB_FUSE = 12
const BOMB_FUSE_STEP = 1
const BOMB_FUSE_MIN = 7
/** a new bomb this long after a blast (s) */
const BOMB_GAP = 2.5
/** after a pass the bomb stays put this long, so one spread of hits cannot carry it on at once (s) */
export const BOMB_PASS_LOCK = 0.4
/** bodies this close pass it: touching, with a little slack */
export const BOMB_TOUCH = PAWN_RADIUS * 2 + 8
export const BOMB_RADIUS = 340
/** the holder takes this and is thrown hard; the rest of the blast falls off with distance */
const BOMB_SELF_DAMAGE = 180
const BOMB_SELF_KB = 1.5
const BOMB_DAMAGE = [40, 120] as const
const BOMB_KB = [0.7, 1.4] as const
/** Gale: the wind a warlock drifts at (u/s), how hard it bends bolts (u/s^2), its turn (rad/s) and gusts */
export const GALE_DRIFT = 55
export const GALE_BEND = 300
const GALE_TURN = 0.06
const GALE_GUST = 0.35
const GALE_GUST_SECONDS = 6
/** the bolts the wind bends: plain flyers, not the ones that hold a path of their own */
const GALE_KINDS = new Set(['fireball', 'cluster', 'homing', 'bouncer', 'snowball', 'splitterChild', 'drain', 'recharge', 'spiritBolt'])
/** Shuffle: first swap, the gap, and how long the warning glows (s) */
const SHUFFLE_FIRST = 5
const SHUFFLE_GAP = 7
export const SHUFFLE_WARN = 1.2
/** Clash: two enemy bolts that meet go off between them */
const CLASH_RADIUS = [150, 260] as const
const CLASH_DAMAGE = 0.6
const CLASH_KB = 1.1

/** Wild applies: the lobby switched it on, in classic Rounds outside ranked. */
export function wildOn(settings: Pick<MatchSettings, 'wild' | 'gameMode' | 'rankedRounds'>): boolean {
  return settings.wild === true && settings.gameMode === 'rounds' && !settings.rankedRounds
}

/** This round's omens (none outside Wild or in its first round). */
export function omensOf(state: Pick<SimState, 'omens'>): readonly OmenId[] {
  return state.omens ?? []
}

export function hasOmen(state: Pick<SimState, 'omens'>, omen: OmenId): boolean {
  return state.omens?.includes(omen) === true
}

/** knockback multiplier this round (Blood Moon) */
export function kbMultiplierOf(state: Pick<SimState, 'settings' | 'omens'>): number {
  return state.settings.kbMultiplier * (hasOmen(state, 'bloodMoon') ? WILD_KB : 1)
}

/** friction this round (Slick Stone) */
export function frictionOf(state: Pick<SimState, 'settings' | 'omens'>): number {
  return hasOmen(state, 'slickStone') ? WILD_FRICTION : state.settings.friction
}

/** cooldown ticks per tick this round (Overcharge) */
export function cooldownRateOf(state: Pick<SimState, 'omens'>): number {
  return hasOmen(state, 'overcharge') ? WILD_COOLDOWN_RATE : 1
}

/** Can a win in round `round` end the match? (scores as they stand before it) */
export function canDecide(state: SimState, round: number): boolean {
  const scheduled = scheduledRoundsOf(state.settings)
  if (scheduled) {
    if (round >= scheduled) return true
    const remaining = scheduled - round
    // a sole winner of this round who nobody could catch in the rounds left
    return state.scores.some((me) => state.scores.every((sc) => sc.id === me.id || sc.score + remaining < me.score + 1))
  }
  return state.scores.some((sc) => sc.score + 1 >= state.settings.winScore)
}

/** How many omens round `round` gets. */
export function omenCount(state: SimState, round: number): number {
  if (round < OMENS_FROM_ROUND[0]) return 0
  if (canDecide(state, round)) return CATACLYSM_OMENS
  return round >= OMENS_FROM_ROUND[1] ? 2 : 1
}

/** The omens of round `round` (drawn at its shop): none in the first round or without Wild. */
export function drawOmen(state: SimState, round: number): void {
  const previous = state.omens ?? []
  delete state.omens
  delete state.omenClock
  for (const p of state.pawns) delete p.spirit
  if (!wildOn(state.settings)) return
  const count = omenCount(state, round)
  if (count === 0) return
  const mask = state.settings.wildOmens ?? ALL_OMENS
  let deck = OMEN_IDS.filter((_, i) => (mask & (1 << i)) !== 0)
  const fresh = deck.filter((o) => !previous.includes(o))
  if (fresh.length >= Math.min(count, deck.length)) deck = fresh
  else if (deck.length > 1 && previous.length === 1) deck = deck.filter((o) => o !== previous[0])
  const omens: OmenId[] = []
  while (omens.length < count && deck.length > 0) {
    const i = randomInt(state, 0, deck.length - 1)
    omens.push(deck[i])
    deck = deck.filter((_, j) => j !== i)
  }
  if (omens.length === 0) return
  // deck order, so the card, the badge and the record read the same everywhere
  state.omens = OMEN_IDS.filter((o) => omens.includes(o))
  for (const omen of state.omens) state.events.push({ type: 'omen', omen, round })
}

/** A safe spot near a living warlock (or nowhere). */
function spotNearWarlock(state: SimState): { x: number; y: number } | null {
  const alive = livingWarlocks(state)
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

function livingWarlocks(state: SimState): PawnState[] {
  return state.pawns.filter((p) => p.alive && isRoundParticipant(state, p.owner))
}

/** One fight tick of the round's omens, after the bodies moved. */
export function omenTick(state: SimState): void {
  const omens = state.omens
  if (state.phase !== 'fight' || !omens) return
  const clock = (state.omenClock ??= { pillars: [] })
  if (omens.includes('meteorShower')) meteorTick(state, clock)
  if (omens.includes('pillarStorm')) pillarTick(state, clock)
  if (omens.includes('cursedBomb')) bombTick(state, clock)
  if (omens.includes('gale')) galeTick(state, clock)
  if (omens.includes('shuffle')) shuffleTick(state, clock)
  // last: knockouts from the omens above rise too
  if (omens.includes('spirits')) spiritTick(state)
}

type OmenClock = NonNullable<SimState['omenClock']>

function meteorTick(state: SimState, clock: OmenClock): void {
  clock.meteorNext = (clock.meteorNext ?? ticks(METEOR_FIRST)) - 1
  if (clock.meteorNext > 0) return
  clock.meteors = (clock.meteors ?? 0) + 1
  clock.meteorNext = ticks(Math.max(METEOR_GAP_MIN, METEOR_GAP - METEOR_GAP_STEP * clock.meteors))
  const spot = spotNearWarlock(state)
  if (spot) spawnMeteor(state, spot.x, spot.y)
}

function pillarTick(state: SimState, clock: OmenClock): void {
  for (const p of clock.pillars) p.left -= 1
  for (const p of clock.pillars.filter((q) => q.left <= 0)) {
    state.obstacles.push({ id: state.nextEntityId++, x: p.x, y: p.y, radius: PILLAR_RADIUS, hp: OBSTACLE_HP, variant: -1, ticksLeft: ticks(PILLAR_SECONDS), owner: NEUTRAL_OWNER })
  }
  clock.pillars = clock.pillars.filter((q) => q.left > 0)
  clock.pillarNext = (clock.pillarNext ?? ticks(PILLAR_FIRST)) - 1
  if (clock.pillarNext > 0) return
  clock.pillarNext = ticks(PILLAR_GAP)
  const spot = spotNearWarlock(state)
  if (spot) {
    clock.pillars.push({ x: spot.x, y: spot.y, left: ticks(PILLAR_WARN) })
    state.events.push({ type: 'omenWarning', omen: 'pillarStorm', x: spot.x, y: spot.y, ticks: ticks(PILLAR_WARN) })
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

/**
 * Cursed Bomb: armed on a random warlock, passed by the holder's hit (any damage they deal to
 * another warlock) or by touching one, never back within BOMB_PASS_LOCK. The fuse does not reset
 * on a pass. At zero, or when the holder falls, it goes off on them.
 */
function bombTick(state: SimState, clock: OmenClock): void {
  const bomb = (clock.bomb ??= { holder: null, fuse: 0, full: 0, lock: 0, from: null, next: ticks(BOMB_FIRST), count: 0 })
  if (bomb.holder === null) {
    bomb.next -= 1
    if (bomb.next > 0) return
    const alive = livingWarlocks(state)
    // a lone warlock has nobody to pass it to: the round is over anyway
    if (alive.length < 2) return
    const holder = alive[randomInt(state, 0, alive.length - 1)]
    bomb.holder = holder.owner
    bomb.fuse = bomb.full = ticks(Math.max(BOMB_FUSE_MIN, BOMB_FUSE - BOMB_FUSE_STEP * bomb.count))
    bomb.lock = ticks(BOMB_PASS_LOCK)
    bomb.from = null
    state.events.push({ type: 'bomb', action: 'arm', holder: holder.owner, from: null, x: holder.x, y: holder.y, fuse: bomb.fuse })
    return
  }
  const holder = pawnOf(state, bomb.holder)
  if (!holder || !holder.alive) {
    blast(state, bomb, holder ?? null)
    return
  }
  bomb.fuse -= 1
  bomb.lock -= 1
  if (bomb.fuse <= 0) {
    blast(state, bomb, holder)
    return
  }
  if (bomb.lock > 0) return
  const to = bombTarget(state, holder)
  if (!to) return
  state.events.push({ type: 'bomb', action: 'pass', holder: to.owner, from: holder.owner, x: to.x, y: to.y, fuse: bomb.fuse })
  bomb.from = holder.owner
  bomb.holder = to.owner
  bomb.lock = ticks(BOMB_PASS_LOCK)
}

/** Who takes the bomb this tick: the first warlock the holder damaged, else the nearest one touching them. */
function bombTarget(state: SimState, holder: PawnState): PawnState | null {
  for (const e of state.events) {
    if (e.type !== 'damage' || e.source !== holder.owner || e.cause === 'lava' || e.cause === 'obstacle' || e.cause === 'bomb') continue
    const p = state.pawns.find((q) => q.id === e.target)
    if (p && p.alive && p.owner !== holder.owner && isRoundParticipant(state, p.owner)) return p
  }
  let best: PawnState | null = null
  let bestD = BOMB_TOUCH * BOMB_TOUCH
  for (const p of state.pawns) {
    if (!p.alive || p === holder || !isEnemy(state, holder.owner, p.owner) || !isRoundParticipant(state, p.owner)) continue
    const dx = p.x - holder.x
    const dy = p.y - holder.y
    const d = dx * dx + dy * dy
    if (d < bestD) {
      bestD = d
      best = p
    }
  }
  return best
}

function blast(state: SimState, bomb: NonNullable<OmenClock['bomb']>, holder: PawnState | null): void {
  const x = holder?.x ?? 0
  const y = holder?.y ?? 0
  state.events.push({ type: 'bomb', action: 'blast', holder: bomb.holder!, from: bomb.from, x, y, fuse: 0 })
  state.events.push({ type: 'explosion', x, y, radius: BOMB_RADIUS, spell: 'meteor' })
  bomb.holder = null
  bomb.from = null
  bomb.next = ticks(BOMB_GAP)
  bomb.count += 1
  // a neutral blast: knockouts credit the last warlock who hit (usually whoever passed it)
  for (const p of state.pawns) {
    if (!p.alive || !isRoundParticipant(state, p.owner)) continue
    if (p === holder) {
      const a = random(state) * TAU
      receiveDamage(state, p, { amount: BOMB_SELF_DAMAGE, source: null, normal: { x: cos(a), y: sin(a) }, knockbackFactor: BOMB_SELF_KB, cause: 'bomb' })
      continue
    }
    const dx = p.x - x
    const dy = p.y - y
    const d = Math.sqrt(dx * dx + dy * dy)
    if (!(d < BOMB_RADIUS)) continue
    const t = 1 - d / BOMB_RADIUS
    const normal = d > 0 ? { x: dx / d, y: dy / d } : { x: 1, y: 0 }
    receiveDamage(state, p, {
      amount: BOMB_DAMAGE[0] + (BOMB_DAMAGE[1] - BOMB_DAMAGE[0]) * t,
      source: null,
      normal,
      knockbackFactor: BOMB_KB[0] + (BOMB_KB[1] - BOMB_KB[0]) * t,
      cause: 'bomb',
    })
  }
}

/** Gale's heading and strength at this fight tick (strength 1 = GALE_DRIFT / GALE_BEND). */
export function galeOf(state: Pick<SimState, 'omens' | 'omenClock'>): { x: number; y: number; strength: number } | null {
  const g = state.omenClock?.gale
  if (!g || !hasOmen(state, 'gale')) return null
  return { x: cos(g.angle), y: sin(g.angle), strength: g.strength }
}

function galeTick(state: SimState, clock: OmenClock): void {
  const g = (clock.gale ??= { angle: random(state) * TAU, turn: (random(state) < 0.5 ? -1 : 1) * GALE_TURN, t: 0, strength: 1 })
  g.t += DT
  g.angle += g.turn * DT
  g.strength = 1 + GALE_GUST * sin((TAU * g.t) / GALE_GUST_SECONDS)
  const wx = cos(g.angle) * g.strength
  const wy = sin(g.angle) * g.strength
  // next tick's friction takes back (1 - f) of the push, so a warlock left alone drifts at GALE_DRIFT
  const push = GALE_DRIFT * (1 - frictionPerTick(frictionOf(state)))
  for (const p of state.pawns) {
    if (!p.alive) continue
    p.vx += wx * push
    p.vy += wy * push
  }
  for (const q of state.projectiles) {
    if (!galeBends(q)) continue
    const k = GALE_BEND * DT * timeScale(q)
    q.vx += wx * k
    q.vy += wy * k
  }
}

/** The wind bends this bolt (a plain flyer). */
export function galeBends(q: ProjectileState): boolean {
  return GALE_KINDS.has(kindOf(q)) && !q.data.dead && !q.data.static
}

/**
 * Shuffle: after a glow, the living warlocks trade places in random pairs (an odd one stays). A
 * slide stays with its spot, and so does the hit that started it: whoever lands where a pushed
 * warlock was flies on toward the lava in their place, credited to the pusher. (Trading only the
 * places saved the pushed: in bot runs the first knockout came later than in classic rounds.)
 */
function shuffleTick(state: SimState, clock: OmenClock): void {
  clock.shuffleNext = (clock.shuffleNext ?? ticks(SHUFFLE_FIRST)) - 1
  if (clock.shuffleNext === ticks(SHUFFLE_WARN)) state.events.push({ type: 'omenWarning', omen: 'shuffle', x: 0, y: 0, ticks: ticks(SHUFFLE_WARN) })
  if (clock.shuffleNext > 0) return
  clock.shuffleNext = ticks(SHUFFLE_GAP)
  const pool = livingWarlocks(state)
  // Fisher-Yates on the seeded stream
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randomInt(state, 0, i)
    const t = pool[i]
    pool[i] = pool[j]
    pool[j] = t
  }
  for (let i = 0; i + 1 < pool.length; i += 2) {
    const a = pool[i]
    const b = pool[i + 1]
    const ax = a.x
    const ay = a.y
    const avx = a.vx - a.walkVx
    const avy = a.vy - a.walkVy
    const hitter = a.lastHitter
    a.x = b.x
    a.y = b.y
    b.x = ax
    b.y = ay
    a.vx = b.vx - b.walkVx
    a.vy = b.vy - b.walkVy
    b.vx = avx
    b.vy = avy
    a.lastHitter = b.lastHitter
    b.lastHitter = hitter
    // a walk order meant for the old spot would carry a warlock back across the arena
    for (const p of [a, b]) {
      p.moveTarget = null
      p.walkVx = 0
      p.walkVy = 0
    }
    state.events.push({ type: 'swap', spell: 'swap', pawn: a.id, other: b.id, fromX: b.x, fromY: b.y, toX: a.x, toY: a.y })
  }
}

/**
 * Clash: an enemy bolt that destroys another goes off between them, once per pair; a neutral
 * blast scaled by the two bolts' damage. Called where a projectile damages a projectile.
 */
export function clash(state: SimState, a: ProjectileState, b: ProjectileState, x: number, y: number): void {
  if (!wildOn(state.settings) || a.data.clashed || b.data.clashed) return
  const da = a.data.damage ?? 0
  const db = b.data.damage ?? 0
  if (!(da > 0 && db > 0) || a.owner === NEUTRAL_OWNER || b.owner === NEUTRAL_OWNER) return
  a.data.clashed = 1
  b.data.clashed = 1
  const sum = da + db
  const radius = Math.min(CLASH_RADIUS[1], CLASH_RADIUS[0] + sum * 0.5)
  state.events.push({ type: 'reaction', reaction: 'clash', x, y, owner: a.owner })
  state.events.push({ type: 'explosion', x, y, radius, spell: 'fireball' })
  for (const p of state.pawns) {
    if (!p.alive) continue
    const dx = p.x - x
    const dy = p.y - y
    const d = Math.sqrt(dx * dx + dy * dy)
    if (!(d < radius)) continue
    const normal = d > 0 ? { x: dx / d, y: dy / d } : { x: 1, y: 0 }
    receiveDamage(state, p, { amount: sum * CLASH_DAMAGE * (1 - 0.5 * (d / radius)), source: null, normal, knockbackFactor: CLASH_KB, cause: 'clash' })
  }
}

/** The holder of the Cursed Bomb this tick (null: none armed). */
export function bombHolder(state: Pick<SimState, 'omens' | 'omenClock'>): PlayerId | null {
  return hasOmen(state, 'cursedBomb') ? state.omenClock?.bomb?.holder ?? null : null
}
