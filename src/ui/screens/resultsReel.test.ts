import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { pushState, resetFrame } from '../../game/frame'
import type { Moment } from '../../game/moments'
import { newMatch } from '../../sim/testkit'
import { renderMarkup, testId } from '../testing/markup'
import { ResultsReel, momentLabel } from './ResultsReel'

afterEach(resetFrame)

const moment = (over: Partial<Moment>): Moment => ({
  id: 0, kind: 'knockout', traits: [], round: 2, tick: 10, end: 20, from: 5, to: 25, actors: [0], victims: [1], cause: 'fireball', count: 1, score: 1.5,
  camera: { subject: 101, other: 100, x: 0, y: 0, dirX: 1, dirY: 0 }, final: true, ...over,
})

/** Why: highlights replace the board while they play, and say which moment of how many is on. */
describe('results reel overlay', () => {
  it('shows its state, position and count while playing, and nothing otherwise', () => {
    pushState(newMatch({}, 2))
    const playing = { state: 'playing' as const, index: 1, count: 3, closed: false, available: true }
    const html = renderMarkup(createElement(ResultsReel, { title: 'Victory', view: playing, moment: moment({ traits: ['reflected', 'roundDecider'] }) }))
    const el = html.get(testId('results-reel'))
    expect([el.attr('data-state'), el.attr('data-index'), el.attr('data-count')]).toEqual(['playing', '1', '3'])
    expect(html.findAll('[data-trait]').map((x) => x.attr('data-trait'))).toEqual(['reflected'])
    expect(html.find(testId('reel-skip'))).toBeDefined()
    const done = { ...playing, state: 'done' as const, index: 2 }
    expect(renderMarkup(createElement(ResultsReel, { title: 'Victory', view: done, moment: null })).find(testId('results-reel'))).toBeUndefined()
  })

  it('names each kind of moment', () => {
    expect(momentLabel(moment({ traits: ['matchDecider', 'roundDecider'] }))).toBe('Final blow')
    expect(momentLabel(moment({ kind: 'multiKnockout', count: 3 }))).toBe('Triple knockout')
    expect(momentLabel(moment({ kind: 'clutch', count: 2 }))).toBe('Clutch 1v2')
  })
})
