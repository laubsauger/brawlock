import { describe, expect, test } from 'vitest'
import { bountyOf, canSpectateBet, claimBounty, deliverBettingCredits, placeSpectateBet, settleSpectateBets } from './bets'
import { killPawn } from './combat'
import { cloneState, hashState, step } from './index'
import { roundWon, startRound } from './mode'
import { cmd, fight, pawn } from './testkit'
import type { InputCommand, SimState } from './types'

/** `bettors` dead humans, two contenders, and a living bystander (bets need 3+ warlocks alive) */
function setup(bettors = 4): SimState {
  const state = fight(bettors + 3, undefined, { killGold: 0, winGold: 0, roundGold: 0, winScore: 99 })
  state.slots.forEach((slot) => { slot.profileId = `profile:${slot.id}` })
  for (let id = 0; id < bettors; id++) pawn(state, id).alive = false
  return state
}

function wealth(state: SimState): number {
  const unsettled = state.betting.lastSettlement?.round !== state.round ? state.betting.bets.length : 0
  return state.scores.reduce((n, s) => n + s.gold, 0) + unsettled +
    state.betting.bounties.reduce((n, b) => n + b.amount, 0) +
    state.betting.credits.reduce((n, c) => n + c.amount, 0)
}

describe('authoritative spectator wagers', () => {
  test('one immutable 1-gold bet, bound to the current round and a living connected target', () => {
    const s = setup()
    expect(canSpectateBet(s, 0)).toBe(true)
    expect(placeSpectateBet(s, 0, s.round - 1, 4)).toBe(false)
    expect(placeSpectateBet(s, 0, s.round, 1)).toBe(false)
    expect(placeSpectateBet(s, 0, s.round, 99)).toBe(false)
    expect(placeSpectateBet(s, 0, s.round, 4.5)).toBe(false)
    expect(placeSpectateBet(s, 0, s.round, 4)).toBe(true)
    expect(s.scores[0].gold).toBe(29)
    expect(placeSpectateBet(s, 0, s.round, 5)).toBe(false)
    expect(s.betting.bets).toHaveLength(1)
  })

  test('bets close once only two warlocks are alive', () => {
    // Why: with two left the winner is often obvious; a safe last-moment bet made waiting
    // until then compulsory for everyone.
    const s = setup()
    expect(canSpectateBet(s, 0, 4)).toBe(true)
    pawn(s, 6).alive = false
    expect(canSpectateBet(s, 0, 4)).toBe(false)
    expect(placeSpectateBet(s, 0, s.round, 4)).toBe(false)
    expect(s.betting.bets).toHaveLength(0)
  })

  test('rejects living players, bots, disconnected humans, spectators without seats, disabled modes, and unaffordable bets', () => {
    const s = setup()
    expect(canSpectateBet(s, 4, 5)).toBe(false)
    expect(canSpectateBet(s, 99, 4)).toBe(false)
    s.slots[0].kind = 'bot'
    expect(canSpectateBet(s, 0, 4)).toBe(false)
    s.slots[0].kind = 'human'
    s.scores[0].connected = false
    expect(canSpectateBet(s, 0, 4)).toBe(false)
    s.scores[0].connected = true
    s.scores[0].gold = 0
    expect(canSpectateBet(s, 0, 4)).toBe(false)
    s.scores[0].gold = 1
    s.scores[4].connected = false
    expect(canSpectateBet(s, 0, 4)).toBe(false)
    s.scores[4].connected = true
    s.settings.spectatorBets = false
    expect(canSpectateBet(s, 0, 4)).toBe(false)
    s.settings.spectatorBets = true
    s.settings.gameMode = 'deathmatch'
    expect(canSpectateBet(s, 0, 4)).toBe(false)
    s.settings.gameMode = 'rounds'
    s.phase = 'roundEnd'
    expect(canSpectateBet(s, 0, 4)).toBe(false)
  })

  test('step validates malformed commands and duplicate resends, and clones/replays deterministic economic state', () => {
    const a = setup()
    const b = cloneState(a)
    const malformed = { kind: 'spectateBet', round: a.round, target: 4, stake: -50 } as unknown as InputCommand
    step(a, [cmd(0, malformed), cmd(1, { kind: 'spectateBet', round: NaN, target: 4 })])
    step(b, [])
    expect(hashState(a)).toBe(hashState(b))
    const input = cmd(0, { kind: 'spectateBet', round: a.round, target: 4 })
    step(a, [input, input])
    step(b, [input, input])
    expect(hashState(a)).toBe(hashState(b))
    expect(a.betting.bets).toHaveLength(1)
    const copy = cloneState(a)
    copy.betting.bets[0].payer.name = 'different'
    expect(a.betting.bets[0].payer.name).toBe('p0')
  })

  test('first accepted correct pick receives limited bonus; a correct solo bet only returns its stake', () => {
    const s = setup()
    placeSpectateBet(s, 2, s.round, 4)
    placeSpectateBet(s, 0, s.round, 4)
    placeSpectateBet(s, 1, s.round, 5)
    const total = wealth(s)
    settleSpectateBets(s, [4])
    expect(s.betting.lastSettlement?.payouts).toEqual([
      { player: 2, amount: 2, correct: true }, { player: 0, amount: 1, correct: true }, { player: 1, amount: 0, correct: false },
    ])
    expect(wealth(s)).toBe(total)
    const solo = setup()
    placeSpectateBet(solo, 0, solo.round, 4)
    settleSpectateBets(solo, [4])
    expect(solo.scores[0].gold).toBe(30)
  })

  test('bounties disabled refunds unmatched losing stakes in reverse accepted order', () => {
    const s = setup()
    s.settings.bounties = false
    for (let id = 0; id < 4; id++) placeSpectateBet(s, id, s.round, id === 0 ? 4 : 5)
    const total = wealth(s)
    settleSpectateBets(s, [4])
    expect(s.betting.lastSettlement?.payouts.map((p) => p.amount)).toEqual([2, 0, 1, 1])
    expect(s.betting.bounties).toEqual([])
    expect(wealth(s)).toBe(total)
  })

  test('draw refunds everyone including disconnected bettors, once only', () => {
    const s = setup()
    for (let id = 0; id < 4; id++) placeSpectateBet(s, id, s.round, 4)
    s.scores[0].connected = false
    roundWon(s, null)
    expect(s.scores.slice(0, 4).map((p) => p.gold)).toEqual([30, 30, 30, 30])
    settleSpectateBets(s, [])
    expect(s.scores[0].gold).toBe(30)
    expect(s.betting.bounties).toEqual([])
  })

  test('team picks count dead teammates as winners; bounty goes only to living winning members', () => {
    const s = setup()
    s.settings.teamMode = 'teams'
    s.slots[4].team = 2
    s.slots[5].team = 3
    placeSpectateBet(s, 0, s.round, 4)
    placeSpectateBet(s, 1, s.round, 5)
    placeSpectateBet(s, 2, s.round, 5)
    s.slots[3].team = 2
    roundWon(s, 2)
    expect(s.betting.lastSettlement?.winners).toEqual([2, 3, 4])
    expect(s.betting.lastSettlement?.payouts[0].amount).toBe(2)
    expect(bountyOf(s, 4)).toBe(1)
    expect(bountyOf(s, 3)).toBe(0)
  })

  test('a selected teammate dying before their team wins still wins the wager', () => {
    const s = setup()
    s.settings.teamMode = 'teams'
    s.slots[4].team = 8
    s.slots[5].team = 9
    expect(placeSpectateBet(s, 0, s.round, 4)).toBe(true)
    pawn(s, 4).alive = false
    pawn(s, 3).alive = true
    s.slots[3].team = 8
    roundWon(s, 8)
    expect(s.betting.lastSettlement!.payouts[0]).toEqual({ player: 0, amount: 1, correct: true })
  })

  test('never mints or loses escrow coins for any win/loss distribution', () => {
    for (const enabled of [false, true]) for (let mask = 0; mask < 16; mask++) {
      const s = setup()
      s.settings.bounties = enabled
      const before = wealth(s)
      for (let id = 0; id < 4; id++) placeSpectateBet(s, id, s.round, mask & (1 << id) ? 4 : 5)
      settleSpectateBets(s, [4])
      expect(wealth(s)).toBe(before)
      expect(s.betting.lastSettlement!.payouts.every((p) => p.amount <= 2)).toBe(true)
    }
  })
})

describe('identity-owned bounties and rewards', () => {
  function withBounty(): SimState {
    const s = setup()
    placeSpectateBet(s, 0, s.round, 5)
    roundWon(s, 4)
    expect(bountyOf(s, 4)).toBe(1)
    return s
  }

  test('new bounty becomes claimable next round; credited lethal hit pays once before settlement', () => {
    const s = withBounty()
    expect(claimBounty(s, 4, 5, 'fireball')).toBe(0)
    startRound(s)
    expect(s.betting.bets).toEqual([])
    const before = s.scores[5].gold
    killPawn(s, pawn(s, 4), 5, 'fireball')
    expect(s.events.find((e) => e.type === 'death' && e.owner === 4)).toMatchObject({ killer: 5, bountyGold: 1 })
    expect(s.scores[5].gold).toBe(before + 1)
    expect(bountyOf(s, 4)).toBe(0)
    expect(claimBounty(s, 4, 5, 'fireball')).toBe(0)
  })

  test('unattributed death, disconnect, disabled bounties and deathmatch preserve the bounty', () => {
    const s = withBounty()
    startRound(s)
    expect(claimBounty(s, 4, null, 'lava')).toBe(0)
    expect(claimBounty(s, 4, 5, 'disconnect')).toBe(0)
    s.settings.bounties = false
    expect(claimBounty(s, 4, 5, 'fireball')).toBe(0)
    s.settings.bounties = true
    s.settings.gameMode = 'deathmatch'
    expect(claimBounty(s, 4, 5, 'fireball')).toBe(0)
    expect(bountyOf(s, 4)).toBe(1)
  })

  test('profile-preserving rename retains bounty; replacement seat cannot inherit or pay it', () => {
    const s = withBounty()
    startRound(s)
    s.slots[4].name = 'renamed'
    expect(bountyOf(s, 4)).toBe(1)
    s.slots[4].profileId = 'new-owner'
    expect(bountyOf(s, 4)).toBe(0)
    expect(claimBounty(s, 4, 5, 'fireball')).toBe(0)
    expect(s.betting.bounties[0].amount).toBe(1)
  })

  test('unclaimed bounty accumulates, splitting new coins only among living winners in ID order', () => {
    const s = withBounty()
    startRound(s)
    for (let id = 0; id < 3; id++) {
      pawn(s, id).alive = false
      expect(placeSpectateBet(s, id, s.round, 3)).toBe(true)
    }
    s.settings.teamMode = 'teams'
    s.slots[4].team = 12
    s.slots[5].team = 12
    roundWon(s, 12)
    expect(bountyOf(s, 4)).toBe(3)
    expect(bountyOf(s, 5)).toBe(1)
    expect(s.betting.lastSettlement!.bountyAdded).toBe(3)
  })

  test('replaced payer cannot receive previous occupant winnings; held credit returns to original identity', () => {
    const s = setup()
    placeSpectateBet(s, 0, s.round, 4)
    placeSpectateBet(s, 1, s.round, 5)
    s.slots[0].profileId = 'replacement'
    const total = wealth(s)
    settleSpectateBets(s, [4])
    expect(s.scores[0].gold).toBe(29)
    expect(s.betting.credits[0].amount).toBe(2)
    expect(wealth(s)).toBe(total)
    s.slots[0].profileId = 'profile:0'
    s.slots[0].name = 'renamed'
    deliverBettingCredits(s)
    expect(s.scores[0].gold).toBe(31)
    expect(s.betting.credits).toEqual([])
  })

  test('held winnings follow the original human profile into a different seat, never its replacement', () => {
    const s = setup()
    placeSpectateBet(s, 0, s.round, 4)
    placeSpectateBet(s, 1, s.round, 5)
    s.slots[0].profileId = 'replacement'
    settleSpectateBets(s, [4])
    expect(s.betting.credits[0].amount).toBe(2)
    s.slots[2].profileId = 'profile:0'
    s.slots[2].name = 'Returned elsewhere'
    const total = wealth(s)
    deliverBettingCredits(s)
    expect(s.scores[2].gold).toBe(32)
    expect(s.scores[0].gold).toBe(29)
    expect(s.betting.credits).toEqual([])
    expect(wealth(s)).toBe(total)
  })

  test('bounty follows a returning human profile across seats and pays for the current pawn only', () => {
    const s = withBounty()
    startRound(s)
    s.slots[4].profileId = 'replacement'
    s.slots[2].profileId = 'profile:4'
    s.slots[2].name = 'Returned elsewhere'
    expect(bountyOf(s, 4)).toBe(0)
    expect(bountyOf(s, 2)).toBe(1)
    expect(claimBounty(s, 4, 5, 'fireball')).toBe(0)
    const total = wealth(s)
    expect(claimBounty(s, 2, 5, 'fireball')).toBe(1)
    expect(bountyOf(s, 2)).toBe(0)
    expect(wealth(s)).toBe(total)
  })

  test('human profile cannot place a second wager after moving seats, and direct payout follows its current seat', () => {
    const s = setup()
    placeSpectateBet(s, 0, s.round, 4)
    placeSpectateBet(s, 1, s.round, 5)
    s.slots[0].profileId = 'replacement'
    s.slots[2].profileId = 'profile:0'
    expect(canSpectateBet(s, 2, 4)).toBe(false)
    settleSpectateBets(s, [4])
    expect(s.scores[0].gold).toBe(29)
    expect(s.scores[2].gold).toBe(32)
    expect(s.betting.lastSettlement!.payouts[0]).toEqual({ player: 2, amount: 2, correct: true })
  })

  test('bot identities stay seat-bound even when every bot has the same profile label', () => {
    const s = setup()
    s.slots[4].kind = s.slots[5].kind = 'bot'
    s.slots[4].profileId = s.slots[5].profileId = 'bot:hard'
    placeSpectateBet(s, 0, s.round, 5)
    roundWon(s, 4)
    expect(bountyOf(s, 4)).toBe(1)
    expect(bountyOf(s, 5)).toBe(0)
    startRound(s)
    expect(claimBounty(s, 5, 3, 'fireball')).toBe(0)
    expect(claimBounty(s, 4, 3, 'fireball')).toBe(1)
  })

  test('changed target identity cannot convert a previous occupant pick into a win', () => {
    const s = setup()
    placeSpectateBet(s, 0, s.round, 4)
    s.slots[4].profileId = 'replacement'
    settleSpectateBets(s, [4])
    expect(s.betting.lastSettlement?.payouts[0]).toEqual({ player: 0, amount: 0, correct: false })
    expect(bountyOf(s, 4)).toBe(1)
  })

  test('a winning picked human is recognized by profile after returning to a different seat', () => {
    const s = setup()
    placeSpectateBet(s, 0, s.round, 4)
    s.slots[4].profileId = 'replacement'
    s.slots[5].profileId = 'profile:4'
    settleSpectateBets(s, [5])
    expect(s.betting.lastSettlement!.payouts[0]).toEqual({ player: 0, amount: 1, correct: true })
    expect(s.scores[0].gold).toBe(30)
  })
})
