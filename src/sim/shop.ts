/**
 * Shop (systems.md §2). Purchases fail silently (original: no reply) when gold, slot or level
 * limits forbid them. Gold lives in PlayerScore.gold.
 *
 * - buySpell(spell): column spell. Empty column -> buy at level 1 for `cost`.
 *   Same spell already in its column -> upgrade one level for upgradeCosts[level - 1]
 *   (the original addressed upgrades by column; sending buySpell again is our upgrade order).
 *   Column taken by another spell -> rejected (one spell per column, no selling).
 * - buyItem(item): owned item -> upgrade for `cost` per level, and the item's cooldown resets
 *   (the original swaps in a fresh item entity). New item -> first free item slot.
 * - buyMastery(kind): 5 gold per level (max 6); 'all' raises all three for 13, only while none
 *   is maxed.
 * Passive items (Ring of Health, Cursed Ring, Cape, Armor, Boots, Pocket Watch) take an item
 * slot; their stats apply at once (max HP rises, current HP does not, systems.md §3.1).
 * Only ids in RELEASED_SPELLS (sim + tests + VFX shipped) can be bought.
 *
 * Fresh start (deviation, PLAN §2; the original has no selling): outside ranked, a player may sell
 * the whole build back to the starting kit before the next fight starts (shop phase or round
 * end), or in respawn modes while waiting to respawn. It returns the gold paid on the build
 * (PlayerScore.spent) less FRESH_START_PENALTY; a human who took over a bot's seat
 * (PlayerSlot.takeover, set by the host) gets all of it back in that round's shop. Spectator bets
 * are not shop spending and are never refunded.
 *
 * Shop Ready (deviation, PLAN §2; the original shop always ran its full time): when every counted
 * human is ready, the shop ends SHOP_READY_SECONDS later, never before SHOP_READY_MIN_SECONDS
 * after it opened. Only connected humans taking part in the coming fight count; bots, bot-driven
 * leavers, the disconnected and benched finalists are always ready. Ready can be pressed in the
 * shop or, where a knockout lasts until round end, while out, so a player who bought while out
 * does not wait for the shop (docs/moonshot/specs/shop-ready.md).
 */
import { respawnsInFight } from './hill'
import {
  FRESH_START_PENALTY, ITEM_SLOT_START, MASTERY_ALL_COST, MASTERY_COST, MASTERY_MAX_LEVEL, RANKED_FINAL_SHOP_SECONDS,
  SHOP_READY_MIN_SECONDS, SHOP_READY_SECONDS, SHOP_RULE, SLOT_COUNT, SPELL_MAX_LEVEL, ticks,
} from './config'
import { PASSIVE_ITEMS, RELEASED_SPELLS, SPELLS } from './spells/data'
import { cancelCast } from './orders'
import { giveStartingKit } from './spawn'
import { recomputeStats } from './stats'
import { isRoundParticipant, pawnOf, scoreOf, slotOf } from './teams'
import type { PawnState, PlayerId, PlayerScore, SimState, SpellId } from './types'

/**
 * Whether the shop is open for everyone right now (shop phase; any phase under 'anyPhase').
 * A dead player may still buy outside it: use canBuy(state, player) for one player.
 */
export function shopOpen(state: SimState): boolean {
  if (state.phase === 'gameOver') return false
  // a respawn-style hill has no shop phase after the first: its shop stays open all fight
  if (state.settings.gameMode === 'hill' && respawnsInFight(state.settings)) return true
  return (SHOP_RULE as string) === 'anyPhase' || state.phase === 'shop'
}

/** Whether `player` may buy right now (SHOP_RULE): shop phase, or their pawn is dead. */
export function canBuy(state: SimState, player: PlayerId): boolean {
  if (!isRoundParticipant(state, player)) return false
  if (state.phase === 'gameOver') return false
  if (shopOpen(state)) return true
  const pawn = pawnOf(state, player)
  return !!pawn && !pawn.alive
}

/** 'purchase' event for a successful buy / upgrade (upgrade burst VFX, purchase sound). */
function purchased(state: SimState, player: PlayerId, pawn: PawnState, kind: 'spell' | 'item' | 'mastery', id: string, level: number): true {
  state.events.push({ type: 'purchase', player, pawn: pawn.id, kind, id, level })
  return true
}

function pay(sc: PlayerScore, cost: number): boolean {
  if (sc.gold < cost) return false
  sc.gold -= cost
  sc.spent += cost
  return true
}

/**
 * Gold a Fresh start would refund `player` right now, 0 when it is not allowed: not ranked,
 * something was bought, and it is before the next fight (shop or round end) or, in respawn modes,
 * the pawn is dead. All of it back on a seat taken over from a bot this round, before its fight.
 */
export function freshStartRefund(state: SimState, player: PlayerId): number {
  if (state.settings.rankedRounds) return 0
  if (!isRoundParticipant(state, player)) return 0
  const sc = scoreOf(state, player)
  const pawn = pawnOf(state, player)
  if (!sc || !pawn) return 0
  const between = state.phase === 'shop' || state.phase === 'roundEnd'
  if (!between && !(respawnsInFight(state.settings) && !pawn.alive && canBuy(state, player))) return 0
  if (between && slotOf(state, player)?.takeover === state.round) return sc.spent
  return Math.floor(sc.spent * (1 - FRESH_START_PENALTY))
}

/** Sell the whole build: the refund back, masteries 0, slots back to the starting kit. */
export function freshStart(state: SimState, player: PlayerId): boolean {
  const refund = freshStartRefund(state, player)
  const sc = scoreOf(state, player)
  const pawn = pawnOf(state, player)
  if (refund <= 0 || !sc || !pawn) return false
  // a practice cast in the shop must not fire from a slot that is gone
  cancelCast(state, pawn)
  sc.gold += refund
  sc.spent = 0
  sc.masteries.duration = 0
  sc.masteries.range = 0
  sc.masteries.lifesteal = 0
  giveStartingKit(pawn)
  // max HP falls back with the passive items; current HP is clamped, as when buying them it never rose
  recomputeStats(pawn)
  state.events.push({ type: 'freshStart', player, pawn: pawn.id, refund })
  return true
}

export function buySpell(state: SimState, player: PlayerId, spell: SpellId): boolean {
  if (!canBuy(state, player)) return false
  const def = SPELLS[spell]
  const pawn = pawnOf(state, player)
  const sc = scoreOf(state, player)
  if (!def || def.kind !== 'spell' || !RELEASED_SPELLS.has(spell) || !pawn || !sc) return false
  const slot = def.column - 1
  const current = pawn.slots[slot]
  if (current === null) {
    if (!pay(sc, def.cost)) return false
    pawn.slots[slot] = spell
    pawn.levels[slot] = 1
    pawn.cooldowns[slot] = 0
    return purchased(state, player, pawn, 'spell', spell, 1)
  }
  if (current !== spell) return false
  const level = pawn.levels[slot]
  if (level >= Math.min(def.maxLevel, SPELL_MAX_LEVEL)) return false
  if (!pay(sc, def.upgradeCosts[level - 1])) return false
  pawn.levels[slot] = level + 1
  return purchased(state, player, pawn, 'spell', spell, level + 1)
}

export function buyItem(state: SimState, player: PlayerId, item: SpellId): boolean {
  if (!canBuy(state, player)) return false
  const active = SPELLS[item]
  const passive = PASSIVE_ITEMS[item]
  const def = active && active.kind === 'item' ? active : passive
  const pawn = pawnOf(state, player)
  const sc = scoreOf(state, player)
  if (!def || !RELEASED_SPELLS.has(item) || !pawn || !sc) return false
  let free = -1
  for (let i = ITEM_SLOT_START; i < SLOT_COUNT; i++) {
    if (pawn.slots[i] === item) {
      if (pawn.levels[i] >= def.maxLevel) return false
      if (!pay(sc, def.cost)) return false
      pawn.levels[i] += 1
      // the original swaps in a fresh item entity, so an upgrade also resets its cooldown
      pawn.cooldowns[i] = 0
      recomputeStats(pawn)
      return purchased(state, player, pawn, 'item', item, pawn.levels[i])
    }
    if (free < 0 && pawn.slots[i] === null) free = i
  }
  if (free < 0) return false
  if (!pay(sc, def.cost)) return false
  pawn.slots[free] = item
  pawn.levels[free] = 1
  pawn.cooldowns[free] = 0
  recomputeStats(pawn)
  return purchased(state, player, pawn, 'item', item, 1)
}

export function buyMastery(state: SimState, player: PlayerId, kind: 'duration' | 'range' | 'lifesteal' | 'all'): boolean {
  if (!canBuy(state, player)) return false
  const sc = scoreOf(state, player)
  const pawn = pawnOf(state, player)
  if (!sc || !pawn) return false
  const m = sc.masteries
  if (kind === 'all') {
    if (m.duration >= MASTERY_MAX_LEVEL || m.range >= MASTERY_MAX_LEVEL || m.lifesteal >= MASTERY_MAX_LEVEL) return false
    if (!pay(sc, MASTERY_ALL_COST)) return false
    m.duration += 1
    m.range += 1
    m.lifesteal += 1
    purchased(state, player, pawn, 'mastery', 'duration', m.duration)
    purchased(state, player, pawn, 'mastery', 'range', m.range)
    return purchased(state, player, pawn, 'mastery', 'lifesteal', m.lifesteal)
  }
  if (kind !== 'duration' && kind !== 'range' && kind !== 'lifesteal') return false
  if (m[kind] >= MASTERY_MAX_LEVEL) return false
  if (!pay(sc, MASTERY_COST)) return false
  m[kind] += 1
  return purchased(state, player, pawn, 'mastery', kind, m[kind])
}

/** Whether `player`'s Ready matters: a connected human in the coming fight. */
function readyCounts(state: SimState, player: PlayerId): boolean {
  return slotOf(state, player)?.kind === 'human' && !!scoreOf(state, player)?.connected && isRoundParticipant(state, player)
}

/** Whether `player` may press Ready now: in the shop, or knocked out where that lasts the round. */
export function canReady(state: SimState, player: PlayerId): boolean {
  if (!readyCounts(state, player)) return false
  if (state.phase === 'shop') return true
  if ((state.phase !== 'fight' && state.phase !== 'roundEnd') || respawnsInFight(state.settings)) return false
  const pawn = pawnOf(state, player)
  return !!pawn && !pawn.alive
}

/** Ready or not (idempotent). Ignored when `player` may not press it now. */
export function setShopReady(state: SimState, player: PlayerId, ready: boolean): void {
  if (!canReady(state, player)) return
  const list = state.shopReady ?? []
  if (list.includes(player) === ready) return
  state.shopReady = ready ? [...list, player].sort((a, b) => a - b) : list.filter((id) => id !== player)
}

/** Shop phase: every counted human is ready, and there is at least one. */
export function allReady(state: SimState): boolean {
  if (state.phase !== 'shop') return false
  let counted = 0
  for (const s of state.slots) {
    if (!readyCounts(state, s.id)) continue
    if (!state.shopReady?.includes(s.id)) return false
    counted += 1
  }
  return counted > 0
}

/** The shop phase's full length in ticks, as prepareForRound sets it. */
export function shopLength(state: SimState): number {
  return ticks(state.rankedFinal ? RANKED_FINAL_SHOP_SECONDS : state.settings.shopSeconds)
}

/**
 * Shop phase, before its timer counts down: once everyone is ready the shop ends
 * SHOP_READY_SECONDS from now, never before SHOP_READY_MIN_SECONDS after it opened. It only
 * shortens, and at most once a shop: an un-ready or a newcomer afterwards gives no time back.
 */
export function readyCut(state: SimState): void {
  if (state.shopCut || !allReady(state)) return
  const elapsed = shopLength(state) - state.phaseTicksLeft
  const target = Math.max(ticks(SHOP_READY_SECONDS), ticks(SHOP_READY_MIN_SECONDS) - elapsed)
  if (state.phaseTicksLeft <= target) return
  state.events.push({ type: 'allReady', saved: state.phaseTicksLeft - target })
  state.phaseTicksLeft = target
  state.shopCut = true
}

export interface ShopReadyView {
  /** the button is there: this player may press Ready in this phase */
  shown: boolean
  /** the button works now (shown, and the countdown has not begun) */
  can: boolean
  mine: boolean
  /** counted humans ready, of `total` (shop phase only, else 0 of 0) */
  ready: number
  total: number
  /** the countdown to the fight has begun (cut, or the last SHOP_READY_SECONDS): the button locks */
  starting: boolean
}

export function shopReadyView(state: SimState, player: PlayerId): ShopReadyView {
  let ready = 0
  let total = 0
  if (state.phase === 'shop') {
    for (const s of state.slots) {
      if (!readyCounts(state, s.id)) continue
      total += 1
      if (state.shopReady?.includes(s.id)) ready += 1
    }
  }
  const starting = state.phase === 'shop' && (!!state.shopCut || state.phaseTicksLeft <= ticks(SHOP_READY_SECONDS))
  const shown = canReady(state, player)
  return { shown, can: shown && !starting, mine: !!state.shopReady?.includes(player), ready, total, starting }
}
