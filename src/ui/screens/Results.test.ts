import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGame, type MatchResult } from '../../game/store'
import { createMatch, DEFAULT_SETTINGS } from '../../sim'
import { parseMarkup, renderMarkup, testId } from '../testing/markup'

vi.mock('../flow', () => ({ backToLobby() {}, leaveToMenu() {}, rematch() {}, setReady() {} }))
vi.mock('./Lobby', () => ({ AutoStart: () => null }))
vi.mock('../lib/replays', () => ({ useReplayIds: () => new Set(), watchReplay() {} }))
vi.mock('../lib/motion', () => ({ countTo() {}, reducedMotion: () => true }))
// as the itch.io build: no accounts here, they live on the site (release tests run with accounts enabled)
vi.mock('../../game/account', async (original) => ({ ...await original<typeof import('../../game/account')>(), accountsEnabled: false }))
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
    const html = renderMarkup(createElement(Results))
    expect(html.find(testId('results-board'))).toBeDefined()
    expect(html.find(testId('rematch-countdown'))).toBeDefined()
    // ready, and pressing it again opts out of the countdown
    expect(html.get(testId('custom-rematch-ready')).attr('aria-pressed')).toBe('true')
    expect(html.get(testId('rematch-ready-status')).attr('data-state')).toBe('countdown')
    useGame.getState().setLobby({ ready: {}, autoStart: null })
    const reviewing = renderMarkup(createElement(Results))
    expect(reviewing.get(testId('rematch-ready-status')).attr('data-state')).toBe('reviewing')
    expect(reviewing.find(testId('rematch-countdown'))).toBeUndefined()
  })

  it('puts the final winner first while preserving scoring wins and normal standings for everyone else', () => {
    const html = parseMarkup(present([1]))
    expect(html.get('h1').attr('data-outcome')).toBe('victory')
    const rows = html.findAll('tbody tr')
    expect(rows.map((row) => row.get('td').text)).toEqual(['Champion', 'Final loser', 'Third place', 'Fourth place'].map((name) => expect.stringContaining(name)))
    expect(rows.map((row) => row.find('[aria-label="Winner"]') !== undefined)).toEqual([true, false, false, false])
    expect(rows.map((row) => row.findAll('td')[1].text)).toEqual(['2', '2', '1', '0'])
  })

  it('shows a bounded final draw as shared champions rather than inventing a scoring win', () => {
    const html = parseMarkup(present([0, 1]))
    expect(html.get('h1').attr('data-outcome')).toBe('victory')
    const rows = html.findAll('tbody tr')
    expect(rows.filter((row) => row.find('[aria-label="Winner"]'))).toHaveLength(2)
    expect(rows.map((row) => row.findAll('td')[1].text)).toEqual(['2', '2', '1', '0'])
  })
})

describe('final builds', () => {
  it('every row opens to its final build once the result carries builds; older results offer nothing to open', () => {
    const toggles = (html: string) => parseMarkup(html).findAll('tbody button[aria-expanded]').length
    expect(toggles(present([1]))).toBe(0)
    const result = useGame.getState().result!
    useGame.setState({ result: { ...result, builds: result.slots.map((s) => ({ player: s.id, slots: Array(12).fill(null), levels: Array(12).fill(0) })) } })
    expect(toggles(renderToStaticMarkup(createElement(Results)))).toBe(4)
  })

  it('tells a guest of a build hosted elsewhere that an official game earns Embers once signed in on the site', () => {
    // itch players can't sign in there, so the result is where they learn what they missed
    expect(parseMarkup(present([1])).find(testId('site-embers'))).toBeUndefined()
    useGame.setState({ result: { ...useGame.getState().result!, progression: { matchId: 'm-1', status: 'awarded' } } })
    const prompt = renderMarkup(createElement(Results)).get(testId('site-embers'))
    expect(prompt.text).toContain('brawlock.osc.link')
  })
})
