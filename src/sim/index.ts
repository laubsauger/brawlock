/**
 * Public sim API. Everything outside src/sim imports from here (and types.ts).
 * Owned by the sim workstream; signatures are the contract.
 */
import { DT } from './types'
import type { InputCommand, MatchSettings, PlayerId, PlayerInput, PlayerSlot, ProjectileState, SimState } from './types'
import { ARENA_SHOP_LAYER, DEFAULT_SETTINGS, PAWN_DP_REGEN, frictionPerTick } from './config'
import { killPawn } from './combat'
import { lavaTick } from './lava'
import { prepareForRound, phaseTick } from './mode'
import { tickModifiers } from './modifiers'
import { applyCommand, cooldownTick, pawnPreTick } from './pawn'
import { physicsStep } from './physics'
import { createPawn, respawnPawn } from './spawn'
import { PROJECTILE_BEHAVIORS } from './spells'
import { isAlive, kindOf, timeScale } from './projectiles'
import { assignTeams, isActive, pawnOf, scoreOf } from './teams'

export * from './types'

// --- helpers for render / ui / bots / net ---------------------------------------
export {
  DEFAULT_SETTINGS,
  FIREBALL_SLOT,
  SCOURGE_SLOT,
  ITEM_SLOT_START,
  SLOT_COUNT,
  SPELL_COLUMNS,
  PAWN_RADIUS,
  PAWN_MAX_LIFE,
  PAWN_MOVE_SPEED,
  GAME_ARENA_RADIUS,
  ARENA_MAX_LAYER,
  SHRINK_PERIOD,
  SHOP_RULE,
  SPAWN_OBSTACLES,
  MASTERY_COST,
  MASTERY_ALL_COST,
  MASTERY_MAX_LEVEL,
  SPELL_MAX_LEVEL,
  TEAM_DRAW,
  frictionPerTick,
  ticks,
} from './config'
export {
  TILE_SIZE,
  CORNER_PX_PY,
  CORNER_NX_PY,
  CORNER_NX_NY,
  CORNER_PX_NY,
  arenaTiles,
  isLocationSafe,
  isLocationSafeAtLayer,
  isTileAt,
  layerRadius,
  tileCount,
  tileCoord,
  tileCornerMask,
} from './arena'
export type { ArenaTile } from './arena'
export { SPELLS, SPELL_IDS, PASSIVE_ITEMS, RELEASED_SPELLS, attr, cooldownSeconds, spellDef } from './spells/data'
export { IMPLEMENTED_SPELLS } from './spells'
export type { SpellDef, PassiveItemDef } from './spells/data'
export { cooldownTicks } from './pawn'
export { canBuy, shopOpen } from './shop'
export type { ShopRule } from './config'
export { knockbackSpeed } from './combat'
export { masteryFactor } from './stats'
export { alliance, isEnemy, pawnOf, scoreOf, slotOf, teamOf, ALLIANCE_SELF, ALLIANCE_ALLY, ALLIANCE_ENEMY } from './teams'
export { cloneState, hashState } from './snapshot'

/** Non-finite or negative numeric options fall back to the defaults (a NaN timer would stall). */
function sanitizeSettings(input: MatchSettings): MatchSettings {
  const out = { ...DEFAULT_SETTINGS, ...input }
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof MatchSettings)[]) {
    const d = DEFAULT_SETTINGS[key]
    if (typeof d !== 'number') continue
    const v = out[key]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) (out as Record<string, unknown>)[key] = d
  }
  return out
}

/** Build the initial state for a match. Deterministic in (settings, slots, seed). */
export function createMatch(inputSettings: MatchSettings, slots: PlayerSlot[], seed: number): SimState {
  const settings = sanitizeSettings(inputSettings)
  const sorted = slots.map((s) => ({ ...s })).sort((a, b) => a.id - b.id)
  const state: SimState = {
    tick: 0,
    rng: seed >>> 0,
    nextEntityId: 1,
    settings,
    slots: sorted,
    phase: 'shop',
    phaseTicksLeft: 0,
    round: 0,
    arena: { layer: ARENA_SHOP_LAYER, nextShrinkTick: -1, theme: 0 },
    scores: sorted.map((s) => ({
      id: s.id,
      gold: settings.startGold,
      score: 0,
      kills: 0,
      deaths: 0,
      damageThisRound: 0,
      masteries: { duration: 0, range: 0, lifesteal: 0 },
      connected: true,
    })),
    pawns: [],
    projectiles: [],
    obstacles: [],
    events: [],
  }
  for (const s of sorted) state.pawns.push(createPawn(state, s.id))
  assignTeams(state)
  prepareForRound(state)
  return state
}

/**
 * Mark a player as (dis)connected (session calls this between steps). The consequences are
 * applied inside the next step: with botsReplaceLeavers the player stays active (a bot drives
 * the pawn); otherwise the pawn dies without kill credit and the player sits out until they
 * reconnect (respawned at once if that happens during the shop phase).
 */
export function setPlayerConnected(state: SimState, player: PlayerId, connected: boolean): void {
  const sc = scoreOf(state, player)
  if (sc) sc.connected = connected
}

function finite(n: unknown): boolean {
  return typeof n === 'number' && Number.isFinite(n)
}

/** Remote input is untrusted: drop malformed commands instead of poisoning the state. */
function validCommand(cmd: InputCommand): boolean {
  if (!cmd || typeof cmd !== 'object') return false
  switch (cmd.kind) {
    case 'move':
      return finite(cmd.x) && finite(cmd.y)
    case 'cast':
      return finite(cmd.slot) && finite(cmd.x) && finite(cmd.y)
    case 'stop':
      return true
    case 'buySpell':
      return typeof cmd.spell === 'string'
    case 'buyItem':
      return typeof cmd.item === 'string'
    case 'buyMastery':
      return typeof cmd.mastery === 'string'
    default:
      return false
  }
}

function connectionTick(state: SimState): void {
  for (const pawn of state.pawns) {
    const active = isActive(state, pawn.owner)
    if (pawn.alive && !active) {
      pawn.lastHitter = null
      killPawn(state, pawn, null, 'disconnect')
    } else if (!pawn.alive && active && state.phase === 'shop') {
      // nobody can die in the shop phase, so a dead active pawn here just (re)joined
      respawnPawn(state, pawn)
    }
  }
}

function projectilePreTick(state: SimState): void {
  const n = state.projectiles.length
  for (let i = 0; i < n; i++) {
    const p = state.projectiles[i]
    if (!isAlive(p)) continue
    PROJECTILE_BEHAVIORS[kindOf(p)]?.onTick?.(state, p, DT * timeScale(p))
  }
}

/**
 * Projectile:onPostTick: lifetimes (actor timers, Warpzone-scaled) run out after movement;
 * destroyed projectiles get onDestroy (Splitter splits, Snowball explodes, Swap blinks) and are
 * removed. Projectiles spawned by onDestroy start next tick.
 */
function projectilePostTick(state: SimState): void {
  const n = state.projectiles.length
  const gone: { p: ProjectileState; expired: boolean }[] = []
  for (let i = 0; i < n; i++) {
    const p = state.projectiles[i]
    if (p.data.dead) {
      gone.push({ p, expired: false })
      continue
    }
    if (p.data.noTimer === 1) continue
    p.ticksLeft -= timeScale(p)
    if (p.ticksLeft <= 0) {
      p.data.dead = 1
      gone.push({ p, expired: true })
    }
  }
  if (gone.length === 0) return
  for (const { p, expired } of gone) {
    if (expired) state.events.push({ type: 'projectileExpire', id: p.id, spell: p.spell, x: p.x, y: p.y })
    PROJECTILE_BEHAVIORS[kindOf(p)]?.onDestroy?.(state, p, expired)
  }
  state.projectiles = state.projectiles.filter((p) => !p.data.dead)
}

/** Rockpillars crumble after their duration (GAME task, real time). */
function obstacleTick(state: SimState): void {
  let removed = false
  for (const o of state.obstacles) {
    if (o.ticksLeft === undefined) continue
    o.ticksLeft -= 1
    if (o.ticksLeft <= 0) {
      o.hp = 0
      removed = true
    }
  }
  if (removed) state.obstacles = state.obstacles.filter((o) => o.hp > 0)
}

function regenTick(state: SimState): void {
  for (const pawn of state.pawns) {
    if (!pawn.alive) continue
    const hp = pawn.hp + pawn.hpRegen * DT
    pawn.hp = hp < pawn.maxHp ? hp : pawn.maxHp
    const dp = pawn.kbPoints + PAWN_DP_REGEN * DT
    pawn.kbPoints = dp > 0 ? dp : 0
  }
}

/**
 * Advance exactly one tick (DT seconds). Mutates `state` in place.
 * `inputs` = every input to apply this tick, any order; the sim sorts by player id.
 * Clears `state.events` first, then fills it with this tick's events.
 */
export function step(state: SimState, inputs: PlayerInput[]): void {
  state.events = []
  if (state.phase !== 'gameOver') {
    // by player, then by the client's tick stamp; stable for equal keys
    const sorted = inputs.slice().sort((a, b) => a.player - b.player || a.tick - b.tick)
    for (const input of sorted) {
      const pawn = pawnOf(state, input.player)
      if (!pawn || !Array.isArray(input.cmds)) continue
      for (const cmd of input.cmds) if (validCommand(cmd)) applyCommand(state, input.player, pawn, cmd)
    }
  }
  connectionTick(state)
  const friction = frictionPerTick(state.settings.friction)
  for (const pawn of state.pawns) pawnPreTick(state, pawn, friction)
  projectilePreTick(state)
  physicsStep(state)
  projectilePostTick(state)
  obstacleTick(state)
  tickModifiers(state)
  lavaTick(state)
  if (state.phase !== 'gameOver') phaseTick(state)
  regenTick(state)
  cooldownTick(state)
  state.tick += 1
}
