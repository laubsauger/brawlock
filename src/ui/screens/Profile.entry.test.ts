import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../game/session', () => ({ online: { configured: true }, session: {} }))
import { Profile } from './Profile'

describe('direct stats and replay entry points', () => {
  it('opens the global leaderboard directly when requested', () => {
    const html = renderToStaticMarkup(createElement(Profile, { onBack() {}, initialTab: 'board', initialBoardScope: 'global' }))
    expect(html).toContain('data-testid="global-board"')
    expect(html).toContain('Loading the leaderboard')
  })

  it('exposes replay import immediately, before any saved-library or match-history data loads', () => {
    const html = renderToStaticMarkup(createElement(Profile, { onBack() {}, initialTab: 'replays' }))
    expect(html).toContain('Watch replay')
    expect(html).toContain('data-testid="replay-library"')
    expect(html).toContain('Import replay')
    expect(html).toContain('aria-label="Import replay file"')
    expect(html).toContain('accept=".brawlock"')
    expect(html).toContain('Loading saved replays')
    expect(html).not.toContain('Time in the arena')
  })

  it('preserves the existing profile default entry', () => {
    const html = renderToStaticMarkup(createElement(Profile, { onBack() {} }))
    expect(html).toContain('Your record')
    expect(html).toContain('No matches yet')
    expect(html).not.toContain('data-testid="global-board"')
    expect(html).not.toContain('data-testid="replay-library"')
  })
})
