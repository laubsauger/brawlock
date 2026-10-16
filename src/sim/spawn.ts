/**
 * Pawn creation, spawn layout and respawn (systems.md §5.2 respawn, §7.2 spawn positions).
 */
import {
  ARENA_BASE_LAYER,
  ARENA_LAYER_PER_PLAYER,
  ARENA_RADIUS_PER_LAYER,
  ARENA_SPAWN_INSET,
  FIREBALL_SLOT,
  PAWN_HEALTH_REG,
  PAWN_MAX_LIFE,
  PAWN_MOVE_SPEED,
  SCOURGE_SLOT,
  SLOT_COUNT,
  SPAWN_EDGE_MARGIN,
  SPAWN_MIN_RADIUS,
} from './config'
import { layerRadius } from './arena'
import { PI, cos, sin, wrapAngle } from './math'
import { removeAllModifiers } from './modifiers'
import { activePlayers, teamOf } from './teams'
import type { PawnState, PlayerId, SimState, Vec2 } from './types'

export function createPawn(state: SimState, owner: PlayerId): PawnState {
  const slots: (string | null)[] = new Array(SLOT_COUNT).fill(null)
  const levels: number[] = new Array(SLOT_COUNT).fill(0)
  slots[FIREBALL_SLOT] = 'fireball'
  levels[FIREBALL_SLOT] = 1
  slots[SCOURGE_SLOT] = 'scourge'
  levels[SCOURGE_SLOT] = 1
  return {
    id: state.nextEntityId++,
    owner,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    walkVx: 0,
    walkVy: 0,
    facing: 0,
    hp: PAWN_MAX_LIFE,
    maxHp: PAWN_MAX_LIFE,
    hpRegen: PAWN_HEALTH_REG,
    moveSpeed: PAWN_MOVE_SPEED,
    kbPoints: 0,
    kbFactor: 1,
    alive: false,
    invulnerable: false,
    moveTarget: null,
    cast: null,
    cooldowns: new Array(SLOT_COUNT).fill(0),
    slots,
    levels,
    modifiers: [],
    lastHitter: null,
    lavaTicks: 0,
  }
}

/**
 * Original Mode:getRespawnLocation with two v1 fixes (PLAN §2):
 *   angle  = 2pi / activeTeams * activeTeamIndex + 0.2 * (indexInTeam - (teamSize - 1) / 2)
 *   radius = (13 + players) * 100 - 600, players = ACTIVE players,
 *            capped to SPAWN_EDGE_MARGIN inside the current platform (floor SPAWN_MIN_RADIUS).
 * The cap only bites in the shop phase with 4+ players (layer-14 platform); fight spawns are the
 * original formula exactly.
 */
export function spawnPosition(state: SimState, player: PlayerId): Vec2 & { angle: number } {
  const ids = activePlayers(state)
  const teams = Array.from(new Set(ids.map((id) => teamOf(state, id)))).sort((a, b) => a - b)
  const team = teamOf(state, player)
  const teamIndex = Math.max(0, teams.indexOf(team))
  const members = ids.filter((id) => teamOf(state, id) === team)
  const indexInTeam = Math.max(0, members.indexOf(player))
  const teamCount = Math.max(1, teams.length)
  const angle = ((2 * PI) / teamCount) * teamIndex + 0.2 * (indexInTeam - (members.length - 1) / 2)
  const formula = (ARENA_BASE_LAYER + ARENA_LAYER_PER_PLAYER * ids.length) * ARENA_RADIUS_PER_LAYER - ARENA_SPAWN_INSET
  const radius = Math.max(SPAWN_MIN_RADIUS, Math.min(formula, layerRadius(state.arena.layer) - SPAWN_EDGE_MARGIN))
  return { x: radius * cos(angle), y: radius * sin(angle), angle }
}

/**
 * Pawn:respawn: zero velocity, spawn location, clear last hitter, full HP, DP 0,
 * every cooldown reset. Modifiers are cleared too (a dead pawn already lost its temporary ones;
 * permanent item modifiers will be re-applied by the item system when it exists).
 */
export function respawnPawn(state: SimState, pawn: PawnState): void {
  const sp = spawnPosition(state, pawn.owner)
  removeAllModifiers(state, pawn)
  pawn.x = sp.x
  pawn.y = sp.y
  pawn.vx = 0
  pawn.vy = 0
  pawn.walkVx = 0
  pawn.walkVy = 0
  pawn.facing = wrapAngle(sp.angle + PI) // face the arena centre
  pawn.hp = pawn.maxHp
  pawn.kbPoints = 0
  pawn.alive = true
  pawn.invulnerable = false
  pawn.moveTarget = null
  pawn.cast = null
  pawn.cooldowns.fill(0)
  pawn.lastHitter = null
  pawn.lavaTicks = 0
}
