/**
 * Rounds mode (original ModeLTS, systems.md §7.2): shop -> fight -> roundEnd -> shop | gameOver.
 *
 * - shop: settings.shopSeconds, combat off (no damage), players move/cast to practice,
 *   arena at layer 14, everyone respawned.
 * - fight: round += 1, re-team, respawn all active players with 2 s invulnerability,
 *   arena at 13 + active players (clamped 1..21), one layer removed every 10 s.
 * - roundEnd: entered the moment one team (or none) is left alive; +1 score to every member of
 *   the winning team at once; after 2 s round gold to everyone, then win check.
 *
 * TODO(deathmatch): ModeDeathmatch (60 s rounds, 10 s respawn, 1 score per kill, no shrink,
 * systems.md §7.3) is not implemented; 'deathmatch' currently plays as rounds.
 */
import { clampLayer } from './arena'
import {
  ARENA_BASE_LAYER,
  ARENA_LAYER_PER_PLAYER,
  ARENA_SHOP_LAYER,
  OBSTACLE_COUNT_MAX,
  OBSTACLE_COUNT_MIN,
  OBSTACLE_HP,
  OBSTACLE_MAX_COORD,
  OBSTACLE_RADII,
  ROUND_END_SECONDS,
  SHRINK_PERIOD,
  SPAWN_INVULN_SECONDS,
  SPAWN_OBSTACLES,
  TEAM_DRAW,
  ticks,
} from './config'
import { MOD_SPAWN_INVULNERABLE, addModifier } from './modifiers'
import { randomInt, randomRange } from './rng'
import { respawnPawn } from './spawn'
import { activePlayers, assignTeams, isActive, scoreOf, teamOf } from './teams'
import type { PawnState, PlayerId, SimState } from './types'

/** Damage is only dealt while combat is on (original GAME.combat). */
export function isCombat(state: SimState): boolean {
  return state.phase === 'fight'
}

function emitPhase(state: SimState): void {
  state.events.push({ type: 'phase', phase: state.phase, round: state.round })
}

function spawnObstacles(state: SimState): void {
  state.obstacles = []
  if (!SPAWN_OBSTACLES) return
  const radii = OBSTACLE_RADII[state.arena.theme] ?? OBSTACLE_RADII[0]
  const count = randomInt(state, OBSTACLE_COUNT_MIN, OBSTACLE_COUNT_MAX)
  for (let i = 0; i < count; i++) {
    const x = randomRange(state, -OBSTACLE_MAX_COORD, OBSTACLE_MAX_COORD)
    const y = randomRange(state, -OBSTACLE_MAX_COORD, OBSTACLE_MAX_COORD)
    const variant = randomInt(state, 0, radii.length - 1)
    state.obstacles.push({ id: state.nextEntityId++, x, y, radius: radii[variant], hp: OBSTACLE_HP, variant })
  }
}

/** Shop phase (Mode:prepareForRound). */
export function prepareForRound(state: SimState): void {
  state.phase = 'shop'
  state.phaseTicksLeft = ticks(state.settings.shopSeconds)
  state.projectiles = []
  state.arena.nextShrinkTick = -1
  state.arena.theme = randomInt(state, 0, OBSTACLE_RADII.length - 1)
  spawnObstacles(state)
  state.arena.layer = ARENA_SHOP_LAYER
  for (const pawn of state.pawns) {
    if (isActive(state, pawn.owner)) respawnPawn(state, pawn)
  }
  emitPhase(state)
}

/** Fight phase (Mode:onRoundStart). */
export function startRound(state: SimState): void {
  state.round += 1
  state.projectiles = []
  state.phase = 'fight'
  state.phaseTicksLeft = -1
  assignTeams(state)
  for (const sc of state.scores) sc.damageThisRound = 0
  const invuln = ticks(SPAWN_INVULN_SECONDS)
  for (const pawn of state.pawns) {
    if (!isActive(state, pawn.owner)) {
      pawn.alive = false
      continue
    }
    respawnPawn(state, pawn)
    addModifier(state, pawn, MOD_SPAWN_INVULNERABLE, invuln, null)
  }
  const players = activePlayers(state).length
  state.arena.layer = clampLayer(ARENA_BASE_LAYER + ARENA_LAYER_PER_PLAYER * players)
  state.arena.nextShrinkTick = state.tick + ticks(SHRINK_PERIOD)
  emitPhase(state)
}

/** Teams with at least one living active pawn, ascending. */
export function aliveTeams(state: SimState): number[] {
  const teams = new Set<number>()
  for (const p of state.pawns) if (p.alive && isActive(state, p.owner)) teams.add(teamOf(state, p.owner))
  return Array.from(teams).sort((a, b) => a - b)
}

/** ModeLTS:onKill. Called by killPawn after the death is recorded. */
export function onKill(state: SimState, _victim: PawnState, _killer: PlayerId | null): void {
  if (!isCombat(state)) return
  const teams = aliveTeams(state)
  if (teams.length <= 1) roundWon(state, teams.length === 1 ? teams[0] : null)
}

/** Mode:onRoundWon. Combat ends immediately (later deaths in the same tick are cancelled). */
export function roundWon(state: SimState, team: number | null): void {
  state.phase = 'roundEnd'
  state.phaseTicksLeft = ticks(ROUND_END_SECONDS)
  if (team === null) {
    state.events.push({ type: 'roundWin', team: TEAM_DRAW, players: [] })
  } else {
    const players = activePlayers(state).filter((id) => teamOf(state, id) === team)
    for (const id of players) {
      const sc = scoreOf(state, id)!
      sc.score += 1
      sc.gold += state.settings.winGold
    }
    state.events.push({ type: 'roundWin', team, players })
  }
  emitPhase(state)
}

/**
 * Score win condition with the v1 fix (winners = every player with the max score >= winScore).
 * No-draw rule: in FFA and Shuffle a shared top score keeps the match going.
 */
export function gameWinners(state: SimState): PlayerId[] | null {
  let top = -Infinity
  for (const sc of state.scores) if (sc.score > top) top = sc.score
  if (top < state.settings.winScore) return null
  const winners = state.scores.filter((sc) => sc.score === top).map((sc) => sc.id)
  if (winners.length > 1 && state.settings.teamMode !== 'teams') return null
  return winners
}

/** Mode:onRoundEnd. */
export function endRound(state: SimState): void {
  for (const sc of state.scores) sc.gold += state.settings.roundGold
  const winners = gameWinners(state)
  if (winners) {
    state.phase = 'gameOver'
    state.phaseTicksLeft = -1
    state.arena.nextShrinkTick = -1
    emitPhase(state)
    state.events.push({ type: 'gameOver', winners })
    return
  }
  prepareForRound(state)
}

/** Phase timers and arena shrink. Runs once per tick after combat resolution. */
export function phaseTick(state: SimState): void {
  const a = state.arena
  if (a.nextShrinkTick >= 0 && state.tick >= a.nextShrinkTick) {
    if (a.layer > 1) {
      a.layer -= 1
      state.events.push({ type: 'arenaShrink', layer: a.layer })
    }
    a.nextShrinkTick += ticks(SHRINK_PERIOD)
  }
  if (state.phase === 'shop' || state.phase === 'roundEnd') {
    if (state.phaseTicksLeft > 0) state.phaseTicksLeft -= 1
    if (state.phaseTicksLeft <= 0) {
      if (state.phase === 'shop') startRound(state)
      else endRound(state)
    }
  }
}
