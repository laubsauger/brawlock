import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { frame, pushState, resetFrame } from '../../game/frame'
import { createMatch, DEFAULT_SETTINGS, TICK_HZ } from '../../sim'
import { BET_STAKE, placeSpectateBet, poolPayoutIfRight, settleSpectateBets } from '../../sim/bets'
import { teamName } from '../lib/view'
import { renderMarkup, testId } from '../testing/markup'
import { SpectatorBets } from './SpectatorBets'

afterEach(resetFrame)

/** two dead bettors (0, 3), contenders 1 and 2, and living bystander 4 (bets need 3+ alive) */
function setup() {
  const state = createMatch(DEFAULT_SETTINGS, [0, 1, 2, 3, 4].map((id) => ({ id, name: `Player ${id}`, profileId: `device-${id}`, kind: 'human', team: id, color: 0xffa044 })), 42)
  state.phase = 'fight'
  state.round = 1
  state.pawns[0].alive = false
  state.pawns[3].alive = false
  frame.localPlayer = 0
  return state
}

/** The panel and its state attributes (see testing/markup.ts for the convention). */
const render = () => renderMarkup(createElement(SpectatorBets))
const panel = () => render().get(testId('spectator-bets'))
const picks = () => render().findAll(testId('bet-choice'))
const contenders = () => render().findAll(testId('bet-live-contender'))
const player = (els: ReturnType<typeof picks>, id: number) => els.find((el) => el.attr('data-player') === String(id))

describe('personal betting presentation', () => {
  it('shows open status and usable picks immediately instead of hiding them in a disclosure', () => {
    pushState(setup())
    const html = render()
    expect(html.get(testId('spectator-bets')).attr('data-betting-state')).toBe('open')
    expect(html.get('[aria-controls="spectator-bet-choices"]').attr('aria-expanded')).toBe('true')
    const choices = html.get('#spectator-bet-choices')
    expect(choices.closest('details')).toBeUndefined()
    expect(choices.findAll(testId('bet-choice')).map((el) => el.attr('data-player'))).toEqual(['1', '2', '4'])
  })

  it('counts down the timed duel window, then closes it as timed out rather than as two left', () => {
    const state = setup()
    state.pawns[4].alive = false
    state.betting.closeTick = state.tick + 3 * TICK_HZ
    pushState(state)
    expect(panel().attr('data-betting-state')).toBe('open')
    expect(panel().attr('data-seconds-left')).toBe('3')
    state.tick = state.betting.closeTick
    pushState(state)
    expect(panel().attr('data-betting-state')).toBe('closed')
    expect(panel().attr('data-window')).toBe('timedOut')
    expect(picks()).toHaveLength(0)
  })

  it('distinguishes an unaffordable open window from a closed round', () => {
    const state = setup()
    state.scores[0].gold = 0
    pushState(state)
    expect(panel().attr('data-betting-state')).toBe('poor')
    expect(picks()).toHaveLength(0)
    state.phase = 'roundEnd'
    pushState(state)
    expect(panel().attr('data-betting-state')).toBe('closed')
    expect(panel().attr('data-window')).toBe('roundEnded')
  })

  it('does not offer picks once the only living warlocks share one team', () => {
    const state = setup()
    state.settings.teamMode = 'teams'
    state.slots[1].team = state.slots[2].team = state.slots[4].team = 1
    pushState(state)
    expect(panel().attr('data-window')).toBe('decided')
    expect(picks()).toHaveLength(0)
  })

  it('does not label a replacement occupant as the original locked pick', () => {
    const state = setup()
    placeSpectateBet(state, 0, 1, 1)
    state.slots[1].profileId = 'replacement-device'
    state.slots[1].name = 'Replacement'
    pushState(state)
    expect(panel().attr('data-pick')).toBe('Player 1')
    expect(panel().get('[role="status"]').text).not.toContain('Replacement')
    expect(contenders().some((el) => el.attr('data-selected') === 'true')).toBe(false)
  })

  it('never shows the previous occupant’s settlement as the new player’s winnings', () => {
    const state = setup()
    placeSpectateBet(state, 0, 1, 1)
    placeSpectateBet(state, 3, 1, 2)
    settleSpectateBets(state, [1])
    state.phase = 'roundEnd'
    state.slots[0].profileId = 'new-bettor'
    state.slots[0].name = 'New player'
    pushState(state)
    expect(panel().attr('data-betting-state')).toBe('closed')
    expect(panel().attr('data-outcome')).toBeUndefined()
    expect(panel().find('[role="status"]')).toBeUndefined()
  })

  it('keeps the same profile’s locked pick when it reconnects into another seat', () => {
    const state = setup()
    placeSpectateBet(state, 0, 1, 1)
    state.slots[0].profileId = 'replacement'
    state.slots[3].profileId = 'device-0'
    state.slots[3].name = 'Renamed'
    frame.localPlayer = 3
    pushState(state)
    expect(panel().attr('data-betting-state')).toBe('locked')
    expect(panel().attr('data-pick')).toBe('Player 1')
  })

  it('labels team wagers with team names instead of the players in them', () => {
    const state = setup()
    state.settings.teamMode = 'teams'
    state.slots[1].team = 0
    state.slots[2].team = 1
    state.slots[4].team = 1
    pushState(state)
    const names = picks().map((el) => el.text)
    expect(names).toHaveLength(2)
    expect(names[0]).toContain(teamName(0))
    expect(names[1]).toContain(teamName(1))
    expect(names.join()).not.toContain('Player')
    placeSpectateBet(state, 0, 1, 1)
    pushState(state)
    expect(panel().attr('data-pick')).toContain(teamName(0))
  })

  it('distinguishes getting your stake back from making a profit', () => {
    const state = setup()
    placeSpectateBet(state, 0, 1, 1)
    settleSpectateBets(state, [1])
    state.phase = 'roundEnd'
    pushState(state)
    expect(panel().attr('data-outcome')).toBe('stake')
    const contested = setup()
    placeSpectateBet(contested, 0, 1, 1)
    placeSpectateBet(contested, 3, 1, 2)
    settleSpectateBets(contested, [1])
    contested.phase = 'roundEnd'
    pushState(contested)
    expect(panel().attr('data-outcome')).toBe('profit')
    expect(panel().get('[role="status"]').text).toContain(String(contested.betting.lastSettlement!.payouts[0].amount))
  })

  it('keeps final-brawl betting clear without promising a bounty in a nonexistent next round', () => {
    const state = setup()
    state.settings.rankedRounds = 5
    state.rankedFinal = { contenders: [1, 2] }
    state.round = 6
    pushState(state)
    expect(panel().attr('data-betting-state')).toBe('open')
    expect(panel().find('[data-unclaimed-pot]')).toBeUndefined()
    state.settings.bounties = false
    pushState(state)
    expect(panel().get('[data-unclaimed-pot]').attr('data-unclaimed-pot')).toBe('refund')
  })

  it('shows each pick the pool share a correct bet would collect now, from the sim, and its win chance as a percentage', () => {
    // Why: pool payouts depend on how others bet, so a fixed promise would mislead. The pool math is sim/bets.test.ts.
    const state = setup()
    placeSpectateBet(state, 3, 1, 2) // a new bet on Player 1 would now take the whole pot alone
    pushState(state)
    const open = picks()
    for (const id of [1, 2]) expect(Number(player(open, id)!.attr('data-pays'))).toBe(poolPayoutIfRight(state, id, true))
    expect(player(open, 1)!.attr('data-pays')).not.toBe(player(open, 2)!.attr('data-pays'))
    for (const el of open) expect(el.text).toContain(`${el.attr('data-chance')}%`)
    expect(panel().attr('data-pot')).toBe(String(state.betting.bets.length * BET_STAKE))
  })

  it('keeps live odds, health and pool shares after placing a bet and after betting closes', () => {
    const state = setup()
    placeSpectateBet(state, 0, 1, 1)
    pushState(state)
    expect(panel().attr('data-betting-state')).toBe('locked')
    expect(picks()).toHaveLength(0)
    const before = player(contenders(), 1)!
    expect(before.attr('data-selected')).toBe('true')
    expect(before.attr('data-backers')).toBe('1')
    expect(panel().attr('data-pot')).toBe('1')
    state.pawns[1].hp *= 0.1
    placeSpectateBet(state, 3, 1, 2)
    pushState(state)
    const after = player(contenders(), 1)!
    expect(panel().attr('data-pot')).toBe('2')
    expect(Number(after.attr('data-pays'))).toBe(poolPayoutIfRight(state, 1, false))
    expect(Number(after.attr('data-chance'))).toBeLessThan(Number(before.attr('data-chance')))
    state.pawns[4].alive = false // No more bets: two surviving contenders.
    pushState(state)
    expect(contenders().map((el) => el.attr('data-player'))).toEqual(['1', '2'])
    state.pawns[1].alive = false // your pick is out; the rest stay on view
    pushState(state)
    expect(panel().attr('data-betting-state')).toBe('locked')
    expect(contenders().map((el) => el.attr('data-player'))).toEqual(['2'])
    settleSpectateBets(state, [2])
    state.phase = 'roundEnd'
    pushState(state)
    expect(panel().attr('data-outcome')).toBe('lost')
    expect(contenders()).toHaveLength(0)
  })
})
