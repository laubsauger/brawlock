import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderMarkup, testId } from '../testing/markup'

vi.mock('../../game/session', () => ({ online: { configured: false } }))
vi.mock('../flow', () => ({ hostGame: vi.fn(), hostOnServer: vi.fn(), playOffline: vi.fn() }))
const saved: { wild?: boolean } = {}
vi.mock('../../game/roomOptions', () => ({ savedRoomOptions: () => saved, rememberRoomOptions: vi.fn() }))
const { PlaySetup } = await import('./PlaySetup')
afterEach(() => delete saved.wild)

/** Why: Wild was a switch deep in the lobby options, and players could not find how to make a Wild game (playtest 2026-11-02). */
describe('custom game setup', () => {
  it('offers Classic or Wild up front, showing the rules the next room opens with', () => {
    const classic = renderMarkup(createElement(PlaySetup, { onClose: () => {} }))
    expect(classic.get(testId('custom-rules')).attr('data-state')).toBe('classic')
    saved.wild = true
    const wild = renderMarkup(createElement(PlaySetup, { onClose: () => {} }))
    expect(wild.get(testId('custom-rules')).attr('data-state')).toBe('wild')
  })
})
