import { isActive, isRoundParticipant, pawnOf, scoreOf, slotOf, teamOf } from './teams'
import type { BetIdentity, BetSettlement, PlayerId, PlayerSlot, SimState } from './types'

/**
 * Spectator betting is our addition (not in the original). Payouts are a pool (parimutuel):
 * every stake of the round forms one pot, shared equally by the correct bets. The earlier
 * fixed cap (2 gold back) paid a favourite as much as a long shot; a pool pays more the
 * fewer bettors were right.
 */
export const BET_STAKE = 1
/**
 * Bets close once fewer warlocks than this are alive. With two left the outcome is often
 * obvious (one low, one in the lava), and an always-safe last-moment bet made waiting
 * compulsory.
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

/** The betting window, independent of a spectator's balance or existing wager. */
export function spectateBetWindow(state: SimState): 'open' | 'disabled' | 'notStarted' | 'roundEnded' | 'twoLeft' | 'timedOut' | 'decided' {
  if (!state.settings.spectatorBets || state.settings.gameMode !== 'rounds') return 'disabled'
  if (state.phase === 'roundEnd' || state.phase === 'gameOver') return 'roundEnded'
  if (state.phase !== 'fight') return 'notStarted'
  const living = state.pawns.filter((p) => p.alive && isActive(state, p.owner))
  if (state.betting.closeTick !== undefined) {
    if (state.tick >= state.betting.closeTick) return 'timedOut'
  } else if (living.length < BET_MIN_LIVING) return 'twoLeft'
  return new Set(living.map((p) => teamOf(state, p.owner))).size < 2 ? 'decided' : 'open'
}

/** Eligibility is shared by the authoritative command and the dead-player HUD. */
export function canSpectateBet(state: SimState, player: PlayerId, target?: PlayerId): boolean {
  if (spectateBetWindow(state) !== 'open') return false
  const slot = slotOf(state, player)
  const payer = scoreOf(state, player)
  const pawn = pawnOf(state, player)
  if (!slot || slot.kind !== 'human' || !payer?.connected || !pawn || pawn.alive || payer.gold < BET_STAKE) return false
  // An accepted wager remains immutable even if its owner disconnects or renames.
  const holder = identity(state, player)
  if (state.betting.bets.some((bet) => bet.round === state.round && sameIdentity(bet.payer, holder))) return false
  const living = state.pawns.filter((p) => p.alive && isActive(state, p.owner))
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

/** Current-round bets whose pick (by identity) would be a winner, as roundWon names them, if `target`'s team won now. */
function betsOn(state: SimState, target: PlayerId): number {
  const team = teamOf(state, target)
  return state.betting.bets.filter((bet) => {
    if (bet.round !== state.round) return false
    const picked = ownerOf(state, bet.pick)
    return picked !== undefined && isRoundParticipant(state, picked) && teamOf(state, picked) === team
  }).length
}

/**
 * What one correct bet on `target` would collect if the round were settled now: the floored
 * pool share. `placing` adds the caller's own not-yet-placed bet (the HUD's "pays N" on an
 * open pick). Later bets change it, and settlement may add one remainder coin (see below).
 */
export function poolPayoutIfRight(state: SimState, target: PlayerId, placing: boolean): number {
  const extra = placing ? 1 : 0
  const bets = state.betting.bets.filter((b) => b.round === state.round).length + extra
  const right = betsOn(state, target) + extra
  return right > 0 ? Math.floor((bets * BET_STAKE) / right) : 0
}

/**
 * Pool settlement in whole coins; no gold enters or leaves the pot.
 * - Some bets right: each gets floor(pot / correct bets). The remainder (fewer coins than
 *   there are correct bets) funds the winners' bounty when bounties are on; otherwise the
 *   earliest accepted correct bets get one extra coin each.
 * - Nobody right: the whole pot funds the winners' bounty when bounties are on; otherwise
 *   every stake is refunded. A draw (no winners) always refunds every stake.
 * So when everyone is right, each bet just gets its stake back.
 */
export function settleSpectateBets(state: SimState, winners: readonly PlayerId[]): void {
  if (state.settings.gameMode !== 'rounds' || state.betting.lastSettlement?.round === state.round) return
  const bets = state.betting.bets.filter((b) => b.round === state.round)
  const settlement: BetSettlement = { round: state.round, winners: [...winners], payouts: [], bountyAdded: 0 }
  const correct = bets.map((bet) => {
    const picked = ownerOf(state, bet.pick)
    return picked !== undefined && winners.includes(picked)
  })
  const pot = bets.length * BET_STAKE
  const right = correct.filter(Boolean).length
  const share = right > 0 ? Math.floor(pot / right) : 0
  const amounts: number[] = bets.map((_, i) => winners.length === 0 ? BET_STAKE : correct[i] ? share : 0)
  let remaining = pot - amounts.reduce((sum, n) => sum + n, 0)
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
  } else if (right > 0) {
    // No bounty to fund: the pool remainder goes one coin each to the earliest correct bets.
    for (let i = 0; i < bets.length && remaining > 0; i++) {
      if (!correct[i]) continue
      amounts[i] += 1
      remaining -= 1
    }
  } else {
    // Nobody was right and there is no bounty to fund: every stake is refunded.
    for (let i = 0; i < bets.length && remaining > 0; i++) {
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
