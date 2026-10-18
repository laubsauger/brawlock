import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGame, type MatchResult } from '../../game/store'
import { createMatch, DEFAULT_SETTINGS } from '../../sim'

vi.mock('../flow', () => ({ backToLobby() {}, leaveToMenu() {}, rematch() {}, setReady() {} }))
vi.mock('./Lobby', () => ({ AutoStart: () => null }))
vi.mock('../lib/replays', () => ({ useReplayIds: () => new Set(), watchReplay() {} }))
vi.mock('../lib/motion', () => ({ countTo() {}, reducedMotion: () => true }))
vi.mock('../../game/store', async (original) => {
  const store = await original<typeof import('../../game/store')>()
  const current = (selector: (value: ReturnType<typeof store.useGame.getState>) => unknown) => selector(store.useGame.getState())
  return { ...store, useGame: Object.assign(current, store.useGame) }
})
import { Results } from './Results'

const initial = useGame.getState()
afterEach(() => useGame.setState(initial))

function present(winners: number[]): string {
  const state = createMatch(DEFAULT_SETTINGS, ['Final loser', 'Champion', 'Third place', 'Fourth place'].map((name, id) => ({
    id, name, kind: 'human', team: id, color: 0xffa044,
  })), 42)
  state.scores.forEach((score, id) => {
    score.score = [2, 2, 1, 0][id]
    score.kills = [20, 1, 0, 10][id]
  })
  const result: MatchResult = { winners, slots: state.slots, scores: state.scores, rounds: 6 }
  useGame.setState({ result, lobby: { ...initial.lobby, localPlayer: 1, role: 'offline' } })
  return renderToStaticMarkup(createElement(Results))
}

describe('final-round results', () => {
  it('puts the final winner first while preserving scoring wins and normal standings for everyone else', () => {
    const html = present([1])
    expect(html).toContain('Victory')
    const board = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'))
    const rows = [...board.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/g)].map((match) => match[1])
    expect(rows).toHaveLength(4)
    expect(rows[0]).toContain('Champion')
    expect(rows[0]).toContain('aria-label="Winner"')
    expect(rows[0]).toMatch(/text-gold[^>]*><span>2<\/span>/)
    expect(rows[1]).toContain('Final loser')
    expect(rows[1]).toMatch(/text-gold[^>]*><span>2<\/span>/)
    expect(rows[2]).toContain('Third place')
    expect(rows[3]).toContain('Fourth place')
  })

  it('shows a bounded final draw as shared champions rather than inventing a scoring win', () => {
    const html = present([0, 1])
    const board = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'))
    expect((board.match(/aria-label="Winner"/g) ?? [])).toHaveLength(2)
    expect(html).toContain('Victory')
    expect(html).not.toContain('Nobody took the match')
    expect((board.match(/text-gold[^>]*><span>2<\/span>/g) ?? [])).toHaveLength(2)
  })
})
