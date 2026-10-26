import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { usePlayControl } from '../../game/playControl'
import { renderMarkup, testId } from '../testing/markup'
import { PlayControlPrompt } from './PlayControlPrompt'

vi.mock('../../game/playControl', async (original) => {
  const module = await original<typeof import('../../game/playControl')>()
  return { ...module, usePlayControl: Object.assign((selector: (s: ReturnType<typeof module.usePlayControl.getState>) => unknown) => selector(module.usePlayControl.getState()), module.usePlayControl) }
})
afterEach(() => usePlayControl.setState({ conflict: null }))
/** what "Use here" does to the other session, as the prompt states it */
const effect = () => renderMarkup(createElement(PlayControlPrompt)).get(testId('play-control-effect')).attr('data-state')
it('explains all-mode exclusivity and warns before ending a player-hosted game', () => {
  usePlayControl.setState({ conflict: { id: 'local', kind: 'device', sameAccount: false, target: { mode: 'host', region: null, code: 'ABCDE' } } })
  expect(effect()).toBe('end-hosted')
  expect(renderMarkup(createElement(PlayControlPrompt)).find(testId('use-here'))).toBeDefined()
})
it('offers to reopen the existing casual game and distinguishes local restarts', () => {
  usePlayControl.setState({ conflict: { id: 'lease', kind: 'account', sameAccount: true, target: { mode: 'casual', region: 'eu', code: 'ABCDE' } } })
  expect(effect()).toBe('reopen')
  usePlayControl.setState({ conflict: { id: 'local', kind: 'device', sameAccount: false, target: { mode: 'practice', region: null, code: null } } })
  expect(effect()).toBe('restart')
})
