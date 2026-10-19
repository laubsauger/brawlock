/**
 * Port of the original AI controller (docs/research/systems.md §8) with the
 * difficulty spread over BotParams (presets.ts).
 *
 * Deviations from the original, each on purpose:
 * - Wander delays are uniform float ranges (0.4-0.8 s, 0.2-0.4 s near the target) and the
 *   wander angle is a float. Lua 5.1 coerced them to integers (systems.md §12.6), which made
 *   the bot re-pick a wander point almost every think and only walk in 7 directions.
 * - Decisions reach the sim after `reactionDelay` (the original acted on the same tick).
 *   To stay stable with that lag, danger is evaluated at the bot's predicted position (own
 *   velocity plus its own queued orders) and a
 *   dodge keeps its side while that side still lowers danger (otherwise a bot on the line
 *   zig-zags across it and gets hit).
 * - The dodge uses the analytic gradient of the original danger field; the original's
 *   axis-aligned finite differences point along diagonal flight lines (see danger.ts).
 * - Spells are read from `pawn.slots` every think instead of being cached at setup, so a bot
 *   taking over any pawn can use every spell it knows (fixes the Fireball-level lookup bug
 *   of systems.md §12.7).
 * - Lava awareness (safe wander points, edge margin, shrink lookahead, walking off lava,
 *   lava-safe dodges) is new; the original only escaped lava with an escape spell.
 * - Lead aim may include the spell's cast point and the bot's reaction delay; the original
 *   aimed with lead 1/3 of the time and never checked range. Projectile casts may be
 *   range-checked.
 * - A purchase the sim rejects is detected and that spell is skipped until the next shop
 *   phase, instead of burning the 40 s buy timer.
 */
import { cos, exp, hypot, sin } from '../sim/math'
import { TICK_HZ } from '../sim/types'
import type {
  BotDifficulty,
  InputCommand,
  PawnState,
  PlayerId,
  ProjectileState,
  SimState,
  SpellId,
  Vec2,
} from '../sim/types'
import { attr, cooldownSeconds, isEnemy, spellDef } from '../sim'
import type { Bot } from './index'
import { leadPoint, rotateAround } from './aim'
import { isSafe, isSafeWithMargin, layerRadius, nearestTileCentre, TILE_SIZE } from './arena'
import { dangerAt, dodgeDirection } from './danger'
import { insideAny, threatZones, type ThreatZone } from './threats'
import { firstBlocking, inPillar, routeAround, shieldedFrom } from './pillars'
import { BOT_PRESETS, type BotParams } from './presets'
import { afterHit, lavaOutcome, leadWithFriction, physVelocity, positionAfter, projectileHit } from './predict'
import { drawBuild, planStep, type Build } from './plan'
import { botSeed, Rng } from './prng'
import {
  BOT_SPELLS,
  BUY_INTERVAL,
  BUY_MIN_GOLD,
  ESCAPE_SPELLS,
  TARGET_COLUMNS,
  escapeRange,
  isBuyable,
  type BotSpellRole,
} from './spells'

/** Original constants (systems.md §8). */
const WANDER_ARRIVE_DIST = 100
const WANDER_NEAR_TARGET_CHANCE = 1 / 11
const WANDER_NEAR_TARGET_RADIUS = 200
const WANDER_CENTRE_FACTOR = 0.3
const CAST_LOCK_SECONDS = 0.3
const SCOURGE_CHANNEL_SECONDS = 1.0
const SCOURGE_RADIUS = 250
const SCOURGE_GIVE_UP_CHANCE = 1 / 3
const DODGE_REACH = 5000
/** Thrust contact range worth dashing for. */
const THRUST_ATTACK_RANGE = 380
/** Lightning reach and the Fireball detonation radius it triggers (spells.md §8.6). */
const LIGHTNING_RANGE = 600
const PAWN_BODY = 30
/** How often (ticks) a bot checks between decisions whether it is pushing into a pillar. */
const UNSTICK_TICKS = 6
/** Extra clearance beyond an area threat's radius, units. */
const THREAT_MARGIN = 30
/** Directions tried when leaving an area threat (radians off straight away). */
const FLEE_ANGLES = [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4, 1.75, -1.75, 2.2, -2.2, Math.PI]
const FIREBALL_DETONATE_RADIUS = 225
/** How far ahead a lava-aware dodge checks the ground. */
const DODGE_LOOKAHEAD = 150
/** Landing-spot search for Teleport: fractions of its range x directions. */
const TP_RADII = [0.3, 0.5, 0.7, 0.9]
const TP_DIRS = 16
/** A human needs about this long to notice a cast and start walking. */
const HUMAN_NOTICE = 0.25
/** modifiers whose bubble turns our shots back or away (sim: spells/shield.ts, alteration.ts) */
const BUBBLES = new Set(['shield', 'alteration'])
/** projectiles a Shield does not reflect (sim: spells/shield.ts); Meteor has no collision at all */
const UNREFLECTED = new Set(['swap', 'gravity', 'warpzone', 'meteor'])
/** flight speed assumed for shots whose speed the bot does not track (curving, accelerating) */
const DEFAULT_SHOT_SPEED = 900
/** a bubble that drops this close to our shot's arrival counts as gone */
const BUBBLE_MARGIN = 0.05
/** units from an enemy whose Shield may be up: a shot it sends back can be walked out of */
const SHIELD_STANDOFF = 700
/** reflected but kept by the caster: they come back harmless (Boomerang returns anyway) */
const NOT_STOLEN = new Set(['boomerang', 'link'])
/** a typical bolt's radius (Fireball 25) plus a little slack, for the sidestep it takes */
const SHOT_RADIUS = 35
/** FFA: a new target must score this much better than the current one to switch */
const RETARGET_MARGIN = 0.3
/** FFA: smooth local pressure; this is a falloff scale, never a spacing constraint. */
const CROWD_FALLOFF = 350

export type BotAction =
  | 'idle'
  | 'buy'
  | 'escape'
  | 'channel'
  | 'cancelScourge'
  | 'dodge'
  | 'scourge'
  | 'shoot'
  | 'offLava'
  | 'wander'
  | 'combo'
  | 'thrust'
  | 'flee'
  | 'hold'
  | 'save'
  | 'blink'
  | 'reposition'
  | 'shield'

const secToTicks = (s: number) => Math.round(s * TICK_HZ)
const dist = (a: Vec2, b: Vec2) => hypot(a.x - b.x, a.y - b.y)

/** Alliance by current team, as the sim decides it. */
export const areEnemies = (state: SimState, a: PlayerId, b: PlayerId): boolean => isEnemy(state, a, b)

/** A pawn standing here would overlap a pillar (its radius + our body + a little slack). */
function blockedByObstacle(state: SimState, x: number, y: number): boolean {
  for (const o of state.obstacles) if (hypot(x - o.x, y - o.y) < o.radius + PAWN_BODY + 8) return true
  return false
}

function castable(me: PawnState, slot: number): boolean {
  return me.slots[slot] != null && (me.cooldowns[slot] ?? 0) <= 0
}

function clampToRange(from: Vec2, to: Vec2, range: number): Vec2 {
  const d = dist(from, to)
  if (d <= range || d < 1e-6) return { x: to.x, y: to.y }
  const k = range / d
  return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k }
}

export class BotController implements Bot {
  readonly player: PlayerId
  readonly difficulty: BotDifficulty
  readonly params: BotParams
  /** Last decision taken, for tests and debug overlays. */
  lastAction: BotAction = 'idle'

  /** The player this bot is after (tests, the FFA harness, debug overlays). */
  get targetPlayer(): PlayerId | null {
    return this.target
  }

  /** Make committed future orders available to the host without exposing the mutable queue. */
  scheduled(): readonly { at: number; cmds: InputCommand[] }[] {
    return this.queue.map((frame) => ({ at: frame.at, cmds: frame.cmds.map((command) => ({ ...command })) }))
  }

  private readonly rng: Rng
  private readonly thinkTicks: number
  private readonly delayTicks: number
  private queue: { at: number; cmds: InputCommand[] }[] = []
  private lastTick = -1
  private lastPhase: SimState['phase'] | null = null
  private nextThinkTick = -1

  private target: PlayerId | null = null
  private wander: Vec2 | null = null
  private nextWanderTick = 0
  private spellEndTick = 0
  private scourgeEndTick = 0
  private dodgeDir: Vec2 | null = null
  private lastWalk: { tick: number; dist: number } | null = null
  private lastCheck: { tick: number; dist: number; x: number; y: number } | null = null
  private lastDodgeTick = -Infinity
  private nextBuyTick = -1
  private pendingBuy: { spell: SpellId; tick: number; gold: number } | null = null
  private readonly failedBuys = new Set<SpellId>()
  /** per enemy: tick its Shield was last raised (seen), to know when it can be up again */
  private readonly shieldCast = new Map<PlayerId, number>()
  /**
   * Seeded per-bot personality for FFA (its own stream: the decision rng is untouched):
   * grudge (go after whoever hit us), opportunism (third-party pushes), risk (crowds, low
   * HP), and attachment to the current fight.
   */
  private readonly persona: { grudge: number; opportunism: number; risk: number; focus: number }
  /** shop build of a planning bot (drawn after the persona, from the same stream) */
  readonly build: Build | null
  /** Recent observed damage, independent of the sim's permanent kill-credit lastHitter. */
  private recentHit: { owner: PlayerId; tick: number } | null = null

  constructor(player: PlayerId, difficulty: BotDifficulty, seed: number, params: BotParams = BOT_PRESETS[difficulty]) {
    this.player = player
    this.difficulty = difficulty
    this.params = params
    this.rng = new Rng(botSeed(seed, player))
    this.thinkTicks = Math.max(1, secToTicks(params.thinkInterval))
    this.delayTicks = Math.max(0, secToTicks(params.reactionDelay))
    const traits = new Rng(botSeed(seed ^ 0x5eedbeef, player))
    this.persona = { grudge: traits.range(0.2, 1), opportunism: traits.range(0.2, 1), risk: traits.range(0, 1), focus: traits.range(0.6, 1) }
    this.build = params.buildPlan === 'random' ? null : drawBuild(traits, params.buildPlan === 'plan' ? undefined : params.buildPlan)
  }

  think(state: SimState): InputCommand[] {
    if (!this.params.active) return []
    if (state.tick < this.lastTick) this.reset()
    if (state.tick !== this.lastTick && state.phase === 'fight') {
      const me = state.pawns.find((pawn) => pawn.owner === this.player)
      for (const event of state.events) {
        if (event.type === 'damage' && event.target === me?.id && event.source !== null && areEnemies(state, this.player, event.source)) {
          this.recentHit = { owner: event.source, tick: state.tick }
        }
      }
    }
    this.lastTick = state.tick
    if (state.phase !== this.lastPhase) {
      if (state.phase !== 'fight') this.recentHit = null
      if (state.phase === 'shop') this.failedBuys.clear()
      this.lastPhase = state.phase
    }
    if (state.phase === 'gameOver') {
      this.queue.length = 0
      return []
    }

    if (this.nextThinkTick < 0 || state.tick >= this.nextThinkTick) {
      this.nextThinkTick = state.tick + this.thinkTicks
      const cmds = this.decide(state)
      if (cmds.length > 0) this.queue.push({ at: state.tick + this.delayTicks, cmds })
    } else if (state.tick % UNSTICK_TICKS === 0) {
      // between decisions: a player notices when they are walking into a pillar
      const cmds = this.unstick(state)
      if (cmds.length > 0) this.queue.push({ at: state.tick + this.delayTicks, cmds })
    }

    if (this.queue.length === 0 || this.queue[0].at > state.tick) return []
    const out: InputCommand[] = []
    while (this.queue.length > 0 && this.queue[0].at <= state.tick) out.push(...this.queue.shift()!.cmds)
    return out
  }

  private reset(): void {
    this.queue.length = 0
    this.nextThinkTick = -1
    this.target = null
    this.wander = null
    this.spellEndTick = 0
    this.scourgeEndTick = 0
    this.dodgeDir = null
    this.lastWalk = null
    this.lastCheck = null
    this.lastDodgeTick = -Infinity
    this.nextBuyTick = -1
    this.pendingBuy = null
    this.failedBuys.clear()
    this.shieldCast.clear()
    this.recentHit = null
  }

  private decide(state: SimState): InputCommand[] {
    const p = this.params
    const tick = state.tick
    const me = state.pawns.find((pw) => pw.owner === this.player) ?? null
    const gold = state.scores.find((s) => s.id === this.player)?.gold ?? 0

    // 1. Buy: between rounds or while dead, one spell per 40 s.
    this.checkPendingBuy(tick, me, gold)
    const canShop = p.buys && !this.pendingBuy && tick >= this.nextBuyTick && (state.phase !== 'fight' || !me?.alive)
    if (canShop && this.build) {
      // Brutal, Uber: the next step of its build, several per shop phase
      const step = planStep(this.build, me, gold, this.failedBuys)
      if (step) {
        this.nextBuyTick = tick + secToTicks(0.3)
        this.pendingBuy = { spell: step.id, tick: tick + this.delayTicks, gold }
        return this.act('buy', [step.cmd])
      }
    } else if (canShop && gold >= BUY_MIN_GOLD) {
      const spell = this.chooseBuy(me)
      if (spell) {
        this.nextBuyTick = tick + secToTicks(BUY_INTERVAL)
        this.pendingBuy = { spell, tick: tick + this.delayTicks, gold }
        return this.act('buy', [{ kind: 'buySpell', spell }])
      }
    }

    if (!me || !me.alive) return this.act('idle', [])

    const layer = state.arena.layer
    const safety = this.safetyLayer(state)
    const enemies = state.pawns.filter((o) => o.alive && areEnemies(state, this.player, o.owner))
    this.watchShields(enemies, tick)
    let closest: PawnState | null = null
    let closestDist = Infinity
    for (const e of enemies) {
      const d = dist(me, e)
      if (d < closestDist) {
        closestDist = d
        closest = e
      }
    }
    const onLava = !isSafe(layer, me.x, me.y)
    // enemy bolts, our own shots a Shield has stolen (their owner flips), and our shots about to
    // hit a raised Shield: those come back, so we read them as already coming
    const threats = [...state.projectiles.filter((pr) => areEnemies(state, this.player, pr.owner)), ...this.comingBack(state, enemies)]
    const tp = me.slots.indexOf('teleport')
    const tpReady = tp >= 0 && castable(me, tp) && !(me.cast && me.cast.spell === 'teleport')

    // 1b. Teleport save (new): blink out of a lethal or high-risk lava trajectory.
    if (tpReady && p.teleportSave > 0 && this.lavaRisk(state, me, layer) && this.rng.chance(p.teleportSave)) {
      const land = this.planTeleport(state, me, tp, threats, 'save')
      if (land) {
        this.wander = null
        return this.act('save', [{ kind: 'cast', slot: tp, x: land.x, y: land.y }])
      }
    }

    // 1c. Shield (new, when owned): reflect a bolt that is about to hit; before a Teleport dodge,
    // since it sends the bolt back and keeps Teleport for the lava.
    const sh = me.slots.indexOf('shield')
    if (sh >= 0 && p.shieldReflect > 0 && castable(me, sh) && !me.modifiers.some((m) => m.id === 'shield')) {
      if (this.incomingShot(me, sh, threats) && this.rng.chance(p.shieldReflect)) {
        return this.act('shield', [{ kind: 'cast', slot: sh, x: me.x, y: me.y }])
      }
    }

    // 1d. Teleport dodge (new): a bolt walking cannot clear in time, whose hit would be dangerous.
    if (tpReady && p.teleportDodge > 0 && this.unavoidableHit(state, me, threats, layer) && this.rng.chance(p.teleportDodge)) {
      const land = this.planTeleport(state, me, tp, threats, 'dodge')
      if (land) return this.act('blink', [{ kind: 'cast', slot: tp, x: land.x, y: land.y }])
    }

    // 2. Lava escape: cast the escape spell toward safe ground.
    if (onLava) {
      const esc = this.findSlot(me, 'escape')
      if (esc >= 0 && this.rng.chance(p.escapeChance)) {
        const dest = this.escapeDestination(state, me, esc)
        this.wander = null
        return this.act('escape', [{ kind: 'cast', slot: esc, x: dest.x, y: dest.y }])
      }
    }

    // 2b. Area threats (new): walk (or blink) out of a charging Scourge, a Meteor's landing
    // spot or a Gravity zone. Before the cast lock: leaving beats finishing our own windup.
    const zones = threatZones(state, this.player)
    if (zones.length > 0 && this.rng.chance(p.threatChance)) {
      const flee = this.fleeThreats(state, me, zones, safety)
      if (flee) return this.act('flee', flee)
    }

    // 3. Retarget: lost target or 1/5 chance -> closest enemy (edgePressure: best kill chance).
    // With several enemies (FFA): local opportunities with score hysteresis (see pickTarget).
    const current = this.target === null ? null : state.pawns.find((o) => o.owner === this.target)
    const lost = !current || !current.alive || !areEnemies(state, this.player, current.owner)
    if (enemies.length >= 2) {
      const pick = this.pickTarget(state, me, enemies, lost ? null : current, threats)
      this.target = pick ? pick.owner : null
    } else if (lost || this.rng.chance(p.retargetChance)) {
      const pick = p.edgePressure ? this.killTarget(state, me, enemies) : closest
      this.target = pick ? pick.owner : null
    }
    const target = this.target === null ? null : (state.pawns.find((o) => o.owner === this.target && o.alive) ?? null)

    // 4. Wander point.
    if (
      !this.wander ||
      dist(me, this.wander) < WANDER_ARRIVE_DIST ||
      tick > this.nextWanderTick ||
      (p.safeWander && !isSafe(safety, this.wander.x, this.wander.y))
    ) {
      this.pickWander(state, me, target, safety)
    }

    // 5. Cast lock: never cancel our own windup with a new order. Our own shot coming back
    // (stolen by a Shield) is the exception once it has left the hand: dodge it at once.
    if (tick < this.spellEndTick) {
      const back = !me.cast && p.dodge ? threats.filter((pr) => pr.data.origOwner === this.player) : []
      const self = back.length ? this.predictSelf(me, tick) : null
      if (!self || this.dangerHere(state, back, self.x, self.y) < p.dodgeThreshold) return this.act('idle', [])
      return this.act('dodge', [this.dodgeMove(state, self, threats, this.dangerHere(state, threats, self.x, self.y))])
    }
    if (me.cast && me.cast.spell !== 'scourge') return this.act('idle', [])

    // Danger where we will be when this decision lands (a player plans from where they are going).
    const self = this.predictSelf(me, tick)
    const danger = this.dangerHere(state, threats, self.x, self.y)
    const mustDodge = p.dodge && danger >= p.dodgeThreshold

    // 6. Scourge channel: keep it unless in danger or the enemy walked away.
    if (me.cast?.spell === 'scourge' || tick < this.scourgeEndTick) {
      // value-based presets let go of a blast whose victims walked out (no cooldown is spent)
      const gone = p.scourgeMinValue > 0 && this.scourgeValue(state, me, enemies, true).value < p.scourgeMinValue * 0.5
      if (mustDodge || gone || (closestDist > SCOURGE_RADIUS && this.rng.chance(SCOURGE_GIVE_UP_CHANCE))) {
        this.scourgeEndTick = 0
        const cmds: InputCommand[] = [{ kind: 'stop' }]
        if (mustDodge) cmds.push(this.dodgeMove(state, self, threats, danger))
        return this.act('cancelScourge', cmds)
      }
      return this.act('channel', [])
    }

    // 7. Dodge down the danger gradient.
    if (mustDodge) return this.act('dodge', [this.dodgeMove(state, self, threats, danger)])

    // 8. Scourge: never into an empty radius. Value-based presets weigh who will still be
    // inside after the windup and whether the push kills; the rest keep the original chance.
    if (closest && closestDist <= p.scourgeRange) {
      const sc = this.findSlot(me, 'scourge')
      if (sc >= 0) {
        let go = false
        if (p.scourgeMinValue > 0) {
          const v = this.scourgeValue(state, me, enemies, false)
          go = v.value >= p.scourgeMinValue && (me.hp >= p.scourgeMinHp || v.kills > 0) && this.rng.chance(p.scourgeChance)
        } else {
          go = closestDist <= SCOURGE_RADIUS - 20 && this.rng.chance(p.scourgeChance)
        }
        if (go) {
          this.scourgeEndTick = tick + secToTicks(SCOURGE_CHANNEL_SECONDS)
          return this.act('scourge', [{ kind: 'cast', slot: sc, x: me.x, y: me.y }])
        }
      }
    }

    // 8b. Combo (new): Lightning its own Fireball as it passes an enemy (r225 blast).
    if (p.comboChance > 0 && this.rng.chance(p.comboChance)) {
      const combo = this.lightningCombo(state, me, enemies)
      if (combo) {
        this.spellEndTick = tick + secToTicks(CAST_LOCK_SECONDS)
        return this.act('combo', [combo])
      }
    }

    // 8c. Thrust attack (new): dash into a close enemy when the ground past them is safe.
    if (p.thrustAttack && closest && closestDist <= THRUST_ATTACK_RANGE && this.rng.chance(p.castChance)) {
      const slot = me.slots.indexOf('thrust')
      if (slot >= 0 && castable(me, slot)) {
        const d = Math.max(1, closestDist)
        const past = { x: closest.x + ((closest.x - me.x) / d) * 150, y: closest.y + ((closest.y - me.y) / d) * 150 }
        if (isSafeWithMargin(safety, past.x, past.y, 60)) {
          this.spellEndTick = tick + secToTicks(CAST_LOCK_SECONDS)
          return this.act('thrust', [{ kind: 'cast', slot, x: past.x, y: past.y }])
        }
      }
    }

    // 8d. Offensive Teleport (new): blink to the arena-centre side of an enemy near the edge,
    // so the next hits push it out. Only with Teleport spare and nothing threatening us.
    if (tpReady && target && p.teleportOffense > 0 && danger < 1 && this.rng.chance(p.teleportOffense)) {
      const spot = this.repositionSpot(state, me, target, threats, safety)
      if (spot) return this.act('reposition', [{ kind: 'cast', slot: tp, x: spot.x, y: spot.y }])
    }

    // 9. Shoot a random projectile spell at the target (falls through if not castable). Never
    // into a Shield or Alteration bubble that is still up when the shot arrives: the shot
    // comes back or is wasted. Then another enemy, or a bubble-proof spell, or wait it out.
    if (target && this.rng.chance(p.castChance)) {
      const options = this.slotsWithRole(me, 'projectile')
      if (options.length > 0) {
        const slot = this.rng.pick(options)
        const spell = me.slots[slot]!
        const at = this.bubbleBlocks(me, target, spell) ? this.openTarget(me, enemies, spell) : target
        if (at && castable(me, slot) && !me.cast) {
          const aim = this.aimAt(me, at, spell, state)
          // from the stand-off, a shot at a Shield that may be up is worth it even if easy to
          // avoid: it hits, or it draws the Shield out for its cooldown (and comes back slowly)
          const bait = this.shieldMayRise(at, 0) && dist(me, at) >= SHIELD_STANDOFF
          if (aim && (p.shotGate <= 0 || bait || this.shotChance(state, me, at, spell, aim) >= p.shotGate)) {
            this.spellEndTick = tick + secToTicks(CAST_LOCK_SECONDS)
            return this.act('shoot', [{ kind: 'cast', slot, x: aim.x, y: aim.y }])
          }
        }
      }
    }

    // 10. Move: off lava (or off a tile about to sink) by the shortest way, else wander.
    if (p.walkOffLava && (onLava || !isSafe(safety, me.x, me.y))) {
      const tile = nearestTileCentre(safety, me.x, me.y, true) ?? nearestTileCentre(layer, me.x, me.y, true)
      if (tile) {
        const via = routeAround(state, me, tile, layer)
        return this.act('offLava', [{ kind: 'move', x: via.x, y: via.y }])
      }
    }
    // pushing into a pillar since the last think (knocked against it, or it was not in the
    // way when we planned): pick somewhere else
    if (this.pushingIntoPillar(state, me)) this.pickWander(state, me, target, safety)
    const w = this.wander!
    // never walk into an active area threat: wait at its edge instead
    if (zones.length > 0 && insideAny(zones, w.x, w.y, THREAT_MARGIN) && !insideAny(zones, me.x, me.y)) {
      return this.act('hold', [{ kind: 'stop' }])
    }
    const via = routeAround(state, me, w, layer)
    return this.act('wander', [{ kind: 'move', x: via.x, y: via.y }])
  }

  /** Reflex between decisions: pushing into a pillar -> walk around it toward the same goal. */
  private unstick(state: SimState): InputCommand[] {
    const me = state.pawns.find((p) => p.owner === this.player)
    if (!me || !me.alive || !me.moveTarget || me.cast) {
      this.lastCheck = null
      return []
    }
    const target = me.moveTarget
    const dist = hypot(target.x - me.x, target.y - me.y)
    const last = this.lastCheck
    this.lastCheck = { tick: state.tick, dist, x: target.x, y: target.y }
    if (!last || last.x !== target.x || last.y !== target.y || dist < 40) return []
    if (!inPillar(state, me.x, me.y, 8)) return []
    const expected = (me.moveSpeed * (state.tick - last.tick)) / TICK_HZ
    if (last.dist - dist >= 0.3 * expected) return []
    const goal = this.wander && hypot(this.wander.x - target.x, this.wander.y - target.y) > 1 ? this.wander : target
    const via = routeAround(state, me, goal, state.arena.layer)
    if (hypot(via.x - target.x, via.y - target.y) < 20) return []
    this.lastCheck = null
    return [{ kind: 'move', x: via.x, y: via.y }]
  }

  /** Own progress check: walking, touching a pillar, and barely closer than at the last think. */
  private pushingIntoPillar(state: SimState, me: PawnState): boolean {
    const target = me.moveTarget
    const last = this.lastWalk
    const dist = target ? hypot(target.x - me.x, target.y - me.y) : -1
    this.lastWalk = target ? { tick: state.tick, dist } : null
    if (!target || !last || me.cast || dist < 40) return false
    if (!inPillar(state, me.x, me.y, 6)) return false
    const expected = (me.moveSpeed * (state.tick - last.tick)) / TICK_HZ
    return last.dist - dist < 0.3 * expected
  }

  private act(action: BotAction, cmds: InputCommand[]): InputCommand[] {
    this.lastAction = action
    return cmds
  }

  /**
   * Own position when a decision made now lands: current velocity, then our own queued
   * orders as they arrive (we know what we already told the pawn to do).
   */
  private predictSelf(me: PawnState, tick: number): Vec2 {
    const end = tick + this.delayTicks
    let x = me.x
    let y = me.y
    let vx = me.vx
    let vy = me.vy
    let t = tick
    for (const q of this.queue) {
      if (q.at > end) break
      const at = Math.max(q.at, t)
      x += vx * (at - t) / TICK_HZ
      y += vy * (at - t) / TICK_HZ
      t = at
      for (const c of q.cmds) {
        if (c.kind === 'move') {
          const d = hypot(c.x - x, c.y - y)
          vx = d > 1e-6 ? ((c.x - x) / d) * me.moveSpeed : 0
          vy = d > 1e-6 ? ((c.y - y) / d) * me.moveSpeed : 0
        } else if (c.kind === 'stop' || c.kind === 'cast') {
          vx = 0
          vy = 0
        }
      }
    }
    x += vx * (end - t) / TICK_HZ
    y += vy * (end - t) / TICK_HZ
    return { x, y }
  }

  /**
   * Leave the area threats we will be standing in when this order lands: the shortest way
   * out that ends on safe ground (never into lava), preferring paths away from bolts. When
   * walking cannot make it before the most urgent one strikes, blink out (threatEscape).
   */
  private fleeThreats(state: SimState, me: PawnState, zones: ThreatZone[], safety: number): InputCommand[] | null {
    const from = this.predictSelf(me, state.tick)
    const inside = zones.filter((z) => hypot(from.x - z.x, from.y - z.y) < z.r || hypot(me.x - z.x, me.y - z.y) < z.r)
    if (inside.length === 0) return null
    inside.sort((a, b) => a.fireIn - b.fireIn)
    const urgent = inside[0]
    let bx = from.x - urgent.x
    let by = from.y - urgent.y
    if (hypot(bx, by) < 1) {
      // on top of it: head for the arena centre
      bx = -from.x
      by = -from.y
      if (hypot(bx, by) < 1) bx = 1
    }
    const bl = hypot(bx, by)
    const threats = state.projectiles.filter((pr) => areEnemies(state, this.player, pr.owner))
    let best: { dir: Vec2; dist: number; cost: number } | null = null
    for (const a of FLEE_ANGLES) {
      const c = cos(a)
      const s = sin(a)
      const dir = { x: (bx / bl) * c - (by / bl) * s, y: (bx / bl) * s + (by / bl) * c }
      let dist = 0
      let pathOk = true
      for (let step = 20; step <= 900; step += 20) {
        const px = from.x + dir.x * step
        const py = from.y + dir.y * step
        // lava or a pillar in the way: this direction is no way out
        if (!isSafe(safety, px, py) || blockedByObstacle(state, px, py)) {
          pathOk = false
          break
        }
        if (!insideAny(zones, px, py, THREAT_MARGIN)) {
          dist = step
          break
        }
      }
      if (!pathOk || dist === 0) continue
      const end = { x: from.x + dir.x * dist, y: from.y + dir.y * dist }
      if (!isSafeWithMargin(safety, end.x, end.y, 40)) continue
      const cost = dist + 15 * dangerAt(threats, end.x, end.y)
      if (!best || cost < best.cost) best = { dir, dist, cost }
    }
    if (!best) return null
    const walkTime = best.dist / Math.max(1, me.moveSpeed)
    if (walkTime > urgent.fireIn && this.params.threatEscape) {
      const esc = this.findSlot(me, 'escape')
      if (esc >= 0) {
        const range = escapeRange(me.slots[esc]!, me.levels[esc] || 1)
        const reach = Math.min(range, best.dist + 80)
        const to = { x: from.x + best.dir.x * reach, y: from.y + best.dir.y * reach }
        if (isSafeWithMargin(safety, to.x, to.y, 40) && !insideAny(zones, to.x, to.y) && !blockedByObstacle(state, to.x, to.y)) {
          return [{ kind: 'cast', slot: esc, x: to.x, y: to.y }]
        }
      }
    }
    const go = best.dist + 40
    return [{ kind: 'move', x: from.x + best.dir.x * go, y: from.y + best.dir.y * go }]
  }

  /**
   * Lava risk now (Teleport save): standing in lava, or (saveLookahead) being carried toward
   * it, where walking back would burn us to death or cost most of our HP.
   */
  private lavaRisk(state: SimState, me: PawnState, layer: number): boolean {
    const p = this.params
    const ph = physVelocity(me)
    const onLava = !isSafe(layer, me.x, me.y)
    const sliding = hypot(ph.x, ph.y) > me.moveSpeed
    if (!onLava && !(p.saveLookahead && sliding)) return false
    const out = lavaOutcome(state, me, ph, me.hp, me.moveSpeed, layer)
    return out.lethal || out.damage >= me.hp * 0.45 || (onLava && out.lavaTime > 1.5)
  }

  /**
   * An enemy bolt we cannot walk out of before it arrives (after our reaction delay), whose
   * knockback would be lethal or cost most of our HP in lava.
   */
  private unavoidableHit(state: SimState, me: PawnState, threats: ProjectileState[], layer: number): boolean {
    for (const pr of threats) {
      const v2 = pr.vx * pr.vx + pr.vy * pr.vy
      if (v2 < 1) continue
      if (this.params.useCover && shieldedFrom(state, pr, me.x, me.y)) continue
      const rx = me.x - pr.x
      const ry = me.y - pr.y
      const tc = (rx * pr.vx + ry * pr.vy) / v2
      if (tc <= 0 || tc > 1.5) continue
      const v = Math.sqrt(v2)
      const line = Math.abs(rx * pr.vy - ry * pr.vx) / v
      const hitR = pr.radius + PAWN_BODY
      if (line >= hitR + 5) continue
      const avail = tc - this.params.reactionDelay - 0.06
      if (avail > 0 && hitR + 10 - line <= me.moveSpeed * avail) continue
      const hit = projectileHit(pr.spell, pr.level ?? 1)
      const after = afterHit(state, me, hit.damage, hit.kbFactor, pr.vx / v, pr.vy / v)
      const left = me.hp - hit.damage
      if (left <= 1) return true
      const out = lavaOutcome(state, me, after, left, me.moveSpeed, layer)
      if (out.lethal || out.damage >= left * 0.4) return true
    }
    return false
  }

  /**
   * Our own shots that will meet a raised Shield before it drops, mirrored as if already on
   * their way back (a player sees the bubble go up in front of their Fireball and moves).
   */
  private comingBack(state: SimState, enemies: PawnState[]): ProjectileState[] {
    const out: ProjectileState[] = []
    for (const pr of state.projectiles) {
      if (pr.owner !== this.player) continue
      const kind = pr.kind ?? pr.spell
      if (UNREFLECTED.has(kind) || NOT_STOLEN.has(kind)) continue
      const v = hypot(pr.vx, pr.vy)
      if (v < 1) continue
      for (const e of enemies) {
        const m = e.modifiers.find((x) => x.id === 'shield')
        if (!m) continue
        const rx = e.x - pr.x
        const ry = e.y - pr.y
        const along = (rx * pr.vx + ry * pr.vy) / v
        const line = Math.abs(rx * pr.vy - ry * pr.vx) / v
        const r = m.data.radius ?? 0
        if (along <= 0 || line >= r) continue
        const meet = (along - Math.sqrt(r * r - line * line)) / v
        if (m.ticksLeft >= 0 && meet * TICK_HZ > m.ticksLeft) continue
        // marked as ours before the steal, like a shot the Shield has already taken
        out.push({ ...pr, owner: e.owner, vx: -pr.vx, vy: -pr.vy, data: { ...pr.data, origOwner: this.player } })
        break
      }
    }
    return out
  }

  /** Local opportunities plus score hysteresis: a better fight can win immediately, while
   * small score fluctuations do not flip targets. No minimum or maximum chase duration. */
  private pickTarget(state: SimState, me: PawnState, enemies: PawnState[], current: PawnState | null, threats: ProjectileState[]): PawnState | null {
    let best: PawnState | null = null
    let bestScore = -Infinity
    for (const enemy of enemies) {
      const proximity = 1 / (1 + (dist(me, enemy) / 750) ** 2)
      const attachment = enemy === current ? RETARGET_MARGIN * this.persona.focus * proximity : 0
      const score = this.opportunity(state, me, enemy, threats) + attachment
      if (score > bestScore) {
        bestScore = score
        best = enemy
      }
    }
    return best
  }

  /** How good a target `e` is for us right now (FFA). Higher is better; distance dominates at targetSense 0. */
  private opportunity(state: SimState, me: PawnState, e: PawnState, threats: ProjectileState[]): number {
    const p = this.params
    const d = dist(me, e)
    const near = 1 / (1 + (d / 750) ** 2)
    const sense = p.targetSense
    // Nearby bodies imply competition and crossfire, continuously rather than a headcount
    // inside a radius. Saturation leaves an excellent contested finish worth taking.
    let engaged = 0
    for (const other of state.pawns) if (other.alive && other !== me && other !== e) {
      engaged += 1 / (1 + (dist(other, e) / CROWD_FALLOFF) ** 2)
    }
    const contested = (engaged / (1 + engaged)) * (0.65 - 0.25 * this.persona.risk)
    if (sense <= 0) return near
    const r = layerRadius(state.arena.layer)
    const edge = Math.max(0, Math.min(1, 1 - (r - hypot(e.x, e.y)) / 600))
    // a kill chance across the map is worth less: by the time we get there it has moved on
    const kill = Math.min(1, (edge * 1.2 + e.kbPoints / 600 + (1 - e.hp / Math.max(1, e.maxHp)) * 0.3) / 2) * (1 - 0.6 * Math.min(1, d / 1500))
    const speed = hypot(e.vx, e.vy)
    const easyHit = 1 - Math.min(1, speed / 320)
    // who threatens us: close, or with a bolt on its way to us
    let threat = Math.max(0, 1 - d / 500)
    for (const pr of threats) {
      if (pr.owner !== e.owner) continue
      const v = hypot(pr.vx, pr.vy)
      if (v < 1) continue
      const rx = me.x - pr.x
      const ry = me.y - pr.y
      if ((rx * pr.vx + ry * pr.vy) / v > 0 && Math.abs(rx * pr.vy - ry * pr.vx) / v < 120) threat = 1
    }
    const grudge = this.recentHit?.owner === e.owner ? this.persona.grudge * exp(-(state.tick - this.recentHit.tick) / (4 * TICK_HZ)) : 0
    // third-party push: already flying from someone's hit, toward the edge
    const kb = hypot(e.vx - e.walkVx, e.vy - e.walkVy)
    const outward = hypot(e.x, e.y) > 1 ? ((e.vx - e.walkVx) * e.x + (e.vy - e.walkVy) * e.y) / hypot(e.x, e.y) : 0
    const push = outward > 0 ? Math.min(1, kb / 600) * (0.4 + 0.6 * edge) * this.persona.opportunism : 0
    const killWeight = p.edgePressure ? 1 : 0.3
    const extra = (kill * killWeight + easyHit * 0.15 + push * 1.5) * near + threat * 0.7 + grudge * 0.8 * near
    return near + sense * (extra - contested)
  }

  /** Remember when each enemy raised its Shield (from the bubble and its time left). */
  private watchShields(enemies: PawnState[], tick: number): void {
    const def = spellDef('shield')
    for (const e of enemies) {
      const m = e.modifiers.find((x) => x.id === 'shield')
      if (!m || !def) continue
      const lv = e.levels[e.slots.indexOf('shield')] || 1
      const up = Math.round(attr(def, 'duration', lv) * TICK_HZ)
      this.shieldCast.set(e.owner, tick - Math.max(0, up - m.ticksLeft))
    }
  }

  /**
   * Is a shot of `spell` at `target` blocked by a bubble? Either a Shield or Alteration bubble
   * that will still be up when it gets there (reaction delay, windup, flight to the bubble's
   * edge), or a Shield the target owns and may raise (not seen used within its cooldown) from
   * so close that the stolen shot would be back before we could step aside. Visible state
   * only: bubbles, the loadout a player can inspect, and when we last saw the Shield used.
   */
  private bubbleBlocks(me: PawnState, target: PawnState, spell: SpellId): boolean {
    const info = BOT_SPELLS[spell]
    if (!info || info.bubbleProof) return false
    const sh = target.slots.indexOf('shield')
    const def = sh >= 0 ? spellDef('shield') : undefined
    if (def && !info.hitscan && !NOT_STOLEN.has(spell)) {
      const lv = target.levels[sh] || 1
      const seen = this.shieldCast.get(target.owner)
      // ready again by the time our shot gets there
      const arrive = (this.params.reactionDelay + info.castPoint + dist(me, target) / (info.speed ?? DEFAULT_SHOT_SPEED)) * TICK_HZ
      const ready = seen === undefined || this.lastTick - seen + arrive >= cooldownSeconds(def, lv) * TICK_HZ
      // the stolen shot flies back from the bubble's edge; stepping out of its path takes our
      // reaction plus a walk of its width plus ours. The gap when it leaves the hand: now,
      // minus how fast we are closing in over the reaction and the windup.
      const d = Math.max(1, dist(me, target))
      const closing = ((target.x - me.x) * (me.vx - target.vx) + (target.y - me.y) * (me.vy - target.vy)) / d
      const gap = d - Math.max(0, closing) * (this.params.reactionDelay + info.castPoint)
      const back = (gap - attr(def, 'radius', lv) - PAWN_BODY) / (info.speed ?? DEFAULT_SHOT_SPEED)
      const sidestep = this.params.reactionDelay + (SHOT_RADIUS + PAWN_BODY + 10) / Math.max(1, me.moveSpeed)
      // a stolen Homing missile turns on its caster: there is no stepping aside from it
      if (ready && (spell === 'homing' || back < sidestep + 0.1)) return true
    }
    let left = -Infinity
    let radius = 0
    for (const m of target.modifiers) {
      if (!BUBBLES.has(m.id)) continue
      const t = m.ticksLeft < 0 ? Infinity : m.ticksLeft / TICK_HZ
      if (t > left) {
        left = t
        radius = m.data.radius ?? 0
      }
    }
    if (left === -Infinity) return false
    const flight = info.hitscan ? 0 : Math.max(0, dist(me, target) - radius) / (info.speed ?? DEFAULT_SHOT_SPEED)
    return left > this.params.reactionDelay + info.castPoint + flight - BUBBLE_MARGIN
  }

  /** Whether `target` owns a Shield it may raise within `within` seconds (not seen used within its cooldown). */
  private shieldMayRise(target: PawnState, within: number): boolean {
    const sh = target.slots.indexOf('shield')
    const def = sh >= 0 ? spellDef('shield') : undefined
    if (!def) return false
    const seen = this.shieldCast.get(target.owner)
    return seen === undefined || this.lastTick - seen + within * TICK_HZ >= cooldownSeconds(def, target.levels[sh] || 1) * TICK_HZ
  }

  /** The closest enemy in range of `spell` whose bubble would not stop it, if any. */
  private openTarget(me: PawnState, enemies: PawnState[], spell: SpellId): PawnState | null {
    const range = BOT_SPELLS[spell]?.range ?? Infinity
    let best: PawnState | null = null
    for (const e of enemies) {
      if (dist(me, e) > range || this.bubbleBlocks(me, e, spell)) continue
      if (!best || dist(me, e) < dist(me, best)) best = e
    }
    return best
  }

  /**
   * A bolt our Shield (slot `slot`) would turn back: reflectable, on a collision course, not
   * hitting us before the Shield is up (reaction delay; Shield is instant), and reaching the
   * bubble's edge before it drops.
   */
  private incomingShot(me: PawnState, slot: number, threats: ProjectileState[]): boolean {
    const def = spellDef('shield')
    if (!def) return false
    const level = me.levels[slot] || 1
    const radius = attr(def, 'radius', level)
    const up = attr(def, 'duration', level)
    const delay = this.params.reactionDelay + 1 / TICK_HZ
    for (const pr of threats) {
      if (UNREFLECTED.has(pr.kind ?? pr.spell)) continue
      const v2 = pr.vx * pr.vx + pr.vy * pr.vy
      if (v2 < 1) continue
      const v = Math.sqrt(v2)
      const rx = me.x - pr.x
      const ry = me.y - pr.y
      const along = (rx * pr.vx + ry * pr.vy) / v
      if (along <= 0) continue
      const line = Math.abs(rx * pr.vy - ry * pr.vx) / v
      const hitR = pr.radius + PAWN_BODY
      if (line >= hitR + 20) continue
      const toBody = (along - hitR) / v
      const toEdge = (along - radius) / v
      if (toBody > delay && toEdge < delay + up - 0.1) return true
    }
    return false
  }

  /**
   * Best Teleport landing: in range, on safe ground (with momentumAware, where the 80% of our
   * velocity Teleport keeps still ends on a tile), out of bolts' paths, threat zones and
   * pillars, away from enemies and the edge. Null when nowhere is acceptable.
   */
  private planTeleport(state: SimState, me: PawnState, slot: number, threats: ProjectileState[], purpose: 'save' | 'dodge'): Vec2 | null {
    const p = this.params
    const def = spellDef('teleport')
    const range = def ? attr(def, 'range', me.levels[slot] || 1) : 770
    const safety = this.safetyLayer(state)
    const ph = physVelocity(me)
    const keep = p.momentumAware ? 0.8 : 0
    const carry = { x: ph.x * keep, y: ph.y * keep }
    const zones = threatZones(state, this.player)
    const enemies = state.pawns.filter((o) => o.alive && areEnemies(state, this.player, o.owner))
    let best: Vec2 | null = null
    let bestCost = Infinity
    for (const rf of TP_RADII) {
      for (let i = 0; i < TP_DIRS; i++) {
        const a = (i / TP_DIRS) * Math.PI * 2
        const land = { x: me.x + cos(a) * range * rf, y: me.y + sin(a) * range * rf }
        if (!isSafeWithMargin(safety, land.x, land.y, 40) || inPillar(state, land.x, land.y) || insideAny(zones, land.x, land.y)) continue
        const out = lavaOutcome(state, land, carry, me.hp, me.moveSpeed, safety, 2.5)
        if (out.lethal) continue
        let cost = out.damage * 8 + out.lavaTime * 150
        cost += this.dangerHere(state, threats, land.x, land.y) * (purpose === 'dodge' ? 60 : 25)
        for (const e of enemies) cost += Math.max(0, 450 - dist(land, e)) * 1.5
        if (!isSafeWithMargin(safety, land.x, land.y, 160)) cost += 250
        cost += hypot(land.x, land.y) * 0.15
        if (cost < bestCost) {
          bestCost = cost
          best = land
        }
      }
    }
    return best
  }

  /**
   * Scourge value: expected enemies still inside the radius when the windup ends (rooted,
   * linked or Gravity-pulled ones cannot walk out; walkers can once they notice), each
   * counting extra when the push would end in lava. kills = likely kills.
   */
  private scourgeValue(state: SimState, me: PawnState, enemies: PawnState[], channelling: boolean): { value: number; kills: number } {
    const def = spellDef('scourge')
    const slot = me.slots.indexOf('scourge')
    const level = slot >= 0 ? me.levels[slot] || 1 : 1
    const radius = def ? attr(def, 'radius', level) : SCOURGE_RADIUS
    const damage = def ? attr(def, 'damage', level) : 100
    const castPoint = def ? def.castPoint : 0.9
    // left of the windup: all of it plus our reaction when deciding, what remains when channelling
    const windup = channelling && me.cast ? me.cast.ticksLeft / TICK_HZ : castPoint + this.params.reactionDelay
    const layer = state.arena.layer
    const linked = new Set(me.modifiers.filter((m) => m.id === 'link').map((m) => m.data.target))
    const myGravity = state.projectiles.filter((pr) => pr.owner === this.player && pr.spell === 'gravity')
    let value = 0
    let kills = 0
    for (const e of enemies) {
      const stuck =
        e.modifiers.some((m) => m.id === 'grip') ||
        linked.has(e.id) ||
        myGravity.some((g) => hypot(g.x - e.x, g.y - e.y) < (g.data.pawnRadius || 550))
      const at = stuck ? { x: e.x, y: e.y } : positionAfter(state, e, Math.min(windup, HUMAN_NOTICE))
      const d = dist(me, at)
      if (d >= radius) continue
      const walk = Math.max(0, windup - HUMAN_NOTICE) * e.moveSpeed
      const pHit = stuck || e.cast ? 1 : Math.max(0, Math.min(1, (radius - d + 20) / Math.max(1, walk)))
      const dir = d > 1 ? { x: (at.x - me.x) / d, y: (at.y - me.y) / d } : { x: 1, y: 0 }
      const kf = 0.75 + 0.25 * (1 - d / radius)
      const after = afterHit(state, e, damage, kf, dir.x, dir.y)
      const left = e.hp - damage
      const out = left <= 1 ? null : lavaOutcome(state, at, after, left, e.moveSpeed, layer, 3)
      const kill = left <= 1 || out!.lethal ? 1 : out!.damage >= left * 0.5 ? 0.4 : 0
      value += pHit * (1 + 1.5 * kill)
      if (pHit >= 0.6 && kill >= 1) kills++
    }
    return { value, kills }
  }

  /** Edge pressure: the enemy most likely to die to a push (near the edge, high DP, close). */
  private killTarget(state: SimState, me: PawnState, enemies: PawnState[]): PawnState | null {
    const r = layerRadius(state.arena.layer)
    let best: PawnState | null = null
    let bestScore = -Infinity
    for (const e of enemies) {
      const edge = Math.max(0, Math.min(1, 1 - (r - hypot(e.x, e.y)) / 600))
      const score = edge * 1.2 + e.kbPoints / 600 + (1 - e.hp / e.maxHp) * 0.5 - dist(me, e) / 2500
      if (score > bestScore) {
        bestScore = score
        best = e
      }
    }
    return best
  }

  /**
   * Offensive Teleport: when the target is near the edge but our hits would push it inward,
   * the spot on its arena-centre side (shooting range, safe, out of bolts and zones).
   */
  private repositionSpot(state: SimState, me: PawnState, target: PawnState, threats: ProjectileState[], safety: number): Vec2 | null {
    if (me.hp < me.maxHp * 0.6) return null
    const tl = hypot(target.x, target.y)
    if (tl < 50 || layerRadius(state.arena.layer) - tl > 350) return null
    const ox = target.x / tl
    const oy = target.y / tl
    const d = Math.max(1, dist(me, target))
    // our hits already push it outward: nothing to gain
    if (((target.x - me.x) / d) * ox + ((target.y - me.y) / d) * oy > 0.3) return null
    const fb = me.slots.indexOf('fireball')
    if (fb < 0 || !castable(me, fb)) return null
    const tp = me.slots.indexOf('teleport')
    const def = spellDef('teleport')
    const range = def ? attr(def, 'range', me.levels[tp] || 1) : 770
    const spot = { x: target.x - ox * 430, y: target.y - oy * 430 }
    if (dist(me, spot) > range || !isSafeWithMargin(safety, spot.x, spot.y, 120) || inPillar(state, spot.x, spot.y)) return null
    if (insideAny(threatZones(state, this.player), spot.x, spot.y) || this.dangerHere(state, threats, spot.x, spot.y) > 1) return null
    return spot
  }

  /**
   * Chance the shot connects: the target needs to walk out by our hit radius once it notices
   * the cast; rooted, knocked or casting targets cannot.
   */
  private shotChance(state: SimState, me: PawnState, target: PawnState, spell: SpellId, aim: Vec2): number {
    const info = BOT_SPELLS[spell]
    if (!info?.speed) return 1
    if (target.cast || target.modifiers.some((m) => m.id === 'grip')) return 1
    const ph = physVelocity(target)
    if (hypot(ph.x, ph.y) > target.moveSpeed * 1.5) return 1
    const flight = dist(me, aim) / info.speed + info.castPoint
    const room = Math.max(0, flight - HUMAN_NOTICE) * target.moveSpeed
    const r = (spell === 'fireball' ? 25 : 30) + PAWN_BODY
    const edge = Math.max(0, Math.min(1, 1 - (layerRadius(state.arena.layer) - hypot(target.x, target.y)) / 400))
    // a shot at a target near the edge is worth it even if it can step aside: it must
    return Math.max(edge, Math.min(1, r / Math.max(1, room)))
  }

  /** The layer the bot plans against: the next one when a shrink is imminent. */
  private safetyLayer(state: SimState): number {
    const a = state.arena
    const look = this.params.shrinkLookahead
    if (look > 0 && a.nextShrinkTick >= 0 && a.nextShrinkTick - state.tick <= secToTicks(look) && a.layer > 2) {
      return a.layer - 1
    }
    return a.layer
  }

  private slotsWithRole(me: PawnState, role: BotSpellRole): number[] {
    const out: number[] = []
    me.slots.forEach((s, i) => {
      if (s != null && BOT_SPELLS[s]?.role === role) out.push(i)
    })
    return out
  }

  /** First castable slot holding a spell of `role`, or -1. */
  private findSlot(me: PawnState, role: BotSpellRole): number {
    for (const i of this.slotsWithRole(me, role)) if (castable(me, i)) return i
    return -1
  }

  private pickWander(state: SimState, me: PawnState, target: PawnState | null, safety: number): void {
    const p = this.params
    const tries = p.safeWander ? 12 : 1
    let point: Vec2 | null = null
    let delay = 0.6
    const enemies = state.pawns.filter((other) => other.alive && areEnemies(state, this.player, other.owner))
    if (enemies.length >= 2) {
      point = this.pickFfaWander(state, me, target, enemies, safety)
      delay = this.rng.range(0.4, 0.8)
    } else {
      if (p.edgePressure && target) {
        // hold the arena-centre side of the target at shooting range, so hits push it out;
        // farther while it may raise a Shield, so a shot it sends back leaves time to step aside
        const far = this.shieldMayRise(target, 1)
        const tl = hypot(target.x, target.y)
        const ox = tl > 50 ? target.x / tl : (me.x - target.x) / Math.max(1, dist(me, target))
        const oy = tl > 50 ? target.y / tl : (me.y - target.y) / Math.max(1, dist(me, target))
        for (let i = 0; i < 6 && !point; i++) {
          const a = this.rng.range(-0.5, 0.5)
          const r = far ? this.rng.range(SHIELD_STANDOFF, SHIELD_STANDOFF + 150) : this.rng.range(450, 650)
          const c = cos(a)
          const sn = sin(a)
          const cand = { x: target.x - (ox * c - oy * sn) * r, y: target.y - (ox * sn + oy * c) * r }
          if (!inPillar(state, cand.x, cand.y) && isSafeWithMargin(safety, cand.x, cand.y, p.edgeMargin)) point = cand
        }
        delay = this.rng.range(0.3, 0.6)
      }
      for (let i = 0; i < tries && !point; i++) {
        let centre: Vec2
        let radius: number
        if (target && this.rng.chance(WANDER_NEAR_TARGET_CHANCE)) {
          centre = target
          radius = WANDER_NEAR_TARGET_RADIUS
          delay = this.rng.range(0.2, 0.4)
        } else {
          centre = { x: 0, y: 0 }
          radius = WANDER_CENTRE_FACTOR * state.arena.layer * TILE_SIZE
          delay = this.rng.range(0.4, 0.8)
        }
        const a = this.rng.range(0, Math.PI * 2)
        const r = this.rng.range(0, radius)
        const cand = { x: centre.x + cos(a) * r, y: centre.y + sin(a) * r }
        if (inPillar(state, cand.x, cand.y)) continue
        if (!p.safeWander || isSafeWithMargin(safety, cand.x, cand.y, p.edgeMargin)) point = cand
      }
    }
    if (!point) {
      point = nearestTileCentre(safety, me.x, me.y, true) ??
        nearestTileCentre(state.arena.layer, me.x, me.y, true) ?? { x: 0, y: 0 }
    }
    this.wander = point
    this.nextWanderTick = state.tick + secToTicks(delay)
  }

  /** Trade firing position, travel and local danger; crowding and low health change the
   * utility of a position, never impose a minimum separation or a forced retreat. */
  private pickFfaWander(state: SimState, me: PawnState, target: PawnState | null, enemies: PawnState[], safety: number): Vec2 | null {
    const p = this.params
    const caution = (1 - me.hp / Math.max(1, me.maxHp)) * (1 - this.persona.risk)
    const shootingRange = 480 + caution * 220
    const threats = state.projectiles.filter((shot) => areEnemies(state, this.player, shot.owner))
    let best: Vec2 | null = null
    let bestScore = -Infinity
    const consider = (point: Vec2) => {
      if (inPillar(state, point.x, point.y) || (p.safeWander && !isSafeWithMargin(safety, point.x, point.y, p.edgeMargin))) return
      let pressure = 0
      for (const enemy of enemies) pressure += 1 / (1 + (dist(point, enemy) / CROWD_FALLOFF) ** 2)
      const range = target ? dist(point, target) : 0
      const firing = target ? 1 / (1 + ((range - shootingRange) / 400) ** 2) : 0
      const travel = dist(me, point) / 1500
      const danger = Math.min(1, this.dangerHere(state, threats, point.x, point.y) / 1000)
      let pushAngle = 0
      if (p.edgePressure && target) {
        const radius = hypot(target.x, target.y)
        if (radius > 1) pushAngle = ((target.x - point.x) * target.x + (target.y - point.y) * target.y) / (radius * Math.max(1, range))
      }
      const score = firing + pushAngle * 0.2 - pressure * (0.2 + caution * 0.5) - travel * 0.25 - danger * 0.6
      if (score > bestScore) {
        bestScore = score
        best = point
      }
    }
    // Include holding ground: moving is useful only when another position scores better.
    consider({ x: me.x, y: me.y })
    for (let i = 0; i < 12; i++) {
      const angle = this.rng.range(0, Math.PI * 2)
      const aroundTarget = target && i < 6
      const centre = aroundTarget ? target : me
      const radius = aroundTarget ? this.rng.range(300, 850) : this.rng.range(180, 600)
      consider({ x: centre.x + cos(angle) * radius, y: centre.y + sin(angle) * radius })
    }
    return best
  }

  /**
   * Where to point the escape spell. The original used its wander point; we take the first
   * candidate whose actual landing spot (clamped to the spell's range) is safe ground.
   */
  private escapeDestination(state: SimState, me: PawnState, slot: number): Vec2 {
    const spell = me.slots[slot]!
    const range = escapeRange(spell, me.levels[slot] || 1)
    const safety = this.safetyLayer(state)
    const margin = Math.min(60, Math.max(this.params.edgeMargin, 30))
    const cands: Vec2[] = []
    if (this.wander) cands.push(this.wander)
    const d = hypot(me.x, me.y)
    if (d > 1) {
      for (const inset of [this.params.edgeMargin + 120, 300, 500]) {
        const r = Math.max(0, layerRadius(safety) - inset)
        cands.push({ x: (me.x / d) * r, y: (me.y / d) * r })
      }
    }
    const tile = nearestTileCentre(safety, me.x, me.y, true)
    if (tile) cands.push(tile)
    for (const c of cands) {
      const land = clampToRange(me, c, range)
      if (isSafeWithMargin(safety, land.x, land.y, margin)) return land
    }
    for (const c of cands) {
      const land = clampToRange(me, c, range)
      if (isSafe(state.arena.layer, land.x, land.y)) return land
    }
    return clampToRange(me, { x: 0, y: 0 }, range)
  }

  /**
   * Walk down the danger gradient, evaluated where we will be when the order lands
   * (`from`). Keeps the previous side while it still lowers danger: re-deciding every
   * think with a reaction delay makes a bot standing on the line zig-zag across it.
   */
  /** Danger at a point; with useCover, bolts a pillar stops before they reach it do not count. */
  private dangerHere(state: SimState, threats: ProjectileState[], x: number, y: number): number {
    if (!this.params.useCover || state.obstacles.length === 0) return dangerAt(threats, x, y)
    return dangerAt(
      threats.filter((p) => !shieldedFrom(state, p, x, y)),
      x,
      y,
    )
  }

  private dodgeMove(state: SimState, from: Vec2, threats: ProjectileState[], danger: number): InputCommand {
    const lowers = (d: Vec2, reach: number) =>
      this.dangerHere(state, threats, from.x + d.x * reach, from.y + d.y * reach) < danger
    const prev = state.tick - this.lastDodgeTick <= 2 * this.thinkTicks ? this.dodgeDir : null
    // on the line: keep our side, else break toward the arena centre (away from lava)
    let dir = dodgeDirection(threats, from.x, from.y, prev ?? { x: -from.x, y: -from.y })
    if (prev && lowers(prev, 40)) dir = prev
    const layer = this.safetyLayer(state)
    const clear = (d: Vec2) => {
      const ahead = { x: from.x + d.x * DODGE_LOOKAHEAD, y: from.y + d.y * DODGE_LOOKAHEAD }
      // never dodge into a pillar; lava only when the preset knows to look
      if (firstBlocking(state, from, ahead)) return false
      return !this.params.dodgeAvoidsLava || isSafe(layer, ahead.x, ahead.y)
    }
    if (!clear(dir) || !lowers(dir, DODGE_LOOKAHEAD)) {
      for (const a of [0.5, -0.5, 1.0, -1.0, 1.4, -1.4, 1.9, -1.9]) {
        const c = cos(a)
        const s = sin(a)
        const d = { x: dir.x * c - dir.y * s, y: dir.x * s + dir.y * c }
        if (clear(d) && lowers(d, DODGE_LOOKAHEAD)) {
          dir = d
          break
        }
      }
    }
    this.dodgeDir = dir
    this.lastDodgeTick = state.tick
    return { kind: 'move', x: from.x + dir.x * DODGE_REACH, y: from.y + dir.y * DODGE_REACH }
  }

  private aimAt(me: PawnState, target: PawnState, spell: SpellId, state?: SimState): Vec2 | null {
    const p = this.params
    const info = BOT_SPELLS[spell]
    let point: Vec2 = { x: target.x, y: target.y }
    const windup = info && p.leadWindup ? info.castPoint + p.reactionDelay : 0
    if (info?.landDelay !== undefined && this.rng.chance(p.leadChance)) {
      // lands where the target will be after the fall, not where it is
      const t = info.landDelay + windup
      point = { x: target.x + target.vx * t, y: target.y + target.vy * t }
    } else if (info?.speed && this.rng.chance(p.leadChance)) {
      point = p.frictionLead && state
        ? leadWithFriction(state, me, target, info.speed, windup)
        : leadPoint(me, target, { x: target.vx, y: target.vy }, info.speed, windup)
    }
    if ((p.rangeCheck || info?.hitscan) && info?.range && dist(me, point) > info.range) return null
    if (p.aimErrorRad > 0) {
      // triangular in [-err, err]: mostly close, occasionally at the limit
      point = rotateAround(me, point, (this.rng.next() + this.rng.next() - 1) * p.aimErrorRad)
    }
    return point
  }

  /** Lightning at our own Fireball when it is about to pass an enemy within the blast radius. */
  private lightningCombo(state: SimState, me: PawnState, enemies: PawnState[]): InputCommand | null {
    const slot = me.slots.indexOf('lightning')
    if (slot < 0 || !castable(me, slot) || me.cast) return null
    // the beam fires after the cast point and our reaction: aim where the Fireball will be
    const lag = (BOT_SPELLS.lightning?.castPoint ?? 0.2) + this.params.reactionDelay
    for (const pr of state.projectiles) {
      if (pr.owner !== this.player || pr.spell !== 'fireball' || pr.kind !== undefined) continue
      const fx = pr.x + pr.vx * lag
      const fy = pr.y + pr.vy * lag
      if (hypot(fx - me.x, fy - me.y) > LIGHTNING_RANGE * 0.95) continue
      const victim = enemies.find((e) => hypot(e.x + e.vx * lag - fx, e.y + e.vy * lag - fy) < FIREBALL_DETONATE_RADIUS * 0.8)
      if (victim) return { kind: 'cast', slot, x: fx, y: fy }
    }
    return null
  }

  private checkPendingBuy(tick: number, me: PawnState | null, gold: number): void {
    const pb = this.pendingBuy
    if (!pb) return
    if (me?.slots.includes(pb.spell) || gold < pb.gold) {
      this.pendingBuy = null
    } else if (tick > pb.tick + secToTicks(1)) {
      // rejected (spell not in this build, shop closed, ...): try something else soon
      this.failedBuys.add(pb.spell)
      this.pendingBuy = null
      this.nextBuyTick = tick + secToTicks(0.5)
    }
  }

  /** Original buyRandomSpell: 50% an escape spell if we have none, else a random free target column. */
  private chooseBuy(me: PawnState | null): SpellId | null {
    const slots = me?.slots ?? []
    const owns = (s: SpellId) => slots.includes(s)
    const ok = (s: SpellId) => isBuyable(s) && !this.failedBuys.has(s)
    const escapes = ESCAPE_SPELLS.some(owns) ? [] : ESCAPE_SPELLS.filter(ok)
    const columns = TARGET_COLUMNS.filter((col) => !col.some(owns) && col.some(ok))
    if (escapes.length > 0 && (columns.length === 0 || this.rng.chance(0.5))) return this.rng.pick(escapes)
    if (columns.length > 0) return this.rng.pick(this.rng.pick(columns).filter(ok))
    return null
  }
}
