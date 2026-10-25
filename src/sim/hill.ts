/**
 * King of the Hill (not in the original). The hill is every tile of a small arena layer around
 * the centre (settings.hillLayer, shrinking one ring every HILL_SHRINK_PERIOD); it never reaches
 * past the arena itself. A team standing on it alone earns one ticket (score) per
 * HILL_TICKET_SECONDS for each member, plus HILL_TICKET_GOLD; any enemy team on it contests it
 * and nobody earns. First to winScore tickets wins, checked on every ticket.
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
import { isLocationSafeAtLayer } from './arena'
import {
  HILL_DEFAULT_LAYER,
  HILL_INCOME_SECONDS,
  HILL_MAX_LAYER,
  HILL_MIN_LAYER,
  HILL_SHRINK_PERIOD,
  HILL_TICKET_GOLD,
  HILL_TICKET_SECONDS,
  ticks,
} from './config'
import { activePlayers, isActive, isRoundParticipant, scoreOf, teamOf } from './teams'
import type { HillState, MatchSettings, SimState } from './types'

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

/** The hill's layer right now: its own, or the arena's once the arena has sunk inside it. */
export function hillLayerNow(state: Pick<SimState, 'hill' | 'arena'>): number {
  return state.hill ? Math.min(state.hill.layer, state.arena.layer) : 0
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
    nextIncomeTick: respawnsInFight(state.settings) ? state.tick + ticks(HILL_INCOME_SECONDS) : -1,
  }
}

/** One fight tick of the hill: shrink, income, who holds it, tickets. True iff a ticket was paid. */
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
    h.heldTicks = 0
  }
  if (team === null) return false
  h.heldTicks += 1
  if (h.heldTicks < ticks(HILL_TICKET_SECONDS)) return false
  h.heldTicks = 0
  const players = activePlayers(state).filter((id) => teamOf(state, id) === team)
  for (const id of players) {
    const sc = scoreOf(state, id)!
    sc.score += 1
    sc.gold += HILL_TICKET_GOLD
  }
  state.events.push({ type: 'hillTicket', team, players })
  return true
}
