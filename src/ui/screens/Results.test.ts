import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGame, type MatchResult } from '../../game/store'
import { createMatch, DEFAULT_SETTINGS } from '../../sim'

vi.mock('../flow', () => ({ backToLobby() {}, leaveToMenu() {}, rematch() {}, setReady() {} }))
vi.mock('./Lobby', () => ({ AutoStart: () => null }))
vi.mock('../lib/replays', () => ({ useReplayIds: () => new Set(), watchReplay() {} }))
vi.mock('../lib/motion', () => ({ countTo() {}, reducedMotion: () => true }))
// as the itch.io build: accounts live on the site (accountsEnabled stays false in tests)
vi.mock('../../lib/site', async (original) => ({ ...await original<typeof import('../../lib/site')>(), SITE_HOST: 'brawlock.osc.link', openSite() {} }))
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
  it.each(['host', 'client'] as const)('keeps %s results readable and exposes readiness with a countdown opt-out', (role) => {
    present([1])
    useGame.getState().setLobby({ role, slots: useGame.getState().result!.slots, ready: { 1: true }, autoStart: { at: 10_000, fill: false } })
    const html = renderToStaticMarkup(createElement(Results))
    expect(html).toContain('data-testid="rematch-countdown"')
    expect(html).toContain('Keep reviewing results')
    expect(html).toContain('stop the countdown')
    expect(html).toContain('You can still opt out')
    expect(html).toContain('results-board')
    useGame.getState().setLobby({ ready: {}, autoStart: null })
    const reviewing = renderToStaticMarkup(createElement(Results))
    expect(reviewing).toContain('Take your time: nothing starts until you press Ready.')
    expect(reviewing).not.toContain('data-testid="rematch-countdown"')
  })

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

describe('final builds', () => {
  it('every row opens to its final build once the result carries builds; older results offer nothing to open', () => {
    const toggles = (html: string) => (html.match(/build and match stats/g) ?? []).length
    expect(toggles(present([1]))).toBe(0)
    const result = useGame.getState().result!
    useGame.setState({ result: { ...result, builds: result.slots.map((s) => ({ player: s.id, slots: Array(12).fill(null), levels: Array(12).fill(0) })) } })
    expect(toggles(renderToStaticMarkup(createElement(Results)))).toBe(4)
  })

  it('tells a guest of a build hosted elsewhere that an official game earns Embers once signed in on the site', () => {
    // itch players can't sign in there, so the result is where they learn what they missed
    expect(present([1])).not.toContain('data-testid="site-embers"')
    useGame.setState({ result: { ...useGame.getState().result!, progression: { matchId: 'm-1', status: 'awarded' } } })
    const html = renderToStaticMarkup(createElement(Results))
    expect(html).toContain('data-testid="site-embers"')
    expect(html).toContain('Signed in on brawlock.osc.link')
  })
})
