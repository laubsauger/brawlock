import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { pushState, frame, resetFrame } from '../../game/frame'
import { step } from '../../sim'
import { cmd, newMatch, toCombat } from '../../sim/testkit'
import type { SimState } from '../../sim/types'
import { renderMarkup, testId } from '../testing/markup'
import { ResetBuildButton, TakeoverOffer } from './Shop'
import { readShop } from './shopView'

afterEach(resetFrame)

/** Seat 0 has bought a build in the first shop; `takeover` hands it over from a bot this round. */
function bought(takeover: boolean, settings = {}): SimState {
  const s = newMatch({ startGold: 100, ...settings })
  step(s, [cmd(0, { kind: 'buySpell', spell: 'teleport' }, { kind: 'buyItem', item: 'ring_of_health' })])
  if (takeover) s.slots[0] = { ...s.slots[0], takeover: s.round }
  return s
}
/** the header button and the takeover offer, as the local seat sees them */
function shop(s: SimState) {
  frame.localPlayer = 0
  pushState(s)
  const view = readShop()
  const onOpen = () => {}
  return { view, html: renderMarkup(createElement('div', null, createElement(ResetBuildButton, { view, onOpen }), createElement(TakeoverOffer, { view, onOpen }))) }
}

/** Why: a player who takes a bot's seat must see that its build can go back for free; the
 * playtest found the old "Fresh start · worth N gold" label read as neither reset nor free. */
describe('Reset build in the shop', () => {
  it('a seat taken over from a bot is offered its whole build back, free, once, above the spells', () => {
    const { view, html } = shop(bought(true))
    expect(view.spent).toBeGreaterThan(0)
    expect(html.find(testId('takeover-offer'))).toBeDefined()
    // one entry point: the offer's button, not a second one in the header
    expect(html.findAll(testId('reset-build'))).toHaveLength(1)
    expect(html.get(`${testId('takeover-offer')} ${testId('reset-build')}`).attr('data-state')).toBe('free')
    expect(html.get(testId('reset-build')).attr('data-refund')).toBe(String(view.spent))
  })

  it('any other seat sees the paid reset with its refund, and no takeover offer', () => {
    const { view, html } = shop(bought(false))
    expect(view.refund).toBeLessThan(view.spent)
    expect(html.get(testId('reset-build')).attr('data-state')).toBe('paid')
    expect(html.get(testId('reset-build')).attr('data-refund')).toBe(String(view.refund))
    expect(html.find(testId('takeover-offer'))).toBeUndefined()
  })

  it('is gone once the fight starts, in ranked, and before anything was bought', () => {
    const fighting = bought(true)
    toCombat(fighting)
    for (const s of [fighting, bought(true, { rankedRounds: 5 }), newMatch()]) {
      const { html } = shop(s)
      expect(html.find(testId('reset-build'))).toBeUndefined()
      expect(html.find(testId('takeover-offer'))).toBeUndefined()
    }
  })
})
