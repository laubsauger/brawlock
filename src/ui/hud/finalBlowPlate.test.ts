import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { pushState, resetFrame } from '../../game/frame'
import { newMatch } from '../../sim/testkit'
import { renderMarkup, testId } from '../testing/markup'
import { FinalBlowPlate } from './FinalBlowPlate'

afterEach(resetFrame)

/** Why: the plate tells who hit whom while the deciding hit replays, and is gone otherwise. */
describe('Final Blow plate', () => {
  it('shows the replay kind and what it shows, with trait chips but no decider chips; nothing without a replay', () => {
    pushState(newMatch({}, 2))
    const html = renderMarkup(createElement(FinalBlowPlate, { view: { kind: 'match', hitter: 0, victim: 1, cause: 'fireball', traits: ['matchDecider', 'reflected', 'roundDecider'], partial: false } }))
    const plate = html.get(testId('final-blow'))
    expect(plate.attr('data-kind')).toBe('match')
    expect(plate.attr('data-state')).toBe('hit')
    expect(html.findAll('[data-trait]').map((el) => el.attr('data-trait'))).toEqual(['reflected'])
    const partial = renderMarkup(createElement(FinalBlowPlate, { view: { kind: 'round', hitter: 0, victim: 1, cause: 'obstacle', traits: [], partial: true } }))
    expect(partial.get(testId('final-blow')).attr('data-state')).toBe('death')
    expect(renderMarkup(createElement(FinalBlowPlate, { view: null })).find(testId('final-blow'))).toBeUndefined()
  })
})
