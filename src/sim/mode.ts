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
 *   the winning team at once; after 3 s round gold to everyone, then win check.
 * - rankedRounds=5: scheduled scoring rounds, early clinch, then one tied-leader final if needed.
 *   The final awards the championship and win gold without changing scheduled-round scores.
 *
 * Deathmatch (ModeDeathmatch, §7.3): one shop phase before round 1, then back-to-back 60 s
 * 'fight' rounds (phaseTicksLeft counts down). Every round start re-teams and rebuilds the
 * platform (13 + players) and pillars; only round 1 respawns everyone with 2 s invulnerability;
 * the arena never shrinks. A kill gives +1 score to every member of the killer's team; the
 * victim respawns 10 s later (pawn.respawnTicks) with 2 s invulnerability. v1 fix: a death
 * nobody caused (lava without a last hitter) scores for nobody. Round gold every round end; the
 * win check (first to winScore) runs at round ends only, like the original.
 *
 * King of the Hill (not in the original): sim/hill.ts. Rounds style runs the rounds flow above
 * with the hill ticking in every fight; respawn style is one fight after one shop. Either ends
 * the moment a ticket reaches winScore.
 */
import { TILE_SIZE, arenaTiles, clampLayer, type ArenaTile } from './arena'
import { BET_TWO_STARTER_SECONDS, settleSpectateBets } from './bets'
import { hillStartLayer, hillTick, newHill, respawnsInFight } from './hill'
import {
  ARENA_BASE_LAYER,
  ARENA_LAYER_PER_PLAYER,
  ARENA_SHOP_LAYER,
  DM_RESPAWN_SECONDS,
  DM_ROUND_SECONDS,
  HILL_ARENA_MARGIN,
  HILL_ARENA_SHRINK_PERIOD,
  HILL_EXTRA_CLEAR,
  HILL_EXTRA_PILLARS_MAX,
  HILL_EXTRA_PILLARS_MIN,
  HILL_RESPAWN_SECONDS,
  HILL_RIM_GAP,
  HILL_ROUND_WIN_TICKETS,
  HILL_TIME_LIMIT_SECONDS,
  OBSTACLE_COUNT_MAX,
  OBSTACLE_COUNT_MIN,
  OBSTACLE_HP,
  OBSTACLE_MAX_COORD,
  OBSTACLE_RADII,
  ROUND_END_SECONDS,
  RANKED_FINAL_SHRINK_PERIOD,
  RANKED_SHRINK_PERIOD,
  SHRINK_PERIOD,
  SPAWN_INVULN_SECONDS,
  SPAWN_OBSTACLES,
  TEAM_DRAW,
  ticks,
} from './config'
import { hypot } from './math'
import { MOD_SPAWN_INVULNERABLE, addModifier, removeTemporaryModifiers } from './modifiers'
import { randomInt, randomRange } from './rng'
import { readyCut, shopLength } from './shop'
import { respawnPawn } from './spawn'
import { activePlayers, assignTeams, isActive, isRoundParticipant, scoreOf, teamOf } from './teams'
import type { PawnState, PlayerId, SimState } from './types'

/** Damage is only dealt while combat is on (original GAME.combat). */
export function isCombat(state: SimState): boolean {
  return state.phase === 'fight'
}

function isDeathmatch(state: SimState): boolean {
  return state.settings.gameMode === 'deathmatch'
}

function isHill(state: SimState): boolean {
  return state.settings.gameMode === 'hill'
}

/** King of the Hill, respawn style: one long fight. */
function hillFight(state: SimState): boolean {
  return isHill(state) && respawnsInFight(state.settings)
}

function shrinkPeriod(state: SimState): number {
  if (hillFight(state)) return HILL_ARENA_SHRINK_PERIOD
  return state.rankedFinal ? RANKED_FINAL_SHRINK_PERIOD :
    state.settings.rankedRounds ? RANKED_SHRINK_PERIOD : SHRINK_PERIOD
}

/** The arena sinks no further than this (respawn-style hill keeps ground around the hill). */
function arenaFloor(state: SimState): number {
  return hillFight(state) ? hillStartLayer(state.settings) + HILL_ARENA_MARGIN : 1
}

function finalLayer(state: SimState): number {
  return Math.min(15, 9 + state.rankedFinal!.contenders.length)
}

function emitPhase(state: SimState): void {
  state.events.push({ type: 'phase', phase: state.phase, round: state.round })
}

/** Whether a circle at (x, y) clears every tile square by `r`. */
function clearOf(tiles: readonly ArenaTile[], x: number, y: number, r: number): boolean {
  const h = TILE_SIZE / 2
  return tiles.every((t) => {
    const dx = Math.max(0, Math.abs(x - t.x) - h)
    const dy = Math.max(0, Math.abs(y - t.y) - h)
    return dx * dx + dy * dy >= r * r
  })
}

/** King of the Hill pillars (config HILL_RIM_GAP): four on the hill's rim, then a few off it. */
function spawnHillObstacles(state: SimState, radii: readonly number[]): void {
  const hill = arenaTiles(hillStartLayer(state.settings))
  // rounds style alternates corners (even rounds) and tips; respawn style has one platform
  const d = Math.SQRT1_2
  const dirs = state.round % 2 === 0 ? [[d, d], [-d, d], [-d, -d], [d, -d]] : [[1, 0], [0, 1], [-1, 0], [0, -1]]
  for (const [ux, uy] of dirs) {
    const variant = randomInt(state, 0, radii.length - 1)
    const radius = radii[variant]
    let r = 0
    while (!clearOf(hill, ux * r, uy * r, radius + HILL_RIM_GAP)) r += 4
    state.obstacles.push({ id: state.nextEntityId++, x: ux * r, y: uy * r, radius, hp: OBSTACLE_HP, variant })
  }
  const extra = randomInt(state, HILL_EXTRA_PILLARS_MIN, HILL_EXTRA_PILLARS_MAX)
  for (let i = 0, tries = 0; i < extra && tries < 20; tries++) {
    const x = randomRange(state, -OBSTACLE_MAX_COORD, OBSTACLE_MAX_COORD)
    const y = randomRange(state, -OBSTACLE_MAX_COORD, OBSTACLE_MAX_COORD)
    const variant = randomInt(state, 0, radii.length - 1)
    const radius = radii[variant]
    if (!clearOf(hill, x, y, radius + HILL_EXTRA_CLEAR)) continue
    if (state.obstacles.some((o) => hypot(o.x - x, o.y - y) < o.radius + radius + HILL_EXTRA_CLEAR)) continue
    state.obstacles.push({ id: state.nextEntityId++, x, y, radius, hp: OBSTACLE_HP, variant })
    i++
  }
}

function spawnObstacles(state: SimState): void {
  state.obstacles = []
  if (!SPAWN_OBSTACLES) return
  const radii = OBSTACLE_RADII[state.arena.theme] ?? OBSTACLE_RADII[0]
  if (isHill(state)) return spawnHillObstacles(state, radii)
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
  state.phaseTicksLeft = shopLength(state)
  state.projectiles = []
  state.arena.nextShrinkTick = -1
  newPlatform(state)
  state.arena.layer = state.rankedFinal ? finalLayer(state) : ARENA_SHOP_LAYER
  for (const pawn of state.pawns) {
    if (isRoundParticipant(state, pawn.owner)) respawnPawn(state, pawn)
    else if (state.rankedFinal) {
      // Benching for the final is not a kill: no score, bounty or death event is earned.
      pawn.alive = false
      pawn.moveTarget = null
      pawn.cast = null
    }
  }
  // everyone readied while knocked out: the shop opens already cut, so its banner shows the real time
  readyCut(state)
  emitPhase(state)
}

/** Fight phase (Mode:onRoundStart / ModeDeathmatch:onRoundStart). */
export function startRound(state: SimState): void {
  const dm = isDeathmatch(state)
  const first = state.round === 0
  state.round += 1
  state.betting.bets = []
  delete state.shopReady
  delete state.shopCut
  state.phase = 'fight'
  assignTeams(state)
  const players = activePlayers(state).length
  if (players <= 2) state.betting.closeTick = state.tick + ticks(BET_TWO_STARTER_SECONDS)
  else delete state.betting.closeTick
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
  // respawn-style hill: one fight against the clock (rounds style keeps phaseTicksLeft -1)
  state.phaseTicksLeft = hillFight(state) ? ticks(HILL_TIME_LIMIT_SECONDS) : -1
  state.projectiles = []
  state.obstacles = state.obstacles.filter((o) => o.ticksLeft === undefined) // temp actors (Rockpillar)
  for (const sc of state.scores) sc.damageThisRound = 0
  // the fight platform exists before anyone spawns on it (spawn radius is capped to it; the
  // original respawned first, which made no difference there because it never capped)
  state.arena.layer = state.rankedFinal ? finalLayer(state) :
    clampLayer(ARENA_BASE_LAYER + ARENA_LAYER_PER_PLAYER * players)
  state.arena.nextShrinkTick = state.tick + ticks(shrinkPeriod(state))
  for (const pawn of state.pawns) {
    if (!isRoundParticipant(state, pawn.owner)) {
      pawn.alive = false
      continue
    }
    removeTemporaryModifiers(state, pawn)
    spawnInvulnerable(state, pawn)
  }
  if (isHill(state)) state.hill = newHill(state)
  emitPhase(state)
  // Nobody needs to die to trigger resolution when finalists left during the preparation shop.
  if (state.settings.rankedRounds) {
    const teams = aliveTeams(state)
    if (teams.length <= 1) roundWon(state, teams[0] ?? null)
  }
}

/** Teams with at least one living active pawn, ascending. */
export function aliveTeams(state: SimState): number[] {
  const teams = new Set<number>()
  for (const p of state.pawns) if (p.alive && isRoundParticipant(state, p.owner)) teams.add(teamOf(state, p.owner))
  return Array.from(teams).sort((a, b) => a - b)
}

/** ModeLTS:onKill / ModeDeathmatch:onKill. Called by killPawn after the death is recorded. */
export function onKill(state: SimState, victim: PawnState, killer: PlayerId | null): void {
  if (!isCombat(state)) return
  if (hillFight(state)) {
    victim.respawnTicks = ticks(HILL_RESPAWN_SECONDS)
    return
  }
  if (isDeathmatch(state)) {
    if (killer !== null) {
      const team = teamOf(state, killer)
      for (const id of activePlayers(state)) if (teamOf(state, id) === team) scoreOf(state, id)!.score += 1
    }
    victim.respawnTicks = ticks(DM_RESPAWN_SECONDS)
    return
  }
  // Shopping while out (deviation, PLAN §2): the round's gold is the same for everyone whatever
  // the outcome, so a warlock out until the round ends gets it now, to spend while waiting.
  const sc = scoreOf(state, victim.owner)
  if (sc && !sc.roundPaid) {
    sc.gold += state.settings.roundGold
    sc.roundPaid = true
  }
  const teams = aliveTeams(state)
  if (teams.length <= 1) roundWon(state, teams.length === 1 ? teams[0] : null)
}

/**
 * Mode:onRoundWon. Combat ends immediately: receiveDamage ignores later hits in the same tick,
 * so two lethal hits at once leave one survivor (whichever hit resolves second) and no draw.
 */
export function roundWon(state: SimState, team: number | null): void {
  state.phase = 'roundEnd'
  state.phaseTicksLeft = ticks(ROUND_END_SECONDS)
  if (team === null) {
    // A final with no eligible survivor is shared by the tied leaders; it never schedules another final.
    if (state.rankedFinal) state.rankedFinal.winners = state.rankedFinal.contenders.slice()
    settleSpectateBets(state, [])
    state.events.push({ type: 'roundWin', team: TEAM_DRAW, players: [] })
  } else {
    const players = activePlayers(state).filter((id) => teamOf(state, id) === team)
    if (state.rankedFinal) state.rankedFinal.winners = players.slice()
    settleSpectateBets(state, players)
    for (const id of players) {
      const sc = scoreOf(state, id)!
      // hill tickets stop at the target: a match is won at 100, never with 104
      if (!state.rankedFinal) sc.score = isHill(state) ? Math.min(Math.max(sc.score, state.settings.winScore), sc.score + HILL_ROUND_WIN_TICKETS) : sc.score + 1
      sc.gold += state.settings.winGold
    }
    state.events.push({ type: 'roundWin', team, players })
  }
  // King of the Hill ends the moment the target is reached, round-win tickets included
  const hillWinners = isHill(state) ? gameWinners(state) : null
  if (hillWinners) return finishMatch(state, hillWinners)
  emitPhase(state)
}

/**
 * Score win condition with the v1 fix (winners = every player with the max score >= winScore).
 * No-draw rule: in FFA and Shuffle a shared top score keeps the match going.
 */
export function gameWinners(state: SimState): PlayerId[] | null {
  if (state.rankedFinal) return state.rankedFinal.winners ?? null
  let top = -Infinity
  for (const sc of state.scores) if (sc.score > top) top = sc.score
  if (state.settings.rankedRounds) {
    const leaders = state.scores.filter((sc) => sc.score === top).map((sc) => sc.id)
    if (leaders.length !== 1) return null
    const remaining = Math.max(0, state.settings.rankedRounds - state.round)
    // A sole leader wins once nobody can catch their score in the scheduled rounds remaining.
    return state.scores.every((sc) => sc.id === leaders[0] || sc.score + remaining < top) ? leaders : null
  }
  if (top < state.settings.winScore) return null
  const winners = state.scores.filter((sc) => sc.score === top).map((sc) => sc.id)
  if (winners.length > 1 && state.settings.teamMode !== 'teams') return null
  return winners
}

function finishMatch(state: SimState, winners: PlayerId[]): void {
  state.phase = 'gameOver'
  state.phaseTicksLeft = -1
  state.arena.nextShrinkTick = -1
  if (state.hill) state.hill.nextShrinkTick = -1
  emitPhase(state)
  state.events.push({ type: 'gameOver', winners })
}

/** Respawn-style hill at its time limit: the ticket leaders, if they are one team with a ticket. */
function hillLeaders(state: SimState): PlayerId[] | null {
  const top = Math.max(0, ...state.scores.filter((sc) => isActive(state, sc.id)).map((sc) => sc.score))
  if (top <= 0) return null
  const leaders = state.scores.filter((sc) => sc.score === top && isActive(state, sc.id)).map((sc) => sc.id)
  return new Set(leaders.map((id) => teamOf(state, id))).size === 1 ? leaders : null
}

/** Mode:onRoundEnd. */
export function endRound(state: SimState): void {
  for (const sc of state.scores) {
    if (sc.roundPaid) delete sc.roundPaid // paid at the knockout (onKill)
    else sc.gold += state.settings.roundGold
  }
  const winners = gameWinners(state)
  if (winners) {
    finishMatch(state, winners)
    return
  }
  if (state.settings.rankedRounds && !state.rankedFinal && state.round >= state.settings.rankedRounds) {
    const top = Math.max(...state.scores.map((sc) => sc.score))
    state.rankedFinal = { contenders: state.scores.filter((sc) => sc.score === top).map((sc) => sc.id) }
  }
  if (isDeathmatch(state)) startRound(state)
  else prepareForRound(state)
}

/** Deathmatch / respawn-style hill timers (10 s / 5 s after death, 2 s invulnerability). */
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
    if (a.layer > arenaFloor(state)) {
      a.layer -= 1
      state.events.push({ type: 'arenaShrink', layer: a.layer })
    }
    a.nextShrinkTick += ticks(shrinkPeriod(state))
    // a respawn-style hill arena at its floor is done sinking (no warning, no bot lookahead)
    if (hillFight(state) && a.layer <= arenaFloor(state)) a.nextShrinkTick = -1
  }
  if (isHill(state) && state.phase === 'fight') {
    const fight = hillFight(state)
    if (fight) respawnTick(state)
    if (hillTick(state)) {
      const winners = gameWinners(state)
      if (winners) return finishMatch(state, winners)
    }
    if (fight) {
      if (state.phaseTicksLeft > 0) state.phaseTicksLeft -= 1
      const leaders = state.phaseTicksLeft <= 0 ? hillLeaders(state) : null
      if (leaders) finishMatch(state, leaders)
    }
    return
  }
  if (isDeathmatch(state) && state.phase === 'fight') {
    respawnTick(state)
    state.phaseTicksLeft -= 1
    if (state.phaseTicksLeft <= 0) endRound(state)
    return
  }
  if (state.phase === 'shop' || state.phase === 'roundEnd') {
    if (state.phase === 'shop') readyCut(state)
    if (state.phaseTicksLeft > 0) state.phaseTicksLeft -= 1
    if (state.phaseTicksLeft <= 0) {
      if (state.phase === 'shop') startRound(state)
      else endRound(state)
    }
  }
}
