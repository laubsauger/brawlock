import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { usePlayControl } from '../../game/playControl'
import { PlayControlPrompt } from './PlayControlPrompt'

vi.mock('../../game/playControl', async (original) => {
  const module = await original<typeof import('../../game/playControl')>()
  return { ...module, usePlayControl: Object.assign((selector: (s: ReturnType<typeof module.usePlayControl.getState>) => unknown) => selector(module.usePlayControl.getState()), module.usePlayControl) }
})
afterEach(() => usePlayControl.setState({ conflict: null }))
it('explains all-mode exclusivity and warns before ending a player-hosted game', () => {
  usePlayControl.setState({ conflict: { id: 'local', kind: 'device', sameAccount: false, target: { mode: 'host', region: null, code: 'ABCDE' } } })
  const html = renderToStaticMarkup(createElement(PlayControlPrompt))
  expect(html).toContain('One game at a time per account or browser')
  expect(html).toContain('Other players in that hosted game will disconnect')
  expect(html).toContain('Use here')
  expect(html).not.toContain('ranked game')
})
it('offers to reopen the existing casual game and distinguishes local restarts', () => {
  usePlayControl.setState({ conflict: { id: 'lease', kind: 'account', sameAccount: true, target: { mode: 'casual', region: 'eu', code: 'ABCDE' } } })
  expect(renderToStaticMarkup(createElement(PlayControlPrompt))).toContain('reopen that game here')
  usePlayControl.setState({ conflict: { id: 'local', kind: 'device', sameAccount: false, target: { mode: 'practice', region: null, code: null } } })
  expect(renderToStaticMarkup(createElement(PlayControlPrompt))).toContain('Local games restart when moved')
})
