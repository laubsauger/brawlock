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

/**
 * Why: Wild is a custom-lobby ruleset (docs/moonshot/specs/wild.md): the owner switches it on and
 * picks the omen deck. It applies only where the sim runs it (classic Rounds outside ranked), and
 * a deck with no omen would be Wild with nothing to draw, so the last omen cannot be switched off.
 */
describe('custom lobby Wild options', () => {
  const omens = (html: ReturnType<typeof render>) => html.findAll(testId('wild-omen')).map((el) => [el.attr('data-omen'), el.attr('data-state')])

  it('off by default, with no deck shown', () => {
    const html = render({})
    expect(html.get(testId('wild')).attr('data-state')).toBe('off')
    expect(omens(html)).toEqual([])
  })

  it('on, it shows the deck with each omen on or off as the room has it', () => {
    const html = render({ wild: true, wildOmens: 0b100001 })
    expect(html.get(testId('wild')).attr('data-state')).toBe('on')
    expect(omens(html)).toEqual([
      ['bloodMoon', 'on'], ['slickStone', 'off'], ['overcharge', 'off'], ['suddenCollapse', 'off'], ['meteorShower', 'off'], ['pillarStorm', 'on'],
    ])
    expect(html.findAll(`${testId('wild-omen')} button`).every((el) => el.attr('disabled') === undefined)).toBe(true)
  })

  it('the last omen in the deck cannot be switched off', () => {
    const html = render({ wild: true, wildOmens: 0b000100 })
    const locked = html.findAll(testId('wild-omen')).filter((el) => el.find('button')?.attr('disabled') !== undefined)
    expect(locked.map((el) => el.attr('data-omen'))).toEqual(['overcharge'])
  })

  it('Rounds mode only, and never in ranked', () => {
    const dm = render({ gameMode: 'deathmatch', wild: true })
    expect(dm.get(testId('wild')).attr('data-state')).toBe('off')
    expect(disabled(dm, 'wild')).toBe(true)
    expect(omens(dm)).toEqual([])
    expect(render({ rankedRounds: 5, wild: true }, false).find(testId('wild'))).toBeUndefined()
  })
})
