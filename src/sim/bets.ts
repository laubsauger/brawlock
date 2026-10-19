import { isActive, pawnOf, scoreOf, slotOf, teamOf } from './teams'
import type { BetIdentity, BetSettlement, PlayerId, PlayerSlot, SimState } from './types'

export const BET_STAKE = 1
export const BET_MAX_RETURN = 2
/**
 * Bets close once fewer warlocks than this are alive. With two left the outcome is often
 * obvious (one low, one in the lava), and an always-safe last-moment bet made waiting
 * compulsory; earlier bets also collect the capped profit first (accepted order).
 */
export const BET_MIN_LIVING = 3
/** a round that starts with only two warlocks (a ranked final) takes bets this long into the fight */
export const BET_TWO_STARTER_SECONDS = 10

function identity(state: SimState, player: PlayerId): BetIdentity {
  const slot = slotOf(state, player)!
  return { player, kind: slot.kind, name: slot.name, ...(slot.profileId ? { profileId: slot.profileId } : {}) }
}

function sameIdentity(a: BetIdentity, b: BetIdentity): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'human' && (a.profileId || b.profileId)) return a.profileId === b.profileId
  return a.player === b.player &&
    (a.profileId || b.profileId ? a.profileId === b.profileId : a.name === b.name)
}

/** Shared ownership rule for the HUD: human profiles follow their occupant across seats. */
export function betIdentityMatchesSlot(holder: BetIdentity, slot: PlayerSlot): boolean {
  return sameIdentity(holder, { player: slot.id, kind: slot.kind, name: slot.name, profileId: slot.profileId })
}

function ownerOf(state: SimState, holder: BetIdentity): PlayerId | undefined {
  return state.slots.find((slot) => betIdentityMatchesSlot(holder, slot))?.id
}

/** Eligibility is shared by the authoritative command and the dead-player HUD. */
export function canSpectateBet(state: SimState, player: PlayerId, target?: PlayerId): boolean {
  if (!state.settings.spectatorBets || state.settings.gameMode !== 'rounds' || state.phase !== 'fight') return false
  const slot = slotOf(state, player)
  const payer = scoreOf(state, player)
  const pawn = pawnOf(state, player)
  if (!slot || slot.kind !== 'human' || !payer?.connected || !pawn || pawn.alive || payer.gold < BET_STAKE) return false
  // An accepted wager remains immutable even if its owner disconnects or renames.
  const holder = identity(state, player)
  if (state.betting.bets.some((bet) => bet.round === state.round && sameIdentity(bet.payer, holder))) return false
  const living = state.pawns.filter((p) => p.alive && isActive(state, p.owner))
  const closeTick = state.betting.closeTick
  if (closeTick !== undefined ? state.tick >= closeTick : living.length < BET_MIN_LIVING) return false
  if (new Set(living.map((p) => teamOf(state, p.owner))).size < 2) return false
  const validTarget = (id: PlayerId) => Number.isInteger(id) && id >= 0 &&
    !!slotOf(state, id) && !!scoreOf(state, id)?.connected && living.some((p) => p.owner === id)
  return target === undefined ? living.some((p) => validTarget(p.owner)) : validTarget(target)
}

export function placeSpectateBet(state: SimState, player: PlayerId, round: number, target: PlayerId): boolean {
  if (!Number.isInteger(round) || round !== state.round || !canSpectateBet(state, player, target)) return false
  scoreOf(state, player)!.gold -= BET_STAKE
  state.betting.bets.push({ round, player, target, payer: identity(state, player), pick: identity(state, target) })
  return true
}

function pay(state: SimState, holder: BetIdentity, amount: number): void {
  if (amount <= 0) return
  const owner = ownerOf(state, holder)
  const score = owner === undefined ? undefined : scoreOf(state, owner)
  if (score) {
    score.gold += amount
    return
  }
  const credit = state.betting.credits.find((c) => sameIdentity(c.holder, holder))
  if (credit) credit.amount += amount
  else state.betting.credits.push({ holder: { ...holder }, amount })
}

/** Resolve held payouts only to their original occupant, including a profile-preserving rename. */
export function deliverBettingCredits(state: SimState): void {
  state.betting.credits = state.betting.credits.filter((credit) => {
    const owner = ownerOf(state, credit.holder)
    const score = owner === undefined ? undefined : scoreOf(state, owner)
    if (!score) return true
    score.gold += credit.amount
    return false
  })
}

/** Current occupant's coin badge. Older occupants' bounties remain identity-owned. */
export function bountyOf(state: SimState, player: PlayerId): number {
  if (!slotOf(state, player)) return 0
  const holder = identity(state, player)
  return state.betting.bounties.reduce((sum, b) => sum +
    (sameIdentity(b.holder, holder) ? b.amount : 0), 0)
}

/** Called before round-end settlement, so a kill cannot collect the next round's new bounty. */
export function claimBounty(state: SimState, victim: PlayerId, killer: PlayerId | null, cause: string): number {
  if (!state.settings.bounties || state.settings.gameMode !== 'rounds' || state.phase !== 'fight' ||
      cause === 'disconnect' || killer === null || killer === victim || !slotOf(state, killer) || !scoreOf(state, killer)) return 0
  let claimed = 0
  state.betting.bounties = state.betting.bounties.filter((bounty) => {
    if (ownerOf(state, bounty.holder) !== victim || bounty.activeFromRound > state.round) return true
    claimed += bounty.amount
    return false
  })
  scoreOf(state, killer)!.gold += claimed
  return claimed
}

/** Whole coins only. Accepted order decides capped bonuses; no gold enters or leaves the pot. */
export function settleSpectateBets(state: SimState, winners: readonly PlayerId[]): void {
  if (state.settings.gameMode !== 'rounds' || state.betting.lastSettlement?.round === state.round) return
  const bets = state.betting.bets.filter((b) => b.round === state.round)
  const settlement: BetSettlement = { round: state.round, winners: [...winners], payouts: [], bountyAdded: 0 }
  const correct = bets.map((bet) => {
    const picked = ownerOf(state, bet.pick)
    return picked !== undefined && winners.includes(picked)
  })
  const amounts: number[] = bets.map((_, i) => winners.length === 0 || correct[i] ? BET_STAKE : 0)
  let remaining = bets.length * BET_STAKE - amounts.reduce((sum, n) => sum + n, 0)
  if (winners.length > 0) {
    for (let i = 0; i < bets.length && remaining > 0; i++) {
      if (!correct[i]) continue
      amounts[i] += 1
      remaining -= 1
    }
  }
  const holders = winners.filter((id) => pawnOf(state, id)?.alive && isActive(state, id))
    .sort((a, b) => a - b)
  if (state.settings.bounties && remaining > 0) {
    if (holders.length === 0) throw new Error('A winning bet pot needs a living round winner')
    settlement.bountyAdded = remaining
    for (let i = 0; i < holders.length; i++) {
      const amount = Math.floor(remaining / holders.length) + (i < remaining % holders.length ? 1 : 0)
      if (amount === 0) continue
      const holder = identity(state, holders[i])
      const old = state.betting.bounties.find((b) => sameIdentity(b.holder, holder))
      if (old) old.amount += amount
      else state.betting.bounties.push({ holder, amount, activeFromRound: state.round + 1 })
    }
  } else {
    // Unmatched stakes are refunded from the last accepted losing bet backward.
    for (let i = bets.length - 1; i >= 0 && remaining > 0; i--) {
      if (correct[i]) continue
      amounts[i] += BET_STAKE
      remaining -= BET_STAKE
    }
  }
  bets.forEach((bet, i) => {
    pay(state, bet.payer, amounts[i])
    settlement.payouts.push({ player: ownerOf(state, bet.payer) ?? bet.player, amount: amounts[i], correct: correct[i] })
  })
  state.betting.lastSettlement = settlement
}
