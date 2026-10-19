import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGame } from '../../game/store'
import { usePractice } from '../../game/practiceState'
import { PracticeScenario } from '../../game/practiceScenario'
import { frame, pushState, resetFrame } from '../../game/frame'
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

describe('practice prompts and shop', () => {
  it('uses the current binding and cast mode rather than assuming quick cast', () => {
    usePractice.setState({ view: { step: 'fireball', retries: 0, target: null } })
    useGame.setState({ settings: { ...settings, keybinds: { item0: 'KeyU' }, castMode: 'normal' } })
    const html = renderToStaticMarkup(createElement(PracticeHud))
    expect(html).toContain('then left-click')
    expect(html).toContain('>U</')
    expect(html).toContain('Move<span class="sr-only"> complete')
    expect(html).toContain('Leave practice')
  })
  it('keeps completion explicit and offers a bot game without auto-queueing', () => {
    usePractice.setState({ view: { step: 'complete', retries: 0, target: null } })
    const html = renderToStaticMarkup(createElement(PracticeHud))
    expect(html).toContain('Play a bot match')
    expect(html).toContain('Back to menu')
    expect(html.match(/class="sr-only"> complete/g)).toHaveLength(5)
  })
  it('reuses the real shop but highlights Teleport, disables other choices and removes the timer', () => {
    const lesson = new PracticeScenario({ name: 'Learner', color: null })
    lesson.state.phase = 'shop'
    frame.localPlayer = 0; pushState(lesson.state)
    const html = renderToStaticMarkup(createElement(Shop, { guidedSpell: 'teleport' }))
    expect(html).toContain('Practice · no timer')
    expect(html).toContain('Transport: choose one spell')
    expect(html).toContain('aria-label="Teleport, buy for 12 gold"')
    expect(html).toContain('ring-2 ring-gold')
    expect(html).toContain('Lightning, not part of this lesson')
    expect(html).not.toContain('aria-label="Masteries and items"')
    expect(html).not.toContain('undefined selected')
  })
})
