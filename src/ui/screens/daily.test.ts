import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { LAUNCH_DAY, defineDay } from '../../game/daily/calendar'
import type { DailyOutcome } from '../../game/daily/play'
import { renderMarkup, testId } from '../testing/markup'
import { DailyResult, dailyTime, shareText } from './Daily'

/** Why: the result must say whether the run counts (pending, verified, why not), never guess. */
const day = defineDay(LAUNCH_DAY + 2)
const outcome = (over: Partial<DailyOutcome>): DailyOutcome => ({
  day, result: { waves: 3, timeTicks: 30 * 95, bountyKos: 2, fightTicks: 30 * 120, endTick: 9000, ended: 'lost' }, state: 'pending', ...over,
})

describe('daily result', () => {
  it('shows its state as data, and the server’s score once verified', () => {
    for (const state of ['pending', 'retry', 'rejected', 'unranked', 'offline'] as const) {
      expect(renderMarkup(createElement(DailyResult, { outcome: outcome({ state }) })).get(testId('daily-result')).attr('data-state')).toBe(state)
    }
    const verified = outcome({ state: 'verified', verified: { status: 'verified', waves: 4, time: 30 * 80, bounty: 1, rank: 2, players: 9, listed: true, best: null, streak: { count: 5, smoulder: false }, reward: { embers: 15, balance: 120, day: 5 } } })
    const html = renderMarkup(createElement(DailyResult, { outcome: verified }))
    expect(html.get('[data-waves]').attr('data-waves')).toBe('4')
    expect(html.find(testId('daily-reward'))).toBeDefined()
    expect(html.find(testId('daily-claim'))).toBeUndefined()
    // a guest's verified run offers the claim
    const guest = { ...verified, verified: { ...verified.verified!, listed: false, reward: null } }
    expect(renderMarkup(createElement(DailyResult, { outcome: guest, onClaim: () => {} })).find(testId('daily-claim'))).toBeDefined()
  })

  it('formats time as m:ss.t and shares three lines', () => {
    expect(dailyTime(30 * 192.6)).toBe('3:12.6')
    expect(dailyTime(0)).toBe('0:00.0')
    const lines = shareText(day, 4, 30 * 192.6, undefined).split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[1].startsWith('■■■■□')).toBe(true)
  })
})
