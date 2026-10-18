import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { frame, pushState, resetFrame } from '../../game/frame'
import { createMatch, DEFAULT_SETTINGS } from '../../sim'
import { placeSpectateBet, settleSpectateBets } from '../../sim/bets'
import { SpectatorBets } from './SpectatorBets'

afterEach(resetFrame)

function setup() {
  const state = createMatch(DEFAULT_SETTINGS, [0, 1, 2, 3].map((id) => ({ id, name: `Player ${id}`, profileId: `device-${id}`, kind: 'human', team: id, color: 0xffa044 })), 42)
  state.phase = 'fight'
  state.round = 1
  state.pawns[0].alive = false
  state.pawns[3].alive = false
  frame.localPlayer = 0
  return state
}

const markup = () => renderToStaticMarkup(createElement(SpectatorBets))

describe('personal betting presentation', () => {
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
    pushState(state)
    const html = markup()
    expect(html).toContain('Bet on which team wins')
    expect(html).toContain('Choose a team · costs 1 gold')
    expect(html).toContain('up to 2 gold total back (1 gold profit)')
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
    expect(markup()).toContain('2 gold returned · +1 gold profit')
  })

  it('keeps final-brawl betting clear without promising a bounty in a nonexistent next round', () => {
    const state = setup()
    state.settings.rankedRounds = 5
    state.rankedFinal = { contenders: [1, 2] }
    state.round = 6
    pushState(state)
    expect(markup()).toContain('Bet on who wins')
    expect(markup()).toContain('up to 2 gold total back')
    expect(markup()).not.toContain('next round’s winner bounty')
    state.settings.bounties = false
    pushState(state)
    expect(markup()).toContain('Unmatched bets are refunded')
  })

})
