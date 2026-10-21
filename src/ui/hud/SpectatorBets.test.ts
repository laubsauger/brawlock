import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { frame, pushState, resetFrame } from '../../game/frame'
import { createMatch, DEFAULT_SETTINGS, TICK_HZ } from '../../sim'
import { placeSpectateBet, settleSpectateBets } from '../../sim/bets'
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

const markup = () => renderToStaticMarkup(createElement(SpectatorBets))

describe('personal betting presentation', () => {
  it('shows open status and usable picks immediately instead of hiding them in a disclosure', () => {
    const state = setup()
    pushState(state)
    const html = markup()
    expect(html).toContain('data-betting-state="open"')
    expect(html).toContain('Betting open')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('aria-label="Bet 1 gold on Player 1: pays 1 gold if right')
    expect(html.indexOf('spectator-bet-choices')).toBeLessThan(html.indexOf('<details'))
  })

  it('explains the timed duel window and its deadline instead of blaming the two survivors', () => {
    const state = setup()
    state.pawns[4].alive = false
    state.betting.closeTick = state.tick + 3 * TICK_HZ
    pushState(state)
    expect(markup()).toContain('Closes in 3s')
    expect(markup()).toContain('Betting open')
    state.tick = state.betting.closeTick
    pushState(state)
    expect(markup()).toContain('Betting closed: the first 10 seconds are over')
    expect(markup()).not.toContain('two warlocks left')
    expect(markup()).not.toContain('aria-label="Bet 1 gold on')
  })

  it('distinguishes an unaffordable open window from a closed round', () => {
    const state = setup()
    state.scores[0].gold = 0
    pushState(state)
    expect(markup()).toContain('Not enough gold')
    expect(markup()).toContain('You need 1 gold to bet')
    state.phase = 'roundEnd'
    pushState(state)
    expect(markup()).toContain('Betting closed for this round')
    expect(markup()).not.toContain('Not enough gold')
  })

  it('does not offer picks once the only living warlocks share one team', () => {
    const state = setup()
    state.settings.teamMode = 'teams'
    state.slots[1].team = state.slots[2].team = state.slots[4].team = 1
    pushState(state)
    expect(markup()).toContain('Betting closed: only one team remains')
    expect(markup()).not.toContain('aria-label="Bet 1 gold on')
  })

  it('does not label a replacement occupant as the original locked pick', () => {
    const state = setup()
    placeSpectateBet(state, 0, 1, 1)
    state.slots[1].profileId = 'replacement-device'
    state.slots[1].name = 'Replacement'
    pushState(state)
    expect(markup()).toContain('Your bet: Player 1 · 1 gold placed')
    expect(markup()).not.toContain('Replacement')
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
    expect(markup()).toContain('Betting closed')
    expect(markup()).not.toContain('role="status"')
    expect(markup()).not.toContain('2 gold returned')
  })

  it('keeps the same profile’s locked pick when it reconnects into another seat', () => {
    const state = setup()
    placeSpectateBet(state, 0, 1, 1)
    state.slots[0].profileId = 'replacement'
    state.slots[3].profileId = 'device-0'
    state.slots[3].name = 'Renamed'
    frame.localPlayer = 3
    pushState(state)
    expect(markup()).toContain('Your bet: Player 1 · 1 gold placed')
  })

  it('labels team wagers with team names and the shared team palette', () => {
    const state = setup()
    state.settings.teamMode = 'teams'
    state.slots[1].team = 0
    state.slots[2].team = 1
    state.slots[4].team = 1
    pushState(state)
    const html = markup()
    expect(html).toContain('Bet on which team wins')
    expect(html).toContain('Choose a team · costs 1 gold')
    expect(html).toContain('correct bets split it equally')
    expect(html).toContain('Red team')
    expect(html).toContain('Blue team')
    expect(html).not.toContain('Bet 1 gold on Player 1')
    placeSpectateBet(state, 0, 1, 1)
    pushState(state)
    expect(markup()).toContain('Your bet: Red team')
  })

  it('distinguishes getting your stake back from making a profit', () => {
    const state = setup()
    placeSpectateBet(state, 0, 1, 1)
    settleSpectateBets(state, [1])
    state.phase = 'roundEnd'
    pushState(state)
    expect(markup()).toContain('1 gold returned (your stake)')
    expect(markup()).not.toContain('+1 gold profit')
    const contested = setup()
    placeSpectateBet(contested, 0, 1, 1)
    placeSpectateBet(contested, 3, 1, 2)
    settleSpectateBets(contested, [1])
    contested.phase = 'roundEnd'
    pushState(contested)
    expect(markup()).toContain('You won 2 gold from the 2 gold pot · +1 gold profit')
  })

  it('keeps final-brawl betting clear without promising a bounty in a nonexistent next round', () => {
    const state = setup()
    state.settings.rankedRounds = 5
    state.rankedFinal = { contenders: [1, 2] }
    state.round = 6
    pushState(state)
    expect(markup()).toContain('Bet on who wins')
    expect(markup()).toContain('correct bets split it equally')
    expect(markup()).not.toContain('next round’s winner bounty')
    state.settings.bounties = false
    pushState(state)
    expect(markup()).toContain('If nobody is right, every bet is refunded')
  })

  it('shows what a correct bet pays at the current pot, updated as others bet, apart from the win chance', () => {
    // Why: pool payouts depend on how others bet, so a fixed promise would mislead.
    const state = setup()
    pushState(state)
    expect(markup()).toContain('aria-label="Bet 1 gold on Player 2: pays 1 gold if right')
    // Player 3 backs Player 2: a new bet on Player 1 would take the whole 2 gold pot alone
    placeSpectateBet(state, 3, 1, 2)
    pushState(state)
    const html = markup()
    expect(html).toContain('aria-label="Bet 1 gold on Player 1: pays 2 gold if right')
    expect(html).toContain('aria-label="Bet 1 gold on Player 2: pays 1 gold if right')
    expect(html).toContain('>pays 2</span>')
    // the win chance reads as a percentage to win, never as a bare number next to the payout
    expect(html).toMatch(/>\d+% win<\/span>/)
    expect(html).toContain('Pot: 1 gold')
    placeSpectateBet(state, 0, 1, 1)
    pushState(state)
    expect(markup()).toContain('Your bet: Player 1 · 1 gold placed<span class="text-gold"> · pays 2 gold if right</span>')
  })

})
