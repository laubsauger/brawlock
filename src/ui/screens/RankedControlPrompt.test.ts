import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRankedControl, showRankedConflict } from '../../game/rankedControl'
import { renderMarkup, testId } from '../testing/markup'
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
    const dialog = renderMarkup(createElement(RankedControlPrompt)).get('[role="dialog"]')
    expect(dialog.find(testId('use-here'))).toBeDefined()
    // names the game being moved: region and room
    expect(dialog.text).toContain('Europe')
    expect(dialog.text).toContain('ABCDE')
    // App renders prompts inside a pointer-events-none layer; the modal's scrim must take clicks back
    expect(dialog.parent!.attr('class')!.split(' ')).toContain('pointer-events-auto')
  })
  it('never offers to steal a different account’s ranked seat or accepts malformed conflict routes', () => {
    showRankedConflict({ kind: 'device', game: { region: 'eu', room: 'ABCDE' } })
    const dialog = renderMarkup(createElement(RankedControlPrompt)).get('[role="dialog"]')
    expect(dialog.find(testId('use-here'))).toBeUndefined()
    expect(() => showRankedConflict({ kind: 'controller', game: { region: 'bad host', room: 'AAAAA' } })).toThrow('Invalid ranked session conflict')
  })
})
