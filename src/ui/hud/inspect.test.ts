import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { frame, pushState, resetFrame } from '../../game/frame'
import { newMatch } from '../../sim/testkit'
import { Loadout } from './Inspect'
import { Scoreboard } from './Overlays'
import * as ticker from '../lib/ticker'

afterEach(() => {
  vi.restoreAllMocks()
  resetFrame()
})

describe('opponent loadout presentation', () => {
  it('keeps the first shop private and labels it without implying a player has finished buying', () => {
    const s = newMatch()
    frame.localPlayer = 0
    s.pawns[1].slots[0] = 'fireball'
    s.pawns[1].levels[0] = 1
    s.scores[1].gold = 0
    pushState(s, 0)
    const markup = renderToStaticMarkup(createElement(Loadout, { player: 1, cards: true }))
    expect(markup).toContain('Revealed when combat starts')
    expect(markup).not.toContain('fireball.png')
    expect(markup).not.toContain('mastery')
  })

  it('shows committed icons, levels and masteries in shop, never current purchases', () => {
    const s = newMatch()
    frame.localPlayer = 0
    s.phase = 'fight'
    s.round = 1
    s.pawns[1].slots[0] = 'fireball'
    s.pawns[1].levels[0] = 1
    s.scores[1].masteries.range = 2
    pushState(s, 0)
    s.phase = 'shop'
    s.pawns[1].slots[1] = 'teleport'
    s.pawns[1].levels[1] = 1
    s.scores[1].masteries.range = 5
    pushState(s, 1)
    const markup = renderToStaticMarkup(createElement(Loadout, { player: 1, cards: true }))
    expect(markup).toContain('Last round · current purchases hidden')
    expect(markup).toContain('fireball.png')
    expect(markup).not.toContain('teleport.png')
    expect(markup).toContain('Range mastery 2 of')
    expect(markup).not.toContain('Range mastery 5 of')
  })

  it('blocks enemy scoreboard kits while alive, then exposes live kits while spectating', () => {
    const s = newMatch()
    frame.localPlayer = 0
    s.phase = 'fight'
    s.round = 1
    s.pawns[1].slots[0] = 'lightning'
    s.pawns[1].levels[0] = 1
    pushState(s, 0)
    const alive = renderToStaticMarkup(createElement(Scoreboard))
    expect(alive).not.toContain('lightning.png')
    expect(alive).not.toContain('title="Inspect p1"')
    expect(alive).toContain('Inspect while shopping or spectating')
    s.pawns[0].alive = false
    s.pawns[1].slots[1] = 'teleport'
    s.pawns[1].levels[1] = 1
    const dead = renderToStaticMarkup(createElement(Scoreboard))
    expect(dead).toContain('lightning.png')
    expect(dead).toContain('teleport.png')
    expect(dead).toContain('title="Watch p1"')
  })

  it('cannot show an old occupant kit while the next 4Hz poll is still pending', () => {
    // Retain the previous poll exactly as a mounted hook does between intervals.
    let held: unknown
    vi.spyOn(ticker, 'usePolled').mockImplementation((read) => {
      held ??= read()
      return held as never
    })
    const s = newMatch()
    frame.localPlayer = 0
    Object.assign(s.slots[1], { kind: 'bot', profileId: 'bot:hard' })
    s.phase = 'fight'
    s.round = 1
    s.pawns[1].slots[0] = 'lightning'
    s.scores[1].masteries.range = 3
    pushState(s, 0)
    s.phase = 'shop'
    pushState(s, 1)
    expect(renderToStaticMarkup(createElement(Loadout, { player: 1 }))).toContain('lightning.png')

    Object.assign(s.slots[1], { kind: 'human', profileId: 'replacement', name: 'New player' })
    pushState(s, 2)
    const replacement = renderToStaticMarkup(createElement(Loadout, { player: 1 }))
    expect(replacement).toContain('Revealed when combat starts')
    expect(replacement).not.toContain('lightning.png')
    expect(replacement).not.toContain('Range mastery 3')
  })

  it('rechecks historical and combat visibility even before a stale live poll refreshes', () => {
    let held: unknown
    vi.spyOn(ticker, 'usePolled').mockImplementation((read) => {
      held ??= read()
      return held as never
    })
    const s = newMatch()
    frame.localPlayer = 0
    s.phase = 'fight'
    s.round = 1
    pushState(s, 0)
    s.pawns[0].alive = false
    // Next-round purchase while knocked out: visible to another spectator,
    // but it was not in this round's committed combat kit.
    s.pawns[1].slots[1] = 'teleport'
    s.pawns[1].levels[1] = 1
    expect(renderToStaticMarkup(createElement(Loadout, { player: 1 }))).toContain('teleport.png')
    s.phase = 'shop'
    pushState(s, 1)
    const shop = renderToStaticMarkup(createElement(Loadout, { player: 1 }))
    expect(shop).toContain('Last round · current purchases hidden')
    expect(shop).not.toContain('teleport.png')
    s.pawns[0].alive = true
    s.phase = 'fight'
    s.round = 2
    pushState(s, 2)
    const alive = renderToStaticMarkup(createElement(Loadout, { player: 1 }))
    expect(alive).toContain('Inspect while shopping or spectating')
    expect(alive).not.toContain('.png')
  })
})
