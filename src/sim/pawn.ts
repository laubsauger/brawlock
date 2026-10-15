/**
 * Pawn orders and pre-tick (spells.md §2.5-§2.6, §3.4). The original delegated walking, turning
 * and cast points to the Dota unit controller; this re-implements them explicitly:
 *
 * - move: turn toward the target at 1.2 rad / 0.03 s; walk at moveSpeed only while facing is
 *   within FACING_TOLERANCE (0.2 rad) of the target direction.
 * - cast (point, not IMMEDIATE / IGNORE_TURN): clears the move order, turns to face the target,
 *   then counts the cast point down and fires. No-target spells skip the turn.
 * - IMMEDIATE spells fire on the order without turning or interrupting.
 * - stop (= hold), a new move or another cast during turn / cast point cancels the pending cast
 *   ('castCancel', no cooldown spent). There is no backswing: after a spell fires the pawn obeys
 *   the next order on the following tick.
 * - walk model per tick: v -= walk_prev; v *= friction; walk = derived; v += walk.
 */
import { DT } from './types'
import type { InputCommand, PawnState, PlayerId, SimState } from './types'
import { FACING_TOLERANCE, PAWN_WALK_SPEED_CAP, SLOT_COUNT, TURN_PER_TICK, ARRIVE_EPSILON, ticks } from './config'
import { angleDiff, atan2, wrapAngle } from './math'
import { modifiersOnSpellCast, modifiersPreTick } from './modifiers'
import { cancelCast, stopPawn } from './orders'
import { buyItem, buyMastery, buySpell } from './shop'
import { SPELLS, SPELL_BEHAVIORS, cooldownSeconds } from './spells'
import type { CastContext } from './spells/types'

/** Turn toward `desired` by at most TURN_PER_TICK. Returns the remaining |difference|. */
function turnToward(pawn: PawnState, desired: number): number {
  const diff = angleDiff(pawn.facing, desired)
  const step = diff > TURN_PER_TICK ? TURN_PER_TICK : diff < -TURN_PER_TICK ? -TURN_PER_TICK : diff
  pawn.facing = wrapAngle(pawn.facing + step)
  return Math.abs(diff - step)
}

/** Cooldown in ticks for a spell at a level. */
export function cooldownTicks(spell: string, level: number): number {
  const def = SPELLS[spell]
  return def ? ticks(cooldownSeconds(def, level)) : 0
}

/**
 * Fire the spell in `slot` now: start its cooldown, emit 'cast', run the caster's modifier
 * onSpellCast hooks (Pact, Windwalk, Grip, Link), then the spell behavior.
 */
export function fireSpell(state: SimState, pawn: PawnState, slot: number, x: number, y: number): void {
  const spell = pawn.slots[slot]
  if (!spell) return
  const def = SPELLS[spell]
  const behavior = SPELL_BEHAVIORS[spell]
  if (!def || !behavior) return
  const level = pawn.levels[slot]
  pawn.cooldowns[slot] = ticks(cooldownSeconds(def, level))
  state.events.push({ type: 'cast', pawn: pawn.id, spell, x, y })
  const ctx: CastContext = { state, caster: pawn, def, slot, level, x, y, overrides: {} }
  modifiersOnSpellCast(state, pawn, ctx)
  if (!pawn.alive) return
  behavior.onCast(ctx)
}

function startCast(state: SimState, pawn: PawnState, slot: number, x: number, y: number): void {
  const spell = pawn.slots[slot]
  if (!spell) return
  const def = SPELLS[spell]
  if (!def || !SPELL_BEHAVIORS[spell]) return
  if (pawn.cooldowns[slot] > 0) return
  if (def.immediate) {
    fireSpell(state, pawn, slot, x, y)
    return
  }
  // the identical order again (resent input) must not restart the cast point
  const c = pawn.cast
  if (c && c.slot === slot && c.x === x && c.y === y) return
  cancelCast(state, pawn)
  pawn.moveTarget = null
  pawn.cast = { slot, spell, ticksLeft: ticks(def.castPoint), x, y, started: false }
}

export function applyCommand(state: SimState, player: PlayerId, pawn: PawnState, cmd: InputCommand): void {
  switch (cmd.kind) {
    case 'move':
      if (!pawn.alive) return
      cancelCast(state, pawn)
      pawn.moveTarget = { x: cmd.x, y: cmd.y }
      return
    case 'stop':
      stopPawn(state, pawn)
      return
    case 'cast':
      if (!pawn.alive) return
      if (!Number.isInteger(cmd.slot) || cmd.slot < 0 || cmd.slot >= SLOT_COUNT) return
      startCast(state, pawn, cmd.slot, cmd.x, cmd.y)
      return
    case 'buySpell':
      buySpell(state, player, cmd.spell)
      return
    case 'buyItem':
      buyItem(state, player, cmd.item)
      return
    case 'buyMastery':
      buyMastery(state, player, cmd.mastery)
      return
  }
}

function castPreTick(state: SimState, pawn: PawnState): void {
  const cast = pawn.cast
  if (!cast) return
  const def = SPELLS[cast.spell]
  if (!def) {
    pawn.cast = null
    return
  }
  if (!cast.started) {
    let ready = true
    if (def.target === 'point' && !def.ignoreTurn) {
      const dx = cast.x - pawn.x
      const dy = cast.y - pawn.y
      if (dx !== 0 || dy !== 0) ready = turnToward(pawn, atan2(dy, dx)) <= FACING_TOLERANCE
    }
    if (!ready) return
    cast.started = true
    state.events.push({ type: 'castStart', pawn: pawn.id, spell: cast.spell, ticks: cast.ticksLeft })
  } else {
    cast.ticksLeft -= 1
  }
  if (cast.ticksLeft <= 0) {
    pawn.cast = null
    fireSpell(state, pawn, cast.slot, cast.x, cast.y)
  }
}

function walkPreTick(pawn: PawnState, friction: number): void {
  let vx = (pawn.vx - pawn.walkVx) * friction
  let vy = (pawn.vy - pawn.walkVy) * friction
  let wx = 0
  let wy = 0
  const t = pawn.moveTarget
  if (t && !pawn.cast) {
    const dx = t.x - pawn.x
    const dy = t.y - pawn.y
    const d = Math.sqrt(dx * dx + dy * dy)
    if (d < ARRIVE_EPSILON) {
      pawn.moveTarget = null
    } else if (turnToward(pawn, atan2(dy, dx)) <= FACING_TOLERANCE) {
      const speed = pawn.moveSpeed > 0 ? pawn.moveSpeed : 0
      let s = d / DT < speed ? d / DT : speed
      if (s > PAWN_WALK_SPEED_CAP) s = PAWN_WALK_SPEED_CAP
      wx = (dx / d) * s
      wy = (dy / d) * s
    }
  }
  vx += wx
  vy += wy
  pawn.vx = vx
  pawn.vy = vy
  pawn.walkVx = wx
  pawn.walkVy = wy
}

/**
 * Cooldowns count down at the end of every tick, so a spell fired on tick T (at the order or
 * after its cast point) is castable again on tick T + cooldownTicks exactly.
 */
export function cooldownTick(state: SimState): void {
  for (const pawn of state.pawns) {
    const cds = pawn.cooldowns
    for (let i = 0; i < cds.length; i++) if (cds[i] > 0) cds[i] -= 1
  }
}

/** Pawn:onPreTick: cast progression, walk + friction, modifier hooks. */
export function pawnPreTick(state: SimState, pawn: PawnState, friction: number): void {
  if (!pawn.alive) return
  castPreTick(state, pawn)
  if (!pawn.alive) return
  walkPreTick(pawn, friction)
  modifiersPreTick(state, pawn)
}
