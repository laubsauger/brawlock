import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDaily } from '../../game/daily/play'
import { RULES_V2_FROM, defineDay } from '../../game/daily/calendar'
import { renderMarkup, testId } from '../testing/markup'
import { DailyHud } from './DailyHud'

vi.mock('../../game/daily/play', async (original) => {
  const store = await original<typeof import('../../game/daily/play')>()
  return { ...store, useDaily: Object.assign((selector: (s: ReturnType<typeof store.useDaily.getState>) => unknown) => selector(store.useDaily.getState()), store.useDaily) }
})
afterEach(() => useDaily.setState({ run: null }))

/**
 * Why: once the run starts, the Daily screen's information (the omen, the waves, the champion, how
 * the bounty pays) was gone (playtest 2026-11-02). The HUD card opens it as a briefing.
 */
describe('daily HUD briefing', () => {
  it('lists every wave with the current one marked, and names the bounty spell and the lives', () => {
    const day = defineDay(RULES_V2_FROM + 1)
    useDaily.setState({ run: { day, wave: 2, lives: 3, bountyKos: 1, phase: 'fight', ranked: true } })
    const html = renderMarkup(createElement(DailyHud))
    const briefing = html.get(testId('daily-briefing'))
    expect(briefing.findAll('li').map((li) => li.attr('data-state'))).toEqual(['cleared', 'cleared', 'current', 'next', 'next', 'next'])
    expect(html.get(testId('daily-hud')).attr('data-lives')).toBe('3')
    expect(html.findAll('.daily-life')).toHaveLength(3)
  })
})
