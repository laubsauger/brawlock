/**
 * Game modes (systems.md §7).
 *
 * Rounds (original ModeLTS, §7.2): shop -> fight -> roundEnd -> shop | gameOver.
 * - shop: settings.shopSeconds, combat off (no damage), players move/cast to practice,
 *   arena at layer 14, everyone respawned.
 * - fight: round += 1, re-team, temp actors (projectiles, Rockpillars) removed, respawn all
 *   active players with 2 s invulnerability, arena at 13 + active players (clamped 1..21),
 *   one layer removed every 10 s.
 * - roundEnd: entered the moment one team (or none) is left alive; +1 score to every member of
 *   the winning team at once; after 2 s round gold to everyone, then win check.
 *
 * Deathmatch (ModeDeathmatch, §7.3): one shop phase before round 1, then back-to-back 60 s
 * 'fight' rounds (phaseTicksLeft counts down). Every round start re-teams and rebuilds the
 * platform (13 + players) and pillars; only round 1 respawns everyone with 2 s invulnerability;
 * the arena never shrinks. A kill gives +1 score to every member of the killer's team; the
 * victim respawns 10 s later (pawn.respawnTicks) with 2 s invulnerability. v1 fix: a death
 * nobody caused (lava without a last hitter) scores for nobody. Round gold every round end; the
 * win check (first to winScore) runs at round ends only, like the original.
 */
import { clampLayer } from './arena'
import { settleSpectateBets } from './bets'
import {
  ARENA_BASE_LAYER,
  ARENA_LAYER_PER_PLAYER,
  ARENA_SHOP_LAYER,
  DM_RESPAWN_SECONDS,
  DM_ROUND_SECONDS,
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
import { MOD_SPAWN_INVULNERABLE, addModifier, removeTemporaryModifiers } from './modifiers'
import { randomInt, randomRange } from './rng'
import { respawnPawn } from './spawn'
import { activePlayers, assignTeams, isActive, scoreOf, teamOf } from './teams'
import type { PawnState, PlayerId, SimState } from './types'

/** Damage is only dealt while combat is on (original GAME.combat). */
export function isCombat(state: SimState): boolean {
  return state.phase === 'fight'
}

function isDeathmatch(state: SimState): boolean {
  return state.settings.gameMode === 'deathmatch'
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

function newPlatform(state: SimState): void {
  state.arena.theme = randomInt(state, 0, OBSTACLE_RADII.length - 1)
  spawnObstacles(state)
}

/** Respawn with the 2 s round-start invulnerability. */
function spawnInvulnerable(state: SimState, pawn: PawnState): void {
  respawnPawn(state, pawn)
  addModifier(state, pawn, MOD_SPAWN_INVULNERABLE, ticks(SPAWN_INVULN_SECONDS), null)
}

/** Shop phase (Mode:prepareForRound). */
export function prepareForRound(state: SimState): void {
  state.phase = 'shop'
  state.phaseTicksLeft = ticks(state.settings.shopSeconds)
  state.projectiles = []
  state.arena.nextShrinkTick = -1
  newPlatform(state)
  state.arena.layer = ARENA_SHOP_LAYER
  for (const pawn of state.pawns) {
    if (isActive(state, pawn.owner)) respawnPawn(state, pawn)
  }
  emitPhase(state)
}

/** Fight phase (Mode:onRoundStart / ModeDeathmatch:onRoundStart). */
export function startRound(state: SimState): void {
  const dm = isDeathmatch(state)
  const first = state.round === 0
  state.round += 1
  state.betting.bets = []
  state.phase = 'fight'
  assignTeams(state)
  const players = activePlayers(state).length
  if (dm) {
    state.phaseTicksLeft = ticks(DM_ROUND_SECONDS)
    state.arena.nextShrinkTick = -1 // never shrinks in deathmatch
    newPlatform(state)
    state.arena.layer = clampLayer(ARENA_BASE_LAYER + ARENA_LAYER_PER_PLAYER * players)
    if (first) {
      state.projectiles = []
      for (const sc of state.scores) sc.damageThisRound = 0
      for (const pawn of state.pawns) {
        if (!isActive(state, pawn.owner)) pawn.alive = false
        else spawnInvulnerable(state, pawn)
      }
    }
    emitPhase(state)
    return
  }
  state.phaseTicksLeft = -1
  state.projectiles = []
  state.obstacles = state.obstacles.filter((o) => o.ticksLeft === undefined) // temp actors (Rockpillar)
  for (const sc of state.scores) sc.damageThisRound = 0
  // the fight platform exists before anyone spawns on it (spawn radius is capped to it; the
  // original respawned first, which made no difference there because it never capped)
  state.arena.layer = clampLayer(ARENA_BASE_LAYER + ARENA_LAYER_PER_PLAYER * players)
  state.arena.nextShrinkTick = state.tick + ticks(SHRINK_PERIOD)
  for (const pawn of state.pawns) {
    if (!isActive(state, pawn.owner)) {
      pawn.alive = false
      continue
    }
    removeTemporaryModifiers(state, pawn)
    spawnInvulnerable(state, pawn)
  }
  emitPhase(state)
}

/** Teams with at least one living active pawn, ascending. */
export function aliveTeams(state: SimState): number[] {
  const teams = new Set<number>()
  for (const p of state.pawns) if (p.alive && isActive(state, p.owner)) teams.add(teamOf(state, p.owner))
  return Array.from(teams).sort((a, b) => a - b)
}

/** ModeLTS:onKill / ModeDeathmatch:onKill. Called by killPawn after the death is recorded. */
export function onKill(state: SimState, victim: PawnState, killer: PlayerId | null): void {
  if (!isCombat(state)) return
  if (isDeathmatch(state)) {
    if (killer !== null) {
      const team = teamOf(state, killer)
      for (const id of activePlayers(state)) if (teamOf(state, id) === team) scoreOf(state, id)!.score += 1
    }
    victim.respawnTicks = ticks(DM_RESPAWN_SECONDS)
    return
  }
  const teams = aliveTeams(state)
  if (teams.length <= 1) roundWon(state, teams.length === 1 ? teams[0] : null)
}

/** Mode:onRoundWon. Combat ends immediately (later deaths in the same tick are cancelled). */
export function roundWon(state: SimState, team: number | null): void {
  state.phase = 'roundEnd'
  state.phaseTicksLeft = ticks(ROUND_END_SECONDS)
  if (team === null) {
    settleSpectateBets(state, [])
    state.events.push({ type: 'roundWin', team: TEAM_DRAW, players: [] })
  } else {
    const players = activePlayers(state).filter((id) => teamOf(state, id) === team)
    settleSpectateBets(state, players)
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
  if (isDeathmatch(state)) startRound(state)
  else prepareForRound(state)
}

/** Deathmatch respawn timers (10 s after death, 2 s invulnerability). */
function respawnTick(state: SimState): void {
  for (const pawn of state.pawns) {
    if (pawn.alive || !pawn.respawnTicks) continue
    pawn.respawnTicks -= 1
    if (pawn.respawnTicks > 0) continue
    delete pawn.respawnTicks
    if (!isActive(state, pawn.owner)) continue
    spawnInvulnerable(state, pawn)
    state.events.push({ type: 'respawn', pawn: pawn.id, owner: pawn.owner, x: pawn.x, y: pawn.y })
  }
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
  if (isDeathmatch(state) && state.phase === 'fight') {
    respawnTick(state)
    state.phaseTicksLeft -= 1
    if (state.phaseTicksLeft <= 0) endRound(state)
    return
  }
  if (state.phase === 'shop' || state.phase === 'roundEnd') {
    if (state.phaseTicksLeft > 0) state.phaseTicksLeft -= 1
    if (state.phaseTicksLeft <= 0) {
      if (state.phase === 'shop') startRound(state)
      else endRound(state)
    }
  }
}
