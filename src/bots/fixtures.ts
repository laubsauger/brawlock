/**
 * Hand-built SimState fixtures for bot tests (independent of the sim implementation).
 * Slot layout follows the contract: 0..5 spell columns, 6.. items (Fireball 6, Scourge 7).
 */
import type { MatchSettings, PawnState, PlayerSlot, ProjectileState, SimState } from '../sim/types'

export const FIREBALL_SLOT = 6
export const SCOURGE_SLOT = 7
export const TELEPORT_SLOT = 1

export function makeSettings(): MatchSettings {
  return {
    teamMode: 'ffa',
    gameMode: 'rounds',
    winScore: 3,
    startGold: 30,
    roundGold: 10,
    killGold: 0,
    winGold: 0,
    lavaDps: 100,
    kbMultiplier: 1,
    dmgMultiplier: 1,
    friction: 0.96,
    shopSeconds: 30,
    botsReplaceLeavers: true,
  }
}

export function makePawn(owner: number, x: number, y: number, patch: Partial<PawnState> = {}): PawnState {
  // 12 slots like the sim: 6 spell columns, 6 items
  const slots: (string | null)[] = [null, null, null, null, null, null, 'fireball', 'scourge', null, null, null, null]
  return {
    id: 100 + owner,
    owner,
    x,
    y,
    vx: 0,
    vy: 0,
    walkVx: 0,
    walkVy: 0,
    facing: 0,
    hp: 1000,
    maxHp: 1000,
    hpRegen: 5,
    moveSpeed: 210,
    kbPoints: 0,
    kbFactor: 1,
    alive: true,
    invulnerable: false,
    moveTarget: null,
    cast: null,
    cooldowns: slots.map(() => 0),
    slots,
    levels: slots.map((s) => (s ? 1 : 0)),
    modifiers: [],
    lastHitter: null,
    lavaTicks: 0,
    ...patch,
  }
}

export function makeFireball(owner: number, x: number, y: number, vx: number, vy: number, id = 500): ProjectileState {
  return { id, owner, spell: 'fireball', x, y, vx, vy, radius: 25, ticksLeft: 60, data: {} }
}

export function makeState(pawns: PawnState[], patch: Partial<SimState> = {}): SimState {
  const slots: PlayerSlot[] = pawns.map((p) => ({
    id: p.owner,
    name: `P${p.owner}`,
    color: 0xffffff,
    team: p.owner,
    kind: 'bot',
    difficulty: 'hard',
  }))
  return {
    tick: 0,
    rng: 1,
    nextEntityId: 1000,
    settings: makeSettings(),
    slots,
    phase: 'fight',
    phaseTicksLeft: -1,
    round: 1,
    arena: { layer: 15, nextShrinkTick: -1, theme: 0 },
    scores: pawns.map((p) => ({
      id: p.owner,
      gold: 0,
      score: 0,
      kills: 0,
      deaths: 0,
      damageThisRound: 0,
      masteries: { duration: 0, range: 0, lifesteal: 0 },
      connected: true,
    })),
    pawns,
    projectiles: [],
    obstacles: [],
    events: [],
    ...patch,
  }
}
