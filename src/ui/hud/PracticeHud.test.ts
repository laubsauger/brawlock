import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGame } from '../../game/store'
import { usePractice } from '../../game/practiceState'
import { PracticeScenario } from '../../game/practiceScenario'
import { frame, pushState, resetFrame } from '../../game/frame'
import { spellDef } from '../data/catalog'
import { renderMarkup, testId } from '../testing/markup'
import { PracticeHud } from './PracticeHud'
import { Shop } from './Shop'

vi.mock('../flow', () => ({ leaveToMenu: vi.fn(), playBotPractice: vi.fn() }))
vi.mock('../lib/media', () => ({ useMedia: () => false }))
vi.mock('../../game/store', async (original) => {
  const store = await original<typeof import('../../game/store')>()
  return { ...store, useGame: Object.assign((selector: (s: ReturnType<typeof store.useGame.getState>) => unknown) => selector(store.useGame.getState()), store.useGame) }
})
vi.mock('../../game/practiceState', async (original) => {
  const store = await original<typeof import('../../game/practiceState')>()
  return { ...store, usePractice: Object.assign((selector: (s: ReturnType<typeof store.usePractice.getState>) => unknown) => selector(store.usePractice.getState()), store.usePractice) }
})
const settings = useGame.getState().settings
afterEach(() => { usePractice.setState({ view: null }); useGame.setState({ settings }); resetFrame() })

const checklist = (html: ReturnType<typeof renderMarkup>) => html.findAll('[aria-label="Practice checklist"] li').map((li) => li.attr('data-state'))

describe('practice prompts and shop', () => {
  it('uses the current binding and cast mode rather than assuming quick cast', () => {
    usePractice.setState({ view: { step: 'fireball', retries: 0, target: null } })
    useGame.setState({ settings: { ...settings, keybinds: { item0: 'KeyU' }, castMode: 'normal' } })
    const html = renderMarkup(createElement(PracticeHud))
    const instruction = html.get(testId('practice-instruction'))
    expect(instruction.attr('data-cast-mode')).toBe('normal')
    expect(instruction.get('kbd').text).toBe('U')
    expect(checklist(html)).toEqual(['done', 'current', 'todo', 'todo', 'todo'])
  })
  it('keeps completion explicit and offers a bot game without auto-queueing', () => {
    usePractice.setState({ view: { step: 'complete', retries: 0, target: null } })
    const html = renderMarkup(createElement(PracticeHud))
    expect(html.find(testId('practice-bot-match'))).toBeDefined()
    expect(checklist(html)).toEqual(['done', 'done', 'done', 'done', 'done'])
  })
  it('reuses the real shop but highlights Teleport, disables other choices and removes the timer', () => {
    const lesson = new PracticeScenario({ name: 'Learner', color: null })
    lesson.state.phase = 'shop'
    frame.localPlayer = 0; pushState(lesson.state)
    const html = renderMarkup(createElement(Shop, { guidedSpell: 'teleport' }))
    const teleport = spellDef('teleport')!
    const guided = html.get('[data-guided]')
    expect(html.findAll('[data-guided]')).toHaveLength(1)
    expect(guided.text).toContain(teleport.name)
    expect(guided.text).toContain(String(teleport.buy))
    expect(guided.attr('data-state')).toBe('ok')
    const others = html.findAll('.spell-column [data-nav]').filter((tile) => tile !== guided)
    expect(others.length).toBeGreaterThan(0)
    expect(others.every((tile) => tile.attr('data-state') === 'locked')).toBe(true)
    expect(html.find(testId('shop-clock'))).toBeUndefined()
    expect(html.find('[aria-label="Masteries and items"]')).toBeUndefined()
    expect(html.findAll('[aria-label*="undefined"]')).toEqual([])
  })
})
