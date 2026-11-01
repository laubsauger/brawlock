import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type MatchSettings } from '../../sim'
import { renderMarkup, testId } from '../testing/markup'

vi.mock('../../game/session', () => ({ session: { updateSettings() {}, startLobbyVote() {} } }))
vi.mock('../../game/roomOptions', () => ({ rememberRoomOptions() {} }))
const { MatchOptions } = await import('./MatchOptions')

const render = (patch: Partial<MatchSettings>, editable = true) =>
  renderMarkup(createElement(MatchOptions, { settings: { ...DEFAULT_SETTINGS, ...patch }, editable }))
const disabled = (html: ReturnType<typeof render>, id: string) => {
  const controls = [...html.findAll(`${testId(id)} button`), ...html.findAll(`${testId(id)} input`)]
  return controls.length > 0 && controls.every((el) => el.attr('disabled') !== undefined)
}

/**
 * Why: Brisk casual's pace (five rounds, a compact arena, a faster ring) is also a custom game
 * option, so a room can playtest it. The lobby must show which pace a room plays, offer each
 * option only where the sim applies it, and keep ranked's fixed rules out of reach.
 */
describe('custom lobby pace options', () => {
  it('a classic room shows first to N, the classic arena and the 10 s ring', () => {
    const html = render({})
    expect(html.get(testId('match-length')).attr('data-state')).toBe('first-to')
    expect(html.get(testId('arena-size')).attr('data-state')).toBe('classic')
    expect(html.get(testId('shrink-seconds')).attr('data-value')).toBe('10')
    expect(disabled(html, 'arena-size')).toBe(false)
  })

  it('a Brisk room shows its five rounds, the compact arena and its ring', () => {
    const html = render({ scheduledRounds: 5, arenaCap: 15, shrinkSeconds: 7 })
    expect(html.get(testId('match-length')).attr('data-state')).toBe('scheduled')
    expect(html.get(testId('match-length')).attr('data-rounds')).toBe('5')
    expect(html.get(testId('arena-size')).attr('data-state')).toBe('compact')
    expect(html.get(testId('shrink-seconds')).attr('data-value')).toBe('7')
  })

  it('fixed rounds are free for all only; the arena options are Rounds mode only', () => {
    const teams = render({ teamMode: 'teams', scheduledRounds: 5 })
    expect(teams.get(testId('match-length')).attr('data-state')).toBe('first-to')
    expect(disabled(teams, 'match-length')).toBe(true)
    const dm = render({ gameMode: 'deathmatch' })
    expect(dm.find(testId('match-length'))).toBeUndefined()
    expect(disabled(dm, 'arena-size')).toBe(true)
    expect(disabled(dm, 'shrink-seconds')).toBe(true)
  })

  it('a ranked room shows no pace options at all', () => {
    const html = render({ rankedRounds: 5 }, false)
    expect(html.find(testId('match-length'))).toBeUndefined()
    expect(html.find(testId('arena-size'))).toBeUndefined()
    expect(html.find(testId('shrink-seconds'))).toBeUndefined()
  })
})
