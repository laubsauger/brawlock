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
export const TICK_HZ = 30
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
  /** Dedicated ranked format: five scheduled scoring rounds, then at most one leaders-only final. */
  rankedRounds?: 0 | 5
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
  spectatorBets: boolean
  bounties: boolean
}

// ---------------------------------------------------------------------------
// Players and inputs
// ---------------------------------------------------------------------------

export type BotDifficulty = 'dummy' | 'easy' | 'medium' | 'hard' | 'brutal' | 'uber'

export interface PlayerSlot {
  /** Authority-verified ownership; presentation only, never affects simulation. */
  cosmetics?: import('../game/progressionCatalog').CosmeticEquipment
  id: PlayerId
  name: string
  /** 0xRRGGBB */
  color: number
  team: number
  kind: 'human' | 'bot'
  difficulty?: BotDifficulty
  /**
   * Stable per-browser player id (game/profile.ts) or 'bot:<difficulty>', so peers
   * and local stats recognize players across matches. Also binds betting escrow and bounties
   * to an occupant when a match seat changes hands.
   */
  profileId?: string
  /**
   * Round (state.round) in which a human took this seat over from a bot, set by the host on
   * the seat patch in non-ranked rooms. Opens the Fresh start refund (shop.ts) for that round's
   * shop only.
   */
  takeover?: number
  /** Joined a server room without signing in. Presentation only (a small mark next to the name). */
  guest?: true
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
  | { kind: 'spectateBet'; round: number; target: PlayerId }
  /** sell the seat's whole build back to the starting kit (shop.ts freshStart) */
  | { kind: 'freshStart' }

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
  /**
   * false while the pawn is still turning to face the target (cast point not running yet),
   * true once the cast point countdown runs (a 'castStart' event was emitted).
   */
  started?: boolean
  /** ticks spent turning toward the target so far (bounded, see CAST_TURN_LIMIT_TICKS) */
  turnTicks?: number
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
  /** deathmatch: ticks until this dead pawn respawns (absent / 0 = not scheduled) */
  respawnTicks?: number
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
  /**
   * spell specific payload. Common keys: timeScale (absent = 1, Warpzone slow),
   * noTimer (1 = no lifetime, ticksLeft is meaningless), origOwner (caster before a Shield
   * stole it). Per-kind keys are listed in sim/projectiles.ts.
   */
  data: Record<string, number>
  /**
   * behavior / visual kind when a spell has several projectile types (e.g. 'drainHeal',
   * 'splitterSpawner', 'splitterChild', 'rechargeRefresh', 'warpzone'). Absent = `spell`.
   */
  kind?: string
  /** level of the spell that created it (child projectiles inherit), for level-scaled visuals */
  level?: number
}

export interface ObstacleState {
  id: EntityId
  x: number
  y: number
  radius: number
  hp: number
  /** visual variant index inside the current obstacle set; -1 = Rockpillar */
  variant: number
  /** Rockpillar: ticks until it crumbles (absent = permanent arena pillar) */
  ticksLeft?: number
  /** Rockpillar: player who raised it (visual only; pillars are neutral to everyone) */
  owner?: PlayerId
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
  /** gold paid in the shop since the build last reset (Fresh start refunds it; bets excluded) */
  spent: number
  /** mastery levels */
  masteries: { duration: number; range: number; lifesteal: number }
  connected: boolean
}

/** Economic ownership survives display-name changes, never a different occupant of a seat. */
export interface BetIdentity {
  player: PlayerId
  kind: PlayerSlot['kind']
  name: string
  profileId?: string
}

export interface SpectatorBet {
  round: number
  player: PlayerId
  target: PlayerId
  payer: BetIdentity
  pick: BetIdentity
}

export interface PlayerBounty {
  holder: BetIdentity
  amount: number
  activeFromRound: number
}

export interface BettingCredit {
  holder: BetIdentity
  amount: number
}

export interface BetSettlement {
  round: number
  winners: PlayerId[]
  payouts: { player: PlayerId; amount: number; correct: boolean }[]
  bountyAdded: number
}

export interface BettingState {
  bets: SpectatorBet[]
  bounties: PlayerBounty[]
  /** A replaced seat cannot collect its previous occupant's refund or winnings. */
  credits: BettingCredit[]
  lastSettlement: BetSettlement | null
  /** a round that started with two warlocks: bets close at this tick (absent: when two remain) */
  closeTick?: number
}

/**
 * One-shot events emitted during a tick, for VFX / SFX / UI.
 * Cleared at the start of every tick. Render and audio must treat them as
 * fire-and-forget; clients may receive the same tick twice and must dedupe by
 * (tick, index).
 */
export type SimEvent =
  | { type: 'cast'; pawn: EntityId; spell: SpellId; x: number; y: number; level?: number }
  | { type: 'castStart'; pawn: EntityId; spell: SpellId; ticks: number; level?: number }
  | { type: 'projectileSpawn'; id: EntityId; spell: SpellId }
  | { type: 'projectileHit'; id: EntityId; spell: SpellId; x: number; y: number; target: EntityId | null }
  | { type: 'projectileExpire'; id: EntityId; spell: SpellId; x: number; y: number }
  | {
      type: 'damage'
      target: EntityId
      amount: number
      source: PlayerId | null
      x: number
      y: number
      kb: number
      /** damage soaked by Rush (already subtracted from amount) */
      absorbed?: number
      /** what dealt it: spell id, 'lava', 'obstacle' (always set by the sim) */
      cause?: string
    }
  | { type: 'heal'; target: EntityId; amount: number; x: number; y: number }
  | { type: 'teleport'; pawn: EntityId; fromX: number; fromY: number; toX: number; toY: number }
  /** level is set when a caster's spell exploded (absent for pillar explosions) */
  | { type: 'explosion'; x: number; y: number; radius: number; spell: SpellId; level?: number }
  | {
      type: 'death'
      pawn: EntityId
      owner: PlayerId
      killer: PlayerId | null
      /** Exact bounty transferred by this knockout; absent when none was collected. */
      bountyGold?: number
      /**
       * what dealt the lethal instance: a spell id ('fireball', 'splitter', 'meteor', ...), 'lava',
       * 'obstacle' (pillar explosion) or 'disconnect' (leaver removed). Always set by the sim;
       * optional only so hand-made mock events stay valid.
       */
      cause?: string
      /** knockback speed of the lethal hit (0 for lava / DoT / disconnect) */
      kb?: number
      /** where the pawn died */
      x?: number
      y?: number
    }
  /** by = the player whose hit broke it (null: no player, e.g. an explosion chain) */
  | { type: 'obstacleDestroyed'; id: EntityId; x: number; y: number; by?: PlayerId | null }
  | { type: 'arenaShrink'; layer: number }
  | { type: 'phase'; phase: Phase; round: number }
  | { type: 'roundWin'; team: number; players: PlayerId[] }
  | { type: 'gameOver'; winners: PlayerId[] }
  /** hitscan beam (Lightning): from the caster to where it stopped */
  | {
      type: 'beam'
      spell: SpellId
      owner: PlayerId
      fromX: number
      fromY: number
      toX: number
      toY: number
      /** entity it stopped on (pawn, projectile, obstacle), null = full range */
      target: EntityId | null
      /** true when an enemy Shield / Alteration bubble stopped it */
      blocked: boolean
      level?: number
    }
  /** a Shield bubble touched an enemy projectile */
  | { type: 'shieldReflect'; pawn: EntityId; projectile: EntityId; x: number; y: number; reflected: boolean; stolen: boolean }
  /**
   * position exchange (Swap, Alteration): `pawn` moved from (fromX, fromY) to (toX, toY);
   * `other` (pawn, obstacle or projectile entity) moved the opposite way. other null = plain blink.
   */
  | { type: 'swap'; spell: SpellId; pawn: EntityId; other: EntityId | null; fromX: number; fromY: number; toX: number; toY: number }
  /** a modifier (buff / debuff / spell state) was added or removed; see ModifierState ids */
  | { type: 'modifier'; pawn: EntityId; id: string; on: boolean; source: PlayerId | null }
  /** melee spell contact (Thrust, Windwalk charge) */
  | { type: 'spellHit'; spell: SpellId; pawn: EntityId; target: EntityId; x: number; y: number; level?: number }
  /** projectile bounced (Boomerang, Bouncer retarget, reflect off a pillar) */
  | { type: 'projectileBounce'; id: EntityId; spell: SpellId; x: number; y: number }
  /** a cooldown was reset early (Recharge refresh orb) */
  | { type: 'cooldownReset'; pawn: EntityId; slot: SlotIndex; spell: SpellId }
  /** streak counter changed (Recharge consecutive hits) */
  | { type: 'streak'; pawn: EntityId; spell: SpellId; value: number }
  /**
   * a pending cast was cancelled before it fired (stop, move, another cast, death, Grip, a
   * Teleport/Swap/Thrust Stop()); no cooldown was spent. started = the cast point was running.
   */
  | { type: 'castCancel'; pawn: EntityId; spell: SpellId; slot: SlotIndex; started: boolean }
  /**
   * a successful buy or upgrade (never emitted for a rejected one). level = the level after the
   * purchase. Buying all masteries at once emits one event per mastery raised.
   */
  | { type: 'purchase'; player: PlayerId; pawn: EntityId; kind: 'spell' | 'item' | 'mastery'; id: string; level: number }
  /** Fresh start: the seat's build was sold back to the starting kit for `refund` gold */
  | { type: 'freshStart'; player: PlayerId; pawn: EntityId; refund: number }
  /** deathmatch respawn */
  | { type: 'respawn'; pawn: EntityId; owner: PlayerId; x: number; y: number }

export interface SimState {
  betting: BettingState
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
  /** Present from final preparation onward. Winners persist after the final resolves, including shared draws. */
  rankedFinal?: { contenders: PlayerId[]; winners?: PlayerId[] }
  arena: ArenaState
  scores: PlayerScore[]
  pawns: PawnState[]
  projectiles: ProjectileState[]
  obstacles: ObstacleState[]
  events: SimEvent[]
}
