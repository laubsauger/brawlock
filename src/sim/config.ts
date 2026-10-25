/**
 * Original constants (docs/research/systems.md §13, spells.md §1) and lobby defaults.
 * Seconds stay seconds here; convert with `ticks()` at the use site.
 */
import { DT, ORIGINAL_TICK, TICK_HZ, onTickRate } from './types'
import type { MatchSettings } from './types'
import { PI, exp, log } from './math'

// --- pawn ------------------------------------------------------------------
export const PAWN_MAX_LIFE = 1000
export const PAWN_MOVE_SPEED = 210
/** HP per second */
export const PAWN_HEALTH_REG = 5
/** knockback points per second (Dota hero StatusManaRegen -0.04) */
export const PAWN_DP_REGEN = -0.04
export const PAWN_MASS = 100
export const PAWN_RADIUS = 30
export const PAWN_ELASTICITY = 0.5
/** cap on the derived walk velocity (Pawn.WALK_SPEED) */
export const PAWN_WALK_SPEED_CAP = 1000
/** Dota MovementTurnRate: radians per 0.03 s */
export const PAWN_TURN_RATE = 1.2
export const DOTA_TURN_INTERVAL = 0.03
/** radians the pawn turns per sim tick (1.2 rad / 0.03 s = 40 rad/s) */
export let TURN_PER_TICK = 0
/**
 * The pawn only walks (and a cast point only starts) once facing is within this angle of the
 * desired direction. Dota's own tolerance is about 0.2 rad (~11.5 deg); the original inherited
 * it from the engine, so we use the same.
 */
export const FACING_TOLERANCE = 0.2
/**
 * A cast's turn phase never lasts longer than this: one tick more than a full 180 degree turn
 * needs (pi / TURN_PER_TICK, 5 ticks). Only reachable when the pawn keeps being pushed around the
 * target point; the pawn then snaps to face it and the cast point starts, so a cast can never
 * stall in its windup.
 */
export let CAST_TURN_LIMIT_TICKS = 0
onTickRate(() => {
  TURN_PER_TICK = (PAWN_TURN_RATE * DT) / DOTA_TURN_INTERVAL
  CAST_TURN_LIMIT_TICKS = Math.ceil(PI / TURN_PER_TICK) + 1
})
/** distance under which a move order counts as arrived */
export const ARRIVE_EPSILON = 1

export const KB_DMG_TO_VELOCITY = 10
export const SPAWN_INVULN_SECONDS = 2

// --- world / arena -----------------------------------------------------------
export const GAME_ARENA_RADIUS = 5910
export const ARENA_TILE_SIZE = 192
export const ARENA_MAX_COORD = 20
export const ARENA_MAX_LAYER = 21
export const ARENA_RADIUS_PER_LAYER = 100
export const ARENA_BASE_LAYER = 13
export const ARENA_LAYER_PER_PLAYER = 1
export const ARENA_SPAWN_INSET = 600
/**
 * v1 fix (PLAN §2): spawns stay at least this far inside the edge of the platform that exists
 * when they happen. The original formula is sized for the fight platform and put warlocks in
 * the lava of the layer-14 shop platform from 6 players up. Original fight spawns already sit
 * 300..500 inside their platform, so the cap never moves them.
 */
export const SPAWN_EDGE_MARGIN = 300
/** floor for the capped spawn ring so spawns never collapse onto each other */
export const SPAWN_MIN_RADIUS = 300
/** platform layer during the shop phase (13 + 1) */
export const ARENA_SHOP_LAYER = ARENA_BASE_LAYER + ARENA_LAYER_PER_PLAYER
export const SHRINK_PERIOD = 10
export const RANKED_SHRINK_PERIOD = 8
export const RANKED_FINAL_SHRINK_PERIOD = 6
export const RANKED_FINAL_SHOP_SECONDS = 15
export const LAVA_DAMAGE_PERIOD = 0.25
export const LAVA_KB_POINT_FACTOR = 0.5

// --- obstacles -----------------------------------------------------------------
export const OBSTACLE_MASS = 10000
export const OBSTACLE_HP = 400
export const OBSTACLE_ELASTICITY = 0.5
export const OBSTACLE_EXPLODE_RADIUS = 300
export const OBSTACLE_EXPLODE_DMG_MIN = 5
export const OBSTACLE_EXPLODE_DMG_GAIN = 5
export const OBSTACLE_MAX_COORD = 1000
export const OBSTACLE_COUNT_MIN = 2
export const OBSTACLE_COUNT_MAX = 8
/** collision radius per variant, per theme (ruins, rocks, debris) */
export const OBSTACLE_RADII: readonly (readonly number[])[] = [
  [60, 60, 60, 60, 60],
  [70, 45, 60, 40],
  [50, 50, 35, 35, 50],
]
/** Original: 2-8 random pillars in [-1000, 1000]^2, re-rolled every shop phase. */
export const SPAWN_OBSTACLES = true

// --- rounds / shop -------------------------------------------------------------
export const ROUND_END_SECONDS = 3
/** deathmatch: round length and respawn delay (ModeDeathmatch) */
export const DM_ROUND_SECONDS = 60
export const DM_RESPAWN_SECONDS = 10
/**
 * King of the Hill (not in the original; rules in sim/hill.ts). The hill is the tiles of a small
 * arena layer around the centre; standing on it with no enemy team on it earns one ticket
 * (score) per HILL_TICKET_SECONDS. First to winScore tickets wins.
 */
export const HILL_RESPAWN_SECONDS = 5
export const HILL_TICKET_SECONDS = 1
/** layer 6 = 21 tiles (a rounded 5x5); 5 = 13, 4 = the 3x3 block, 3 = a plus of 5. 13 tiles to start:
 * at 21 (playtest 2026-10-25) somebody always contested it and nobody earned tickets */
export const HILL_DEFAULT_LAYER = 5
export const HILL_MIN_LAYER = 3
export const HILL_MAX_LAYER = 8
export const HILL_DEFAULT_TICKETS = 100
/** the hill loses its outer ring this often, down to HILL_MIN_LAYER */
export const HILL_SHRINK_PERIOD = 90
/** the arena sinks this often, but keeps HILL_ARENA_MARGIN layers of ground around the hill */
export const HILL_ARENA_SHRINK_PERIOD = 15
/** 5 layers keep respawns (SPAWN_EDGE_MARGIN inside the platform) off the starting hill's tiles */
export const HILL_ARENA_MARGIN = 5
/** gold to each member of the holding team per ticket, and roundGold to everyone this often */
export const HILL_TICKET_GOLD = 1
export const HILL_INCOME_SECONDS = 30
/** after this long the ticket leader wins; a tie plays on until it breaks */
export const HILL_TIME_LIMIT_SECONDS = 12 * 60
/** rounds style: tickets for every member of the round's last team standing */
export const HILL_ROUND_WIN_TICKETS = 5
/**
 * When purchases are accepted (PLAN §11 decision, by the user):
 * - 'shopPhaseOrDead' (default): during the shop phase, or while the buyer's pawn is dead
 *   (spectating) in any phase except gameOver.
 * - 'anyPhase': faithful to the original, which never closed the shop server-side.
 */
export type ShopRule = 'shopPhaseOrDead' | 'anyPhase'
export const SHOP_RULE: ShopRule = 'shopPhaseOrDead'
export const SPELL_MAX_LEVEL = 7
export const MASTERY_MAX_LEVEL = 6
export const MASTERY_COST = 5
export const MASTERY_ALL_COST = 13
/** cumulative gain per level: duration, range, lifesteal (Shop.MASTERY_GAIN) */
export const MASTERY_GAIN = {
  duration: [0.1, 0.08, 0.07, 0.06, 0.05, 0.04],
  range: [0.12, 0.1, 0.09, 0.08, 0.07, 0.06],
  lifesteal: [0.09, 0.08, 0.07, 0.06, 0.05, 0.04],
} as const
export const MAX_ITEMS = 6

// --- slots -----------------------------------------------------------------------
/** 0..5 spell columns, 6..11 item slots */
export const SLOT_COUNT = 12
export const SPELL_COLUMNS = 6
export const ITEM_SLOT_START = 6
export const FIREBALL_SLOT = 6
export const SCOURGE_SLOT = 7

/** roundWin.team for a draw (nobody alive) */
export const TEAM_DRAW = -1

export const DEFAULT_SETTINGS: MatchSettings = {
  teamMode: 'ffa',
  gameMode: 'rounds',
  // PLAN §2: shorter default match (original 11) and a small kill / round-win bonus (original 0 / 0)
  winScore: 5,
  startGold: 30,
  roundGold: 10,
  killGold: 1,
  winGold: 2,
  lavaDps: 100,
  kbMultiplier: 1,
  dmgMultiplier: 1,
  friction: 0.96,
  shopSeconds: 25, // PLAN §2: original 30 felt long between rounds
  botsReplaceLeavers: true,
  spectatorBets: true,
  bounties: true,
  // King of the Hill only (listed so the lobby and its stored options accept them)
  hillLayer: HILL_DEFAULT_LAYER,
  hillRespawn: false,
}

/** Seconds to whole sim ticks (rounded to nearest). */
export function ticks(seconds: number): number {
  return Math.round(seconds * TICK_HZ)
}

/** Sim ticks to seconds: every tick count shown or played as time goes through here (stored
 * match records use net/leaderboard's recordSeconds). */
export function secondsOf(tickCount: number): number {
  return tickCount / TICK_HZ
}

/**
 * Original friction is applied once per 0.035 s tick. Per sim tick:
 * friction ** (DT / ORIGINAL_TICK), via the deterministic exp/log from math.ts (not Math.pow,
 * whose last bit is engine dependent). Exact per-second decay = friction ** (1 / 0.035).
 */
export function frictionPerTick(friction: number): number {
  if (friction <= 0) return 0
  if (friction === 1) return 1
  return exp(log(friction) * (DT / ORIGINAL_TICK))
}

/** Per-original-tick quantities (push-out) scaled to one sim tick. */
export let ORIGINAL_TICK_SCALE = 0
onTickRate(() => { ORIGINAL_TICK_SCALE = DT / ORIGINAL_TICK })
