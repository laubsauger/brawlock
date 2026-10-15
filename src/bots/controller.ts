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
import { isEnemy } from '../sim'
import type { Bot } from './index'
import { leadPoint, rotateAround } from './aim'
import { isSafe, isSafeWithMargin, layerRadius, nearestTileCentre, TILE_SIZE } from './arena'
import { dangerAt, dodgeDirection } from './danger'
import { BOT_PRESETS, type BotParams } from './presets'
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
const FIREBALL_DETONATE_RADIUS = 225
/** How far ahead a lava-aware dodge checks the ground. */
const DODGE_LOOKAHEAD = 150

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

const secToTicks = (s: number) => Math.round(s * TICK_HZ)
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y)

/** Alliance by current team, as the sim decides it. */
export const areEnemies = (state: SimState, a: PlayerId, b: PlayerId): boolean => isEnemy(state, a, b)

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
  private lastDodgeTick = -Infinity
  private nextBuyTick = -1
  private pendingBuy: { spell: SpellId; tick: number; gold: number } | null = null
  private readonly failedBuys = new Set<SpellId>()

  constructor(player: PlayerId, difficulty: BotDifficulty, seed: number, params: BotParams = BOT_PRESETS[difficulty]) {
    this.player = player
    this.difficulty = difficulty
    this.params = params
    this.rng = new Rng(botSeed(seed, player))
    this.thinkTicks = Math.max(1, secToTicks(params.thinkInterval))
    this.delayTicks = Math.max(0, secToTicks(params.reactionDelay))
  }

  think(state: SimState): InputCommand[] {
    if (!this.params.active) return []
    if (state.tick < this.lastTick) this.reset()
    this.lastTick = state.tick
    if (state.phase !== this.lastPhase) {
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
    this.lastDodgeTick = -Infinity
    this.nextBuyTick = -1
    this.pendingBuy = null
    this.failedBuys.clear()
  }

  private decide(state: SimState): InputCommand[] {
    const p = this.params
    const tick = state.tick
    const me = state.pawns.find((pw) => pw.owner === this.player) ?? null
    const gold = state.scores.find((s) => s.id === this.player)?.gold ?? 0

    // 1. Buy: between rounds or while dead, one spell per 40 s.
    this.checkPendingBuy(tick, me, gold)
    if (
      p.buys &&
      !this.pendingBuy &&
      tick >= this.nextBuyTick &&
      (state.phase !== 'fight' || !me?.alive) &&
      gold >= BUY_MIN_GOLD
    ) {
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

    // 2. Lava escape: cast the escape spell toward safe ground.
    if (onLava) {
      const esc = this.findSlot(me, 'escape')
      if (esc >= 0 && this.rng.chance(p.escapeChance)) {
        const dest = this.escapeDestination(state, me, esc)
        this.wander = null
        return this.act('escape', [{ kind: 'cast', slot: esc, x: dest.x, y: dest.y }])
      }
    }

    // 3. Retarget: lost target or 1/5 chance -> closest enemy.
    const current = this.target === null ? null : state.pawns.find((o) => o.owner === this.target)
    if (!current || !current.alive || !areEnemies(state, this.player, current.owner) || this.rng.chance(p.retargetChance)) {
      this.target = closest ? closest.owner : null
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

    // 5. Cast lock: never cancel our own windup with a new order.
    if (tick < this.spellEndTick) return this.act('idle', [])
    if (me.cast && me.cast.spell !== 'scourge') return this.act('idle', [])

    const threats = state.projectiles.filter((pr) => areEnemies(state, this.player, pr.owner))
    // Danger where we will be when this decision lands (a player plans from where they are going).
    const self = this.predictSelf(me, tick)
    const danger = dangerAt(threats, self.x, self.y)
    const mustDodge = p.dodge && danger >= p.dodgeThreshold

    // 6. Scourge channel: keep it unless in danger or the enemy walked away.
    if (me.cast?.spell === 'scourge' || tick < this.scourgeEndTick) {
      if (mustDodge || (closestDist > SCOURGE_RADIUS && this.rng.chance(SCOURGE_GIVE_UP_CHANCE))) {
        this.scourgeEndTick = 0
        const cmds: InputCommand[] = [{ kind: 'stop' }]
        if (mustDodge) cmds.push(this.dodgeMove(state, self, threats, danger))
        return this.act('cancelScourge', cmds)
      }
      return this.act('channel', [])
    }

    // 7. Dodge down the danger gradient.
    if (mustDodge) return this.act('dodge', [this.dodgeMove(state, self, threats, danger)])

    // 8. Scourge an enemy in reach.
    if (closest && closestDist <= p.scourgeRange) {
      const sc = this.findSlot(me, 'scourge')
      if (sc >= 0 && this.rng.chance(p.scourgeChance)) {
        this.scourgeEndTick = tick + secToTicks(SCOURGE_CHANNEL_SECONDS)
        return this.act('scourge', [{ kind: 'cast', slot: sc, x: me.x, y: me.y }])
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

    // 9. Shoot a random projectile spell at the target (falls through if not castable).
    if (target && this.rng.chance(p.castChance)) {
      const options = this.slotsWithRole(me, 'projectile')
      if (options.length > 0) {
        const slot = this.rng.pick(options)
        if (castable(me, slot) && !me.cast) {
          const aim = this.aimAt(me, target, me.slots[slot]!)
          if (aim) {
            this.spellEndTick = tick + secToTicks(CAST_LOCK_SECONDS)
            return this.act('shoot', [{ kind: 'cast', slot, x: aim.x, y: aim.y }])
          }
        }
      }
    }

    // 10. Move: off lava (or off a tile about to sink) by the shortest way, else wander.
    if (p.walkOffLava && (onLava || !isSafe(safety, me.x, me.y))) {
      const tile = nearestTileCentre(safety, me.x, me.y, true) ?? nearestTileCentre(layer, me.x, me.y, true)
      if (tile) return this.act('offLava', [{ kind: 'move', x: tile.x, y: tile.y }])
    }
    const w = this.wander!
    return this.act('wander', [{ kind: 'move', x: w.x, y: w.y }])
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
          const d = Math.hypot(c.x - x, c.y - y)
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
      const cand = { x: centre.x + Math.cos(a) * r, y: centre.y + Math.sin(a) * r }
      if (!p.safeWander || isSafeWithMargin(safety, cand.x, cand.y, p.edgeMargin)) point = cand
    }
    if (!point) {
      point = nearestTileCentre(safety, me.x, me.y, true) ??
        nearestTileCentre(state.arena.layer, me.x, me.y, true) ?? { x: 0, y: 0 }
    }
    this.wander = point
    this.nextWanderTick = state.tick + secToTicks(delay)
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
    const d = Math.hypot(me.x, me.y)
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
  private dodgeMove(state: SimState, from: Vec2, threats: ProjectileState[], danger: number): InputCommand {
    const lowers = (d: Vec2, reach: number) =>
      dangerAt(threats, from.x + d.x * reach, from.y + d.y * reach) < danger
    const prev = state.tick - this.lastDodgeTick <= 2 * this.thinkTicks ? this.dodgeDir : null
    // on the line: keep our side, else break toward the arena centre (away from lava)
    let dir = dodgeDirection(threats, from.x, from.y, prev ?? { x: -from.x, y: -from.y })
    if (prev && lowers(prev, 40)) dir = prev
    if (this.params.dodgeAvoidsLava) {
      const layer = this.safetyLayer(state)
      for (const a of [0, 0.5, -0.5, 1.0, -1.0, 1.4, -1.4]) {
        const c = Math.cos(a)
        const s = Math.sin(a)
        const d = { x: dir.x * c - dir.y * s, y: dir.x * s + dir.y * c }
        if (isSafe(layer, from.x + d.x * DODGE_LOOKAHEAD, from.y + d.y * DODGE_LOOKAHEAD) && lowers(d, DODGE_LOOKAHEAD)) {
          dir = d
          break
        }
      }
    }
    this.dodgeDir = dir
    this.lastDodgeTick = state.tick
    return { kind: 'move', x: from.x + dir.x * DODGE_REACH, y: from.y + dir.y * DODGE_REACH }
  }

  private aimAt(me: PawnState, target: PawnState, spell: SpellId): Vec2 | null {
    const p = this.params
    const info = BOT_SPELLS[spell]
    let point: Vec2 = { x: target.x, y: target.y }
    const windup = info && p.leadWindup ? info.castPoint + p.reactionDelay : 0
    if (info?.landDelay !== undefined && this.rng.chance(p.leadChance)) {
      // lands where the target will be after the fall, not where it is
      const t = info.landDelay + windup
      point = { x: target.x + target.vx * t, y: target.y + target.vy * t }
    } else if (info?.speed && this.rng.chance(p.leadChance)) {
      point = leadPoint(me, target, { x: target.vx, y: target.vy }, info.speed, windup)
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
      if (Math.hypot(fx - me.x, fy - me.y) > LIGHTNING_RANGE * 0.95) continue
      const victim = enemies.find((e) => Math.hypot(e.x + e.vx * lag - fx, e.y + e.vy * lag - fy) < FIREBALL_DETONATE_RADIUS * 0.8)
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
