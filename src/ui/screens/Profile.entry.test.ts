import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const onlineConfig = vi.hoisted(() => ({ configured: true }))
vi.mock('../../game/session', () => ({ online: onlineConfig, session: {} }))
import { combatKD, DetailedProfileStats, EloChange7d, Profile } from './Profile'
import { emptyTotals, mergeRecordedDetail, type RecordedProfileCoverage, type RecordedProfileDetail } from '../../game/stats'
import * as stats from '../../game/stats'
import { renderMarkup, testId } from '../testing/markup'

describe('direct stats and replay entry points', () => {
  it.each([
    [14, '+14', 'up'], [-7, '−7', 'down'], [0, '0', 'flat'],
  ] as const)('shows %s counted Elo over a rolling seven days with a signed, compact label', (change, value, trend) => {
    const label = renderMarkup(createElement(EloChange7d, { change })).get('[data-trend]')
    expect(label.attr('data-trend')).toBe(trend)
    expect(label.attr('aria-label')!.startsWith(`${value} `)).toBe(true)
    expect(label.text.startsWith(`${value} `)).toBe(true)
    expect(label.text).not.toContain('NaN')
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

  it('opens online history by default in server builds', () => {
    const html = renderToStaticMarkup(createElement(Profile, { onBack() {} }))
    expect(html).toContain('Your record')
    expect(html).toContain('Loading online matches')
    expect(html).toContain('aria-label="Match history source"')
    expect(html).toContain('aria-label="Match queue"')
    expect(html).not.toContain('aria-label="Career summary"')
    expect(html).not.toContain('data-testid="global-board"')
    expect(html).not.toContain('data-testid="replay-library"')
  })

  it('keeps local match history and career totals available in offline builds', () => {
    onlineConfig.configured = false
    try {
      const html = renderToStaticMarkup(createElement(Profile, { onBack() {} }))
      expect(html).toContain('No matches yet')
      expect(html).toContain('aria-label="Career summary"')
      expect(html).not.toContain('Loading online matches')
    } finally { onlineConfig.configured = true }
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

  it.each(['stats'] as const)('keeps the career summary inside %s content, after the shared tab bar', (initialTab) => {
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
  const render = (props: Partial<Parameters<typeof DetailedProfileStats>[0]>) =>
    renderMarkup(createElement(DetailedProfileStats, { coverage, detail: null, source: 'server', ...props })).get(testId('recorded-profile-stats'))
  const covered = (root: ReturnType<typeof render>) => root.get(testId('profile-coverage')).text
  const facts = (root: ReturnType<typeof render>) => root.findAll('dd').map((dd) => dd.text)

  it('states missing historical coverage without inventing zero-valued combat or economy stats', () => {
    const root = render({ coverage: { ...coverage, detailedMatches: 0, firstDetailedAt: null, lastDetailedAt: null } })
    expect(root.attr('data-state')).toBe('empty')
    expect(covered(root)).toContain('0 of 8')
    expect(facts(root)).toEqual([])
    expect(root.find('[data-hall]')).toBeUndefined()
  })

  it('shows the same full spell, economy and personal-best groups with server coverage and bot scope explicit', () => {
    const totals = emptyTotals()
    Object.assign(totals, { casts: 10, hits: 4, goldEarned: 24, goldSpent: 13, killsByCause: { fireball: 3 } })
    const detail: RecordedProfileDetail = { matches: 2, seconds: 200, damage: 451, totals, spells: { fireball: [10, 4] }, hallOfFame: { mostDamage: { value: 300, date: 1000, matchId: 'foreign-server-match-37' } } }
    const root = render({ detail })
    expect(root.attr('data-source')).toBe('server')
    expect(root.attr('data-state')).toBe('detail')
    expect(covered(root)).toContain('2 of 8')
    // the same groups as retained device records
    const groups = (r: ReturnType<typeof render>) => r.findAll('h3').map((h) => h.text)
    expect(groups(root)).toEqual(groups(render({ detail, source: 'device' })))
    expect(root.find('[data-hall="mostDamage"]')).toBeDefined()
    for (const part of ['10 casts', '4 hits', '40%']) expect(root.text).toContain(part)
    expect(facts(root)).toEqual(expect.arrayContaining(['24', '13']))
    expect(root.text).not.toContain('foreign-server-match-37')
    expect(root.find('button')).toBeUndefined() // Foreign Hall IDs never open a local match.
  })

  /** Why: unfinished games add the combat a human played to the same totals, not to a separate section or to match counts. */
  it('adds partial ranked activity into the one set of totals while match counts stay complete matches', () => {
    const totals = emptyTotals()
    Object.assign(totals, { casts: 10, hits: 4, killsByCause: { fireball: 3 } })
    const detail: RecordedProfileDetail = { matches: 2, seconds: 200, damage: 451, totals, spells: { fireball: [10, 4] }, hallOfFame: {} }
    const partialTotals = emptyTotals()
    Object.assign(partialTotals, { casts: 5, hits: 5, killsByCause: { fireball: 2 } })
    const activity: RecordedProfileDetail = { matches: 1, seconds: 40, damage: 49, totals: partialTotals, spells: { fireball: [5, 5] }, hallOfFame: {} }
    const root = render({ detail, activity })
    expect(covered(root)).toContain('2 of 8')
    expect(root.text).toContain('1 partial')
    for (const part of ['15 casts', '9 hits', '60%']) expect(root.text).toContain(part)
    expect(facts(root)).toContain('500') // damage: 451 + 49
    const only = render({ coverage: { ...coverage, detailedMatches: 0, firstDetailedAt: null, lastDetailedAt: null }, activity })
    expect(only.attr('data-state')).toBe('detail')
    for (const part of ['5 casts', '5 hits', '100%']) expect(only.text).toContain(part)
  })

  /** Why: casual games add to the same combat totals and K/D, but ranked match counts stay ranked so they keep their meaning. */
  it('counts casual games apart from ranked matches and derives K/D from every recorded part', () => {
    const totals = emptyTotals()
    Object.assign(totals, { killsByCause: { fireball: 3 }, deathsByCause: { lava: 1 } })
    const detail: RecordedProfileDetail = { matches: 2, seconds: 200, damage: 100, totals, spells: { fireball: [4, 2] }, hallOfFame: {} }
    const partialTotals = emptyTotals()
    Object.assign(partialTotals, { killsByCause: { fireball: 1 }, deathsByCause: { fireball: 1, disconnect: 1 } })
    const activity: RecordedProfileDetail = { matches: 1, seconds: 40, damage: 10, totals: partialTotals, spells: {}, hallOfFame: {} }
    const casualTotals = emptyTotals()
    Object.assign(casualTotals, { killsByCause: { lightning: 4 }, deathsByCause: { lava: 2 } })
    const casual: RecordedProfileDetail = { matches: 3, seconds: 300, damage: 90, totals: casualTotals, spells: {}, hallOfFame: { mostKills: { value: 4, date: 3, matchId: 'casual-2' } } }
    const root = render({ detail, activity, casual })
    expect(covered(root)).toContain('2 of 8')
    expect(root.text).toContain('1 partial')
    expect(root.text).toContain('3 casual')
    expect(facts(root)).toContain('200') // damage: 100 + 10 + 90
    expect(root.get('[data-hall="mostKills"]').text).toContain('4') // a casual personal best counts
    // A disconnect is not a death.
    expect(combatKD(mergeRecordedDetail(mergeRecordedDetail(detail, activity), casual)!)).toEqual({ kills: 8, deaths: 4 })
  })

  it('labels local rival detail as retained device records rather than a global career', () => {
    const root = render({ source: 'device' })
    expect(root.attr('data-source')).toBe('device')
    expect(covered(root)).toContain('2 of 8')
  })
})
