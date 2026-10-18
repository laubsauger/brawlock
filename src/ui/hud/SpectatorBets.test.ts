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
    expect(markup()).toContain('Locked: Player 1')
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
    expect(markup()).toContain('Locked: Player 1')
  })

  it('labels team wagers with team names and the shared team palette', () => {
    const state = setup()
    state.settings.teamMode = 'teams'
    state.slots[1].team = 0
    state.slots[2].team = 1
    pushState(state)
    const html = markup()
    expect(html).toContain('Back the winning team')
    expect(html).toContain('Red team')
    expect(html).toContain('Blue team')
    expect(html).not.toContain('Bet 1 gold on Player 1')
  })
})
