import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGame } from '../../game/store'
import { frame, pushState, resetFrame } from '../../game/frame'
import { createMatch, DEFAULT_SETTINGS } from '../../sim'
import { renderMarkup, testId } from '../testing/markup'
import { RemapTip } from './RemapTip'

vi.mock('../../game/store', async (original) => {
  const store = await original<typeof import('../../game/store')>()
  return { ...store, useGame: Object.assign((selector: (s: ReturnType<typeof store.useGame.getState>) => unknown) => selector(store.useGame.getState()), store.useGame) }
})
const settings = useGame.getState().settings
afterEach(() => { useGame.setState({ settings }); resetFrame() })

function enterMatch(local: number): void {
  pushState(createMatch(DEFAULT_SETTINGS, [0, 1].map((id) => ({ id, name: `P${id}`, kind: 'human' as const, team: id, color: 0xffa044 })), 7))
  frame.localPlayer = local
}

/**
 * Why: new players did not know slot keys can be moved during a match (playtest 2026-11-02).
 * The note shows to a player who has never seen it or moved a key, and never nags again.
 */
describe('remap tip', () => {
  it('shows a first-timer, with a way to dismiss it', () => {
    enterMatch(0)
    const html = renderMarkup(createElement(RemapTip))
    expect(html.find(testId('remap-tip'))).toBeDefined()
    expect(html.find(testId('remap-tip-dismiss'))).toBeDefined()
  })
  it('stays gone once dismissed, and for anyone who already moved a slot key', () => {
    enterMatch(0)
    useGame.setState({ settings: { ...settings, remapTipSeen: true } })
    expect(renderMarkup(createElement(RemapTip)).find(testId('remap-tip'))).toBeUndefined()
    useGame.setState({ settings: { ...settings, keybinds: { spell0: 'KeyR', spell1: 'KeyE' } } })
    expect(renderMarkup(createElement(RemapTip)).find(testId('remap-tip'))).toBeUndefined()
  })
  it('is not shown to a spectator, who has no action bar to remap', () => {
    enterMatch(5)
    expect(renderMarkup(createElement(RemapTip)).find(testId('remap-tip'))).toBeUndefined()
  })
})
