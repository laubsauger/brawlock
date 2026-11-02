import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { pushState, resetFrame } from '../../game/frame'
import { createMatch, DEFAULT_SETTINGS } from '../../sim'
import type { OmenId } from '../../sim'
import { renderMarkup, testId } from '../testing/markup'
import { OmenBadge } from './OmenHud'

afterEach(() => resetFrame())

function fightUnder(omens: OmenId[]): void {
  const s = createMatch({ ...DEFAULT_SETTINGS, wild: true }, [0, 1].map((id) => ({ id, name: `P${id}`, kind: 'human' as const, team: id, color: 0xffa044 })), 3)
  s.phase = 'fight'
  s.omens = omens
  pushState(s)
}

/**
 * Why: the card in the countdown went by too fast to read what a round's omens do (playtest
 * 2026-11-02); the badges under the clock open a briefing that says it for each of them.
 */
describe('omen badges', () => {
  it('list each omen of the round and open a briefing with what each does', () => {
    fightUnder(['cursedBomb', 'gale'])
    const html = renderMarkup(createElement(OmenBadge))
    expect(html.findAll(testId('omen-badge')).map((b) => b.attr('data-omen'))).toEqual(['cursedBomb', 'gale'])
    const briefing = html.get(testId('omen-briefing'))
    expect(briefing.findAll('li').map((li) => li.attr('data-omen'))).toEqual(['cursedBomb', 'gale'])
    expect(html.get(testId('omen-badges')).attr('tabindex')).toBe('0')
  })
  it('say when a round is a Cataclysm', () => {
    fightUnder(['bloodMoon', 'cursedBomb', 'spirits'])
    const html = renderMarkup(createElement(OmenBadge))
    expect(html.get(testId('omen-badges')).attr('data-count')).toBe('3')
    expect(html.find(testId('omen-cataclysm'))).toBeDefined()
    fightUnder(['gale'])
    expect(renderMarkup(createElement(OmenBadge)).find(testId('omen-cataclysm'))).toBeUndefined()
  })
})
