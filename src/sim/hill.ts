/**
 * King of the Hill (not in the original). The hill is every tile of a small arena layer around
 * the centre (settings.hillLayer, shrinking one ring every HILL_SHRINK_PERIOD); it never reaches
 * past the arena itself. A team standing on it alone earns one ticket (score) per
 * HILL_TICKET_SECONDS for each member, the first HILL_CAPTURE_SECONDS after taking it; any enemy
 * team on it contests it and nobody earns tickets; the holder's progress pauses until it stands
 * alone again (a different team starts its own capture).
 * Every fight opens with the hill sealed by a force field for HILL_SEAL_SECONDS (hillField): no
 * walking, teleporting or being knocked onto it, so nobody takes it with an opening Teleport.
 * First to winScore tickets wins, checked on every ticket. Gold is personal and pays while
 * contested too: every HILL_GOLD_SECONDS of an unbroken stay on the hill pays HILL_GOLD_FIRST,
 * one more every HILL_GOLD_STEP grants up to HILL_GOLD_MAX; stepping off or dying starts over.
 *
 * Two styles (settings.hillRespawn):
 * - rounds (default): the rounds-mode flow (shop between rounds, no respawns, the arena sinks to
 *   nothing). The last team standing ends the round and earns HILL_ROUND_WIN_TICKETS; tickets
 *   carry over between rounds.
 * - respawn: one shop, then one fight with the shop open throughout (sim/shop.ts). The dead
 *   respawn after HILL_RESPAWN_SECONDS, the arena stops sinking HILL_ARENA_MARGIN layers outside
 *   the starting hill, everyone gets roundGold every HILL_INCOME_SECONDS, and after
 *   HILL_TIME_LIMIT_SECONDS the leader wins.
 *
 * Pure helpers here are shared with render, bots and the HUD.
 */
import { TILE_SIZE, isLocationSafeAtLayer, isTileAt, tileCoord } from './arena'
import {
  HILL_CAPTURE_SECONDS,
  HILL_DEFAULT_LAYER,
  HILL_GOLD_FIRST,
  HILL_GOLD_MAX,
  HILL_GOLD_SECONDS,
  HILL_GOLD_STEP,
  HILL_INCOME_SECONDS,
  HILL_MAX_LAYER,
  HILL_MIN_LAYER,
  HILL_SEAL_SECONDS,
  HILL_SHRINK_PERIOD,
  HILL_TICKET_SECONDS,
  OBSTACLE_ELASTICITY,
  PAWN_ELASTICITY,
  PAWN_RADIUS,
  ticks,
} from './config'
import { activePlayers, isActive, isRoundParticipant, scoreOf, teamOf } from './teams'
import type { EntityId, HillState, HillStay, MatchSettings, PlayerId, SimState } from './types'

/** The hill's starting layer for these settings (whole layers, HILL_MIN_LAYER..HILL_MAX_LAYER). */
export function hillStartLayer(settings: Pick<MatchSettings, 'hillLayer'>): number {
  const v = settings.hillLayer
  if (typeof v !== 'number' || !Number.isFinite(v)) return HILL_DEFAULT_LAYER
  return Math.min(HILL_MAX_LAYER, Math.max(HILL_MIN_LAYER, Math.round(v)))
}

/** Respawns during the fight (deathmatch, or the hill's respawn style); late joiners enter mid-fight. */
export function respawnsInFight(settings: Pick<MatchSettings, 'gameMode' | 'hillRespawn'>): boolean {
  return settings.gameMode === 'deathmatch' || (settings.gameMode === 'hill' && settings.hillRespawn === true)
}

/**
 * The hill's layer on an arena of `arenaLayer`: its own, but two rings inside the arena, so a
 * small late arena still has ground off the hill (playtest 2026-10-25: one ring was too little).
 * 13 arena tiles left: the hill is the plus of 5; from 9 tiles down only the centre tile.
 */
export function hillLayerOn(hillLayer: number, arenaLayer: number): number {
  return Math.min(hillLayer, Math.max(2, arenaLayer - 2))
}

/** The hill's layer right now (hillLayerOn the current arena), 0 outside King of the Hill. */
export function hillLayerNow(state: Pick<SimState, 'hill' | 'arena'>): number {
  return state.hill ? hillLayerOn(state.hill.layer, state.arena.layer) : 0
}

/** True iff (x, y) stands on a hill tile. */
export function onHill(state: Pick<SimState, 'hill' | 'arena'>, x: number, y: number): boolean {
  const layer = hillLayerNow(state)
  return layer > 1 && isLocationSafeAtLayer(layer, x, y)
}

export function newHill(state: SimState): HillState {
  return {
    layer: hillStartLayer(state.settings),
    nextShrinkTick: state.tick + ticks(HILL_SHRINK_PERIOD),
    team: null,
    contested: false,
    heldTicks: 0,
    holder: null,
    nextIncomeTick: respawnsInFight(state.settings) ? state.tick + ticks(HILL_INCOME_SECONDS) : -1,
    openTick: state.tick + ticks(HILL_SEAL_SECONDS),
    stays: [],
  }
}

/** True while the hill's force field is up: the first HILL_SEAL_SECONDS of every fight. */
export function hillSealed(state: Pick<SimState, 'hill' | 'phase' | 'tick'>): boolean {
  const open = state.hill?.openTick
  return open !== undefined && state.phase === 'fight' && state.tick < open
}

const HALF_TILE = TILE_SIZE / 2

/**
 * The point of a hill of `layer` nearest to (x, y) and its distance (0 on the hill; whole square
 * cells, as onHill counts them). Only the 3x3 cells around (x, y) are checked: any other cell is
 * at least TILE_SIZE / 2 away, far more than a pawn's radius. Infinity when none of them is hill.
 */
function nearestHillPoint(layer: number, x: number, y: number): { d: number; x: number; y: number } {
  const gx = tileCoord(x)
  const gy = tileCoord(y)
  let best = { d: Infinity, x, y }
  for (let j = gy - 1; j <= gy + 1; j++) {
    for (let i = gx - 1; i <= gx + 1; i++) {
      if (!isTileAt(layer, i, j)) continue
      const qx = Math.min(Math.max(x, i * TILE_SIZE - HALF_TILE), i * TILE_SIZE + HALF_TILE)
      const qy = Math.min(Math.max(y, j * TILE_SIZE - HALF_TILE), j * TILE_SIZE + HALF_TILE)
      const d = Math.sqrt((x - qx) * (x - qx) + (y - qy) * (y - qy))
      if (d < best.d) best = { d, x: qx, y: qy }
    }
  }
  return best
}

/** a pawn's body at (x, y) would touch the hill */
const touchesHill = (layer: number, x: number, y: number) => nearestHillPoint(layer, x, y).d < PAWN_RADIUS

/** knockback bounces off the field as off a pillar */
const FIELD_BOUNCE = 0.5 * (PAWN_ELASTICITY + OBSTACLE_ELASTICITY)

/**
 * The sealed hill's force field, once everything moved this tick (`from`: where each pawn stood
 * when it began). A pawn whose body would touch a hill tile stops where its path met the field
 * and slides along it for the rest of its move, so a Teleport or Swap onto the hill ends at its
 * edge (and its event says so). Walking into the field stops; knockback bounces off it.
 */
export function hillField(state: SimState, from: ReadonlyMap<EntityId, { x: number; y: number }>): void {
  const layer = hillLayerNow(state)
  if (layer <= 1) return
  for (const p of state.pawns) {
    if (!p.alive || !touchesHill(layer, p.x, p.y)) continue
    const start = from.get(p.id)
    let x: number
    let y: number
    let nx: number
    let ny: number
    if (start && !touchesHill(layer, start.x, start.y)) {
      // the last point of its path clear of the field
      let lo = 0
      let hi = 1
      for (let i = 0; i < 12; i++) {
        const t = (lo + hi) / 2
        if (touchesHill(layer, start.x + (p.x - start.x) * t, start.y + (p.y - start.y) * t)) hi = t
        else lo = t
      }
      x = start.x + (p.x - start.x) * lo
      y = start.y + (p.y - start.y) * lo
      const q = nearestHillPoint(layer, x, y)
      nx = (x - q.x) / q.d
      ny = (y - q.y) / q.d
      // the rest of the move, without the part into the field
      let rx = p.x - x
      let ry = p.y - y
      const rn = rx * nx + ry * ny
      rx -= rn * nx
      ry -= rn * ny
      if (!touchesHill(layer, x + rx, y + ry)) {
        x += rx
        y += ry
      }
    } else {
      // on it without a move this tick to undo: straight out from the hill's centre
      const d = Math.sqrt(p.x * p.x + p.y * p.y)
      nx = d > 0 ? p.x / d : 1
      ny = d > 0 ? p.y / d : 0
      let r = d
      while (touchesHill(layer, nx * r, ny * r)) r += 8
      x = nx * r
      y = ny * r
    }
    p.x = x
    p.y = y
    const kx = p.vx - p.walkVx
    const ky = p.vy - p.walkVy
    const kn = kx * nx + ky * ny
    const wn = p.walkVx * nx + p.walkVy * ny
    if (wn < 0) {
      p.walkVx -= wn * nx
      p.walkVy -= wn * ny
    }
    const bounce = kn < 0 ? (1 + FIELD_BOUNCE) * kn : 0
    p.vx = kx - bounce * nx + p.walkVx
    p.vy = ky - bounce * ny + p.walkVy
    for (const e of state.events) {
      if ((e.type === 'teleport' || e.type === 'swap') && e.pawn === p.id) {
        e.toX = x
        e.toY = y
      }
    }
  }
}

/** The player's current stay on the hill (toward their next gold grant), if they stand on it. */
export function hillStayOf(state: Pick<SimState, 'hill'>, player: PlayerId): HillStay | undefined {
  return state.hill?.stays.find((st) => st.player === player)
}

/** Personal hill gold: every player on the hill counts toward a grant; off the hill starts over. */
function hillGold(state: SimState, h: HillState): void {
  const prev = h.stays
  const stays: HillStay[] = []
  for (const p of state.pawns) {
    if (!p.alive || !isRoundParticipant(state, p.owner) || !onHill(state, p.x, p.y)) continue
    const st = prev.find((x) => x.player === p.owner) ?? { player: p.owner, ticks: 0, paid: 0, next: HILL_GOLD_FIRST }
    st.ticks += 1
    if (st.ticks >= ticks(HILL_GOLD_SECONDS)) {
      st.ticks = 0
      scoreOf(state, p.owner)!.gold += st.next
      state.events.push({ type: 'hillGold', player: p.owner, pawn: p.id, gold: st.next })
      st.paid += 1
      st.next = Math.min(HILL_GOLD_MAX, HILL_GOLD_FIRST + Math.floor(st.paid / HILL_GOLD_STEP))
    }
    stays.push(st)
  }
  h.stays = stays
}

/** One fight tick of the hill: shrink, income, gold for standing on it, who holds it, tickets. True iff a ticket was paid. */
export function hillTick(state: SimState): boolean {
  const h = state.hill
  if (!h) return false
  if (h.nextShrinkTick >= 0 && state.tick >= h.nextShrinkTick) {
    if (h.layer > HILL_MIN_LAYER) {
      h.layer -= 1
      state.events.push({ type: 'hillShrink', layer: h.layer })
    }
    h.nextShrinkTick = h.layer > HILL_MIN_LAYER ? h.nextShrinkTick + ticks(HILL_SHRINK_PERIOD) : -1
  }
  if (h.nextIncomeTick >= 0 && state.tick >= h.nextIncomeTick) {
    for (const sc of state.scores) if (isActive(state, sc.id)) sc.gold += state.settings.roundGold
    h.nextIncomeTick += ticks(HILL_INCOME_SECONDS)
  }
  hillGold(state, h)
  let team: number | null = null
  let contested = false
  for (const p of state.pawns) {
    if (!p.alive || !isRoundParticipant(state, p.owner) || !onHill(state, p.x, p.y)) continue
    const t = teamOf(state, p.owner)
    if (team === null) team = t
    else if (t !== team) contested = true
  }
  if (contested) team = null
  if (team !== h.team || contested !== h.contested) {
    state.events.push({ type: 'hill', team, contested, prev: h.team })
    h.team = team
    h.contested = contested
    // only a new holder captures; the last one resumes where a contest paused it (playtest
    // 2026-10-25 follow-up: one tick of an enemy brushing the hill restarted the capture, so a
    // busy 10-player hill paid almost no tickets and bot-only matches ran past 90 minutes)
    if (team !== null && team !== h.holder) {
      h.holder = team
      h.heldTicks = ticks(HILL_TICKET_SECONDS) - ticks(HILL_CAPTURE_SECONDS)
    }
  }
  if (team === null) return false
  h.heldTicks += 1
  if (h.heldTicks < ticks(HILL_TICKET_SECONDS)) return false
  h.heldTicks = 0
  const players = activePlayers(state).filter((id) => teamOf(state, id) === team)
  for (const id of players) {
    const sc = scoreOf(state, id)!
    sc.score += 1
  }
  state.events.push({ type: 'hillTicket', team, players })
  return true
}
