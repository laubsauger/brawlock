/**
 * Simulation contract. Shared by sim, net, render, ui and bots.
 *
 * Rules (see docs/PLAN.md §Architecture):
 * - The sim is pure TypeScript. It never imports three, React, DOM or net code.
 * - The sim is deterministic: same initial state + same inputs per tick gives the
 *   same state. No Math.random (use the seeded rng in SimState), no Date/performance,
 *   no Math.sin/cos/atan2 in state-changing paths unless wrapped by sim/math.ts.
 * - SimState is plain data (no classes, no Maps/Sets, no functions) so it can be
 *   structured-cloned, sent over the network and diffed in tests.
 * - Units are original Warlock Brawl game units (pawn radius 30, arena wall 5910).
 *   Render converts with WORLD_SCALE.
 *
 * Extend freely. Do not rename or remove existing fields without updating every
 * consumer.
 */

/**
 * Fixed simulation rate. The original ticked every 0.035 s on a 30 Hz Dota server;
 * we run 60 Hz for lower input latency. Every per-tick constant from the original
 * (friction 0.96 per 0.035 s, ...) must be converted: perTick = orig ** (DT / ORIGINAL_TICK).
 */
export const TICK_HZ = 60
export const DT = 1 / TICK_HZ
export const ORIGINAL_TICK = 0.035

/** Render: game units to three.js world units (1 unit = 1 cm). */
export const WORLD_SCALE = 0.01

export type PlayerId = number
export type EntityId = number

export interface Vec2 {
  x: number
  y: number
}

// ---------------------------------------------------------------------------
// Match settings (lobby options). Defaults live in sim/config.ts.
// ---------------------------------------------------------------------------

export type TeamMode = 'ffa' | 'teams' | 'shuffle'
export type GameMode = 'rounds' | 'deathmatch'

export interface MatchSettings {
  teamMode: TeamMode
  gameMode: GameMode
  /** rounds mode: game ends when a player/team reaches this many round wins */
  winScore: number
  startGold: number
  roundGold: number
  killGold: number
  winGold: number
  lavaDps: number
  kbMultiplier: number
  dmgMultiplier: number
  /** velocity multiplier applied once per original 0.035 s tick */
  friction: number
  /** seconds of shop / warmup before each round */
  shopSeconds: number
  botsReplaceLeavers: boolean
}

// ---------------------------------------------------------------------------
// Players and inputs
// ---------------------------------------------------------------------------

export type BotDifficulty = 'dummy' | 'easy' | 'medium' | 'hard' | 'brutal'

export interface PlayerSlot {
  id: PlayerId
  name: string
  /** 0xRRGGBB */
  color: number
  team: number
  kind: 'human' | 'bot'
  difficulty?: BotDifficulty
}

/**
 * Spell / item identifiers. Matches the original internal names without the
 * `warlock_` / `item_warlock_` prefix (e.g. 'fireball', 'scourge', 'teleport').
 */
export type SpellId = string

/**
 * Hotbar slot index. 0..5 = spell columns (Q W E R D F in the original layout),
 * 6.. = item slots. The sim maps slot -> owned spell.
 */
export type SlotIndex = number

export type InputCommand =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'stop' }
  | { kind: 'cast'; slot: SlotIndex; x: number; y: number }
  | { kind: 'buySpell'; spell: SpellId }
  | { kind: 'buyItem'; item: SpellId }
  | { kind: 'buyMastery'; mastery: 'duration' | 'range' | 'lifesteal' | 'all' }

/** All commands one player issued for one tick. */
export interface PlayerInput {
  player: PlayerId
  /** sim tick the input was issued for (client estimate; host may apply later) */
  tick: number
  cmds: InputCommand[]
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type Phase = 'warmup' | 'shop' | 'fight' | 'roundEnd' | 'gameOver'

export interface CastState {
  slot: SlotIndex
  spell: SpellId
  /** ticks until the spell fires (cast point / windup) */
  ticksLeft: number
  x: number
  y: number
}

export interface ModifierState {
  id: string
  /** remaining ticks, -1 = permanent until removed */
  ticksLeft: number
  source: PlayerId | null
  /** free-form numeric payload per modifier kind */
  data: Record<string, number>
}

export interface PawnState {
  id: EntityId
  owner: PlayerId
  x: number
  y: number
  /** total velocity (physics + walk) */
  vx: number
  vy: number
  /** walk component of velocity, removed and re-added each tick (original model) */
  walkVx: number
  walkVy: number
  /** radians, 0 = +x */
  facing: number
  hp: number
  maxHp: number
  hpRegen: number
  moveSpeed: number
  /** knockback points: grow with damage taken, amplify knockback (original "mana") */
  kbPoints: number
  /** multiplier on knockback received (items lower it) */
  kbFactor: number
  alive: boolean
  invulnerable: boolean
  moveTarget: Vec2 | null
  cast: CastState | null
  /** remaining cooldown ticks per slot */
  cooldowns: number[]
  /** spell (or item) in each slot, null = empty */
  slots: (SpellId | null)[]
  /** level per slot, 0 = empty */
  levels: number[]
  modifiers: ModifierState[]
  lastHitter: PlayerId | null
  /** ticks since last left the arena (lava contact), for render glow */
  lavaTicks: number
}

export interface ProjectileState {
  id: EntityId
  owner: PlayerId
  spell: SpellId
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  ticksLeft: number
  /** spell specific payload (homing target, bounces left, ...) */
  data: Record<string, number>
}

export interface ObstacleState {
  id: EntityId
  x: number
  y: number
  radius: number
  hp: number
  /** visual variant index inside the current obstacle set */
  variant: number
}

export interface ArenaState {
  /** layer L: tile radius r = (L - 1) * 100 */
  layer: number
  /** tick of next shrink, -1 = not shrinking */
  nextShrinkTick: number
  /** obstacle / tile visual theme 0..2 */
  theme: number
}

export interface PlayerScore {
  id: PlayerId
  gold: number
  score: number
  kills: number
  deaths: number
  damageThisRound: number
  /** mastery levels */
  masteries: { duration: number; range: number; lifesteal: number }
  connected: boolean
}

/**
 * One-shot events emitted during a tick, for VFX / SFX / UI.
 * Cleared at the start of every tick. Render and audio must treat them as
 * fire-and-forget; clients may receive the same tick twice and must dedupe by
 * (tick, index).
 */
export type SimEvent =
  | { type: 'cast'; pawn: EntityId; spell: SpellId; x: number; y: number }
  | { type: 'castStart'; pawn: EntityId; spell: SpellId; ticks: number }
  | { type: 'projectileSpawn'; id: EntityId; spell: SpellId }
  | { type: 'projectileHit'; id: EntityId; spell: SpellId; x: number; y: number; target: EntityId | null }
  | { type: 'projectileExpire'; id: EntityId; spell: SpellId; x: number; y: number }
  | { type: 'damage'; target: EntityId; amount: number; source: PlayerId | null; x: number; y: number; kb: number }
  | { type: 'heal'; target: EntityId; amount: number; x: number; y: number }
  | { type: 'teleport'; pawn: EntityId; fromX: number; fromY: number; toX: number; toY: number }
  | { type: 'explosion'; x: number; y: number; radius: number; spell: SpellId }
  | { type: 'death'; pawn: EntityId; owner: PlayerId; killer: PlayerId | null }
  | { type: 'obstacleDestroyed'; id: EntityId; x: number; y: number }
  | { type: 'arenaShrink'; layer: number }
  | { type: 'phase'; phase: Phase; round: number }
  | { type: 'roundWin'; team: number; players: PlayerId[] }
  | { type: 'gameOver'; winners: PlayerId[] }

export interface SimState {
  tick: number
  /** mulberry32 state */
  rng: number
  nextEntityId: EntityId
  settings: MatchSettings
  slots: PlayerSlot[]
  phase: Phase
  /** ticks until the current phase ends, -1 = until condition */
  phaseTicksLeft: number
  round: number
  arena: ArenaState
  scores: PlayerScore[]
  pawns: PawnState[]
  projectiles: ProjectileState[]
  obstacles: ObstacleState[]
  events: SimEvent[]
}
