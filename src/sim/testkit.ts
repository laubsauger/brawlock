/**
 * Test helpers for sim tests (no vitest import, safe to use from headless scripts too).
 */
import { DEFAULT_SETTINGS, ITEM_SLOT_START } from './config'
import { SPELLS } from './spells/data'
import { recomputeStats } from './stats'
import { createMatch, step } from './index'
import { removeModifiers, MOD_SPAWN_INVULNERABLE } from './modifiers'
import type { InputCommand, MatchSettings, PawnState, PlayerInput, PlayerSlot, SimEvent, SimState } from './types'

export function slots(n: number, teams?: number[]): PlayerSlot[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    name: `p${i}`,
    color: 0xffffff,
    team: teams ? teams[i] : 0,
    kind: 'human' as const,
  }))
}

export function newMatch(overrides: Partial<MatchSettings> = {}, n = 2, seed = 1, teams?: number[]): SimState {
  return createMatch({ ...DEFAULT_SETTINGS, ...overrides }, slots(n, teams), seed)
}

export function cmd(player: number, ...cmds: InputCommand[]): PlayerInput {
  return { player, tick: 0, cmds }
}

export function pawn(state: SimState, player: number): PawnState {
  const p = state.pawns.find((q) => q.owner === player)
  if (!p) throw new Error(`no pawn for ${player}`)
  return p
}

/** Step `n` ticks with no input; returns every event emitted, in order. */
export function run(state: SimState, n: number, inputs: (tick: number) => PlayerInput[] = () => []): SimEvent[] {
  const all: SimEvent[] = []
  for (let i = 0; i < n; i++) {
    step(state, inputs(state.tick))
    all.push(...state.events)
  }
  return all
}

/** Step until `pred` holds (or throw after `max` ticks). Returns events seen. */
export function runUntil(state: SimState, pred: (s: SimState) => boolean, max = 200000): SimEvent[] {
  const all: SimEvent[] = []
  for (let i = 0; i < max; i++) {
    if (pred(state)) return all
    step(state, [])
    all.push(...state.events)
  }
  throw new Error('runUntil: condition never met')
}

/** Skip the shop phase and the 2 s spawn invulnerability: combat is live afterwards. */
export function toCombat(state: SimState): void {
  runUntil(state, (s) => s.phase === 'fight')
  for (const p of state.pawns) removeModifiers(state, p, MOD_SPAWN_INVULNERABLE)
}

/**
 * Give a pawn a spell or item at a level without the shop (unreleased spells included).
 * Returns the slot index.
 */
export function grant(state: SimState, player: number, id: string, level = 1): number {
  const p = pawn(state, player)
  const def = SPELLS[id]
  let slot: number
  if (def && def.kind === 'spell') slot = def.column - 1
  else {
    slot = p.slots.indexOf(id)
    if (slot < 0) slot = p.slots.findIndex((s, i) => i >= ITEM_SLOT_START && s === null)
  }
  p.slots[slot] = id
  p.levels[slot] = level
  p.cooldowns[slot] = 0
  recomputeStats(p)
  return slot
}

/** Put a pawn somewhere, at rest, with no orders. */
export function place(p: PawnState, x: number, y: number, facing = p.facing): void {
  p.x = x
  p.y = y
  p.vx = 0
  p.vy = 0
  p.walkVx = 0
  p.walkVy = 0
  p.moveTarget = null
  p.cast = null
  p.facing = facing
}
