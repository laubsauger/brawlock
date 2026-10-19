import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../game/session', () => ({ online: { configured: true }, session: {} }))
import { DetailedProfileStats, EloChange7d, Profile } from './Profile'
import { emptyTotals, type RecordedProfileCoverage, type RecordedProfileDetail } from '../../game/stats'
import * as stats from '../../game/stats'

describe('direct stats and replay entry points', () => {
  it.each([
    [14, '+14', 'text-heal'], [-7, '−7', 'text-[#ff9b8a]'], [0, '0', 'text-ash'],
  ] as const)('shows %s counted Elo over a rolling seven days with a signed, compact label', (change, value, color) => {
    const html = renderToStaticMarkup(createElement(EloChange7d, { change }))
    expect(html).toContain(`aria-label="${value} Elo over the last 7 days"`)
    expect(html).toContain(color)
    expect(html).toContain('Net Elo change over the last 7 days')
    expect(html).toContain('>7d</span>')
    expect(html).not.toContain('NaN')
  })
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

  it('makes each device leaderboard identity inspectable, including the local player', () => {
    const rows = vi.spyOn(stats, 'getLocalLeaderboard').mockReturnValue([
      { profileId: 'local-self', name: 'You', color: 0xffffff, kind: 'human', rating: 1500, games: 2, wins: 1, losses: 1, lastSeen: 1000, self: true },
      { profileId: 'local-rival', name: 'Rival', color: 0xffffff, kind: 'human', rating: 1500, games: 2, wins: 1, losses: 1, lastSeen: 1000, self: false },
    ])
    try {
      const html = renderToStaticMarkup(createElement(Profile, { onBack() {}, initialTab: 'board' }))
      expect(html).toContain('aria-label="View recorded stats for You"')
      expect(html).toContain('aria-label="View recorded stats for Rival"')
      expect(html).not.toContain('View public profile')
    } finally { rows.mockRestore() }
  })

  it.each(['matches', 'stats'] as const)('keeps the career summary inside %s content, after the shared tab bar', (initialTab) => {
    const html = renderToStaticMarkup(createElement(Profile, { onBack() {}, initialTab }))
    const panel = html.indexOf('data-testid="profile-panel"')
    const tabs = html.indexOf('role="tablist"')
    const content = html.indexOf('id="profile-content"')
    const career = html.indexOf('aria-label="Career summary"')
    expect(panel).toBeGreaterThan(-1)
    expect(tabs).toBeGreaterThan(panel)
    expect(content).toBeGreaterThan(tabs)
    expect(career).toBeGreaterThan(content)
    expect(html).toContain(`aria-labelledby="profile-tab-${initialTab}"`)
    expect(html).toContain('Against players')
    expect(html).toContain('Against bots')
  })

  it.each(['rivals', 'board', 'replays'] as const)('retains the same tab panel without unrelated career tiles on %s', (initialTab) => {
    const html = renderToStaticMarkup(createElement(Profile, { onBack() {}, initialTab }))
    expect(html).toContain('data-testid="profile-panel"')
    expect(html).toContain('aria-label="Profile sections"')
    expect(html).toContain(`aria-labelledby="profile-tab-${initialTab}"`)
    expect(html).not.toContain('aria-label="Career summary"')
  })
})

describe('recorded profile detail', () => {
  const coverage: RecordedProfileCoverage = { detailedMatches: 2, totalMatches: 8, firstDetailedAt: 1000, lastDetailedAt: 2000 }

  it('states missing historical coverage without inventing zero-valued combat or economy stats', () => {
    const html = renderToStaticMarkup(createElement(DetailedProfileStats, { coverage: { ...coverage, detailedMatches: 0, firstDetailedAt: null, lastDetailedAt: null }, detail: null, source: 'server' }))
    expect(html).toContain('0 of 8 ranked matches have detailed stats')
    expect(html).toContain('No detailed stats are available')
    expect(html).toContain('Earlier matches have results only')
    expect(html).not.toContain('Gold earned')
    expect(html).not.toContain('Spell by spell')
    expect(html).not.toContain('Hall of Fame')
  })

  it('shows the same full spell, economy and personal-best groups with server coverage and bot scope explicit', () => {
    const totals = emptyTotals()
    Object.assign(totals, { casts: 10, hits: 4, goldEarned: 24, goldSpent: 13, killsByCause: { fireball: 3 } })
    const detail: RecordedProfileDetail = { matches: 2, seconds: 200, damage: 451, totals, spells: { fireball: [10, 4] }, hallOfFame: { mostDamage: { value: 300, date: 1000, matchId: 'foreign-server-match-37' } } }
    const html = renderToStaticMarkup(createElement(DetailedProfileStats, { coverage, detail, source: 'server' }))
    expect(html).toContain('Recorded by the game server')
    expect(html).toContain('2 of 8 ranked matches have detailed stats')
    expect(html).toContain('These combat details include bots; ranked K/D excludes bot combat')
    for (const label of ['Movement', 'Combat', 'Spells', 'Survival', 'Economy', 'Spell by spell', 'Hall of Fame', 'Gold earned', 'Gold spent']) expect(html).toContain(label)
    expect(html).toContain('10 casts · 4 hits · 40%')
    expect(html).toContain('>24</dd>')
    expect(html).toContain('>13</dd>')
    expect(html).not.toContain('foreign-server-match-37')
    expect(html).not.toContain('<button') // Foreign Hall IDs never open a local match.
  })

  it('labels local rival detail as retained device records rather than a global career', () => {
    const html = renderToStaticMarkup(createElement(DetailedProfileStats, { coverage, detail: null, source: 'device' }))
    expect(html).toContain('Recorded on this device')
    expect(html).toContain('2 of 8 stored matches have detailed stats')
    expect(html).toContain('latest 30 matches on this device')
    expect(html).not.toContain('Recorded by the game server')
  })
})
