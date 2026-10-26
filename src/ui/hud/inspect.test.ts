import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { frame, pushState, resetFrame } from '../../game/frame'
import { newMatch } from '../../sim/testkit'
import { renderMarkup, testId, type MarkupElement } from '../testing/markup'
import { Loadout } from './Inspect'
import { Scoreboard } from './Overlays'
import * as ticker from '../lib/ticker'

afterEach(() => {
  vi.restoreAllMocks()
  resetFrame()
})

// Which kit may be shown when is game/inspect.test.ts; these check that Loadout and the
// scoreboard render what it decides, also between polls.
const loadout = (player: number, cards = false) => renderMarkup(createElement(Loadout, { player, cards })).get(testId('loadout'))
const abilities = (el: MarkupElement) => el.findAll('[data-ability]').map((slot) => slot.attr('data-ability'))
const mastery = (el: MarkupElement, id: string) => el.find(`[data-mastery="${id}"]`)?.text.replace(/\D/g, '')
const pips = (el: MarkupElement, id: string) => el.get(`[data-ability="${id}"]`).findAll('[data-on="true"]').length

describe('opponent loadout presentation', () => {
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
    const shop = loadout(1, true)
    expect(shop.attr('data-state')).toBe('lastRound')
    expect(abilities(shop)).toContain('fireball')
    expect(abilities(shop)).not.toContain('teleport')
    expect(mastery(shop, 'range')).toBe('2')
  })

  it('shows own and opponent live scoreboard kits while alive and keeps them live while spectating', () => {
    const s = newMatch()
    frame.localPlayer = 0
    s.phase = 'fight'
    s.round = 1
    s.pawns[0].slots[0] = 'boomerang'
    s.pawns[0].levels[0] = 3
    s.scores[0].masteries.range = 1
    s.pawns[1].slots[0] = 'lightning'
    s.pawns[1].levels[0] = 2
    s.scores[1].masteries.range = 4
    pushState(s, 0)
    const board = () => renderMarkup(createElement(Scoreboard)).findAll(testId('loadout'))
    const alive = board()
    expect(alive.map((el) => el.attr('data-state'))).toEqual(['live', 'live'])
    expect(alive.flatMap(abilities)).toEqual(expect.arrayContaining(['boomerang', 'lightning']))
    expect(alive.map((el) => mastery(el, 'range')).sort()).toEqual(['1', '4'])
    expect(pips(loadout(0, true), 'boomerang')).toBe(3)
    expect(pips(loadout(1, true), 'lightning')).toBe(2)
    s.pawns[0].alive = false
    s.pawns[1].slots[1] = 'teleport'
    s.pawns[1].levels[1] = 1
    const dead = board()
    expect(dead.map((el) => el.attr('data-state'))).toEqual(['live', 'live'])
    expect(dead.flatMap(abilities)).toEqual(expect.arrayContaining(['boomerang', 'lightning', 'teleport']))
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
    expect(abilities(loadout(1))).toContain('lightning')

    Object.assign(s.slots[1], { kind: 'human', profileId: 'replacement', name: 'New player' })
    pushState(s, 2)
    const replacement = loadout(1)
    expect(replacement.attr('data-state')).toBe('unrevealed')
    expect(abilities(replacement)).toEqual([])
    expect(mastery(replacement, 'range')).toBeUndefined()
  })

  it('rechecks shop privacy and restores live combat kits even before a stale poll refreshes', () => {
    let held: unknown
    vi.spyOn(ticker, 'usePolled').mockImplementation((read) => {
      held ??= read()
      return held as never
    })
    const s = newMatch()
    frame.localPlayer = 0
    s.phase = 'fight'
    s.round = 1
    s.scores[1].masteries.range = 1
    pushState(s, 0)
    s.pawns[0].alive = false
    // Next-round purchase while knocked out: visible to another spectator,
    // but it was not in this round's committed combat kit.
    s.pawns[1].slots[1] = 'teleport'
    s.pawns[1].levels[1] = 1
    s.scores[1].masteries.range = 4
    const dead = loadout(1)
    expect(abilities(dead)).toContain('teleport')
    expect(mastery(dead, 'range')).toBe('4')
    s.phase = 'shop'
    pushState(s, 1)
    const shop = loadout(1)
    expect(shop.attr('data-state')).toBe('lastRound')
    expect(abilities(shop)).not.toContain('teleport')
    expect(mastery(shop, 'range')).toBe('1')
    s.pawns[0].alive = true
    s.phase = 'fight'
    s.round = 2
    pushState(s, 2)
    const alive = loadout(1)
    expect(alive.attr('data-state')).toBe('live')
    expect(abilities(alive)).toContain('teleport')
    expect(mastery(alive, 'range')).toBe('4')
  })
})
