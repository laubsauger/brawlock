import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRankedControl, showRankedConflict } from '../../game/rankedControl'
import { RankedControlPrompt } from './RankedControlPrompt'

vi.mock('../../game/session', () => ({ session: { useRankedHere: vi.fn() }, online: { region: () => ({ label: 'Europe' }) } }))
vi.mock('../flow', () => ({ continueRankedHere: vi.fn() }))
vi.mock('../../game/rankedControl', async (original) => {
  const module = await original<typeof import('../../game/rankedControl')>()
  return { ...module, useRankedControl: Object.assign((selector: (s: ReturnType<typeof module.useRankedControl.getState>) => unknown) => selector(module.useRankedControl.getState()), module.useRankedControl) }
})
afterEach(() => useRankedControl.setState({ conflict: null }))
describe('ranked control conflict prompt', () => {
  it('offers an explicit transfer for the same account and states which connection will be replaced', () => {
    showRankedConflict({ kind: 'controller', game: { region: 'eu', room: 'ABCDE' } })
    const html = renderToStaticMarkup(createElement(RankedControlPrompt))
    expect(html).toContain('Use here')
    expect(html).toContain('Europe · Game ABCDE')
    expect(html).toContain('The other tab or device will disconnect')
    expect(html).toContain('scrim pointer-events-auto')
  })
  it('never offers to steal a different account’s ranked seat or accepts malformed conflict routes', () => {
    showRankedConflict({ kind: 'device', game: { region: 'eu', room: 'ABCDE' } })
    const html = renderToStaticMarkup(createElement(RankedControlPrompt))
    expect(html).not.toContain('Use here')
    expect(html).toContain('sign back into its account')
    expect(() => showRankedConflict({ kind: 'controller', game: { region: 'bad host', room: 'AAAAA' } })).toThrow('Invalid ranked session conflict')
  })
})
