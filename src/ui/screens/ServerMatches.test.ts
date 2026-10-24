import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { frame, pushState, resetFrame } from '../../game/frame'
import type { MatchRecord } from '../../game/stats'
import type { MatchHistoryEntry, GlobalMatchEntry } from '../../net/leaderboard'
import { DEFAULT_SETTINGS } from '../../sim'
import { newMatch } from '../../sim/testkit'
vi.mock('../../game/session', () => ({ online: { configured: true }, session: {} }))
import { MatchScoreboard } from './Profile'
import { ServerMatchList } from './ServerMatches'

afterEach(resetFrame)
const build = {
  slots: ['lightning', null, null, null, null, null, 'fireball', 'armor', null, null, null, null],
  levels: [4, 0, 0, 0, 0, 0, 3, 2, 0, 0, 0, 0],
  masteries: { duration: 1, range: 3, lifesteal: 0 },
}
function match(): MatchHistoryEntry {
  return { id: 'server-match', queue: 'ranked', at: 1000, region: 'eu', ticks: 12000, rounds: 3, teamMode: 'ffa', gameMode: 'rounds', self: 0, outcome: 'forfeit', delta: -12, rating: 1488, players: [
    { player: 0, name: 'Leaver', kills: 2, deaths: 1, won: false, forfeited: true, build },
    { player: 1, name: 'Survivor', kills: 3, deaths: 0, won: true },
  ] }
}
const render = (m: MatchHistoryEntry, personal = true) => renderToStaticMarkup(createElement(ServerMatchList, { matches: [m], personal }))

describe('authoritative match history presentation', () => {
  it('shows a global match with winners, region and participants without inventing a personal loss or Elo', () => {
    const { self: _self, outcome: _outcome, delta: _delta, rating: _rating, ...global }: GlobalMatchEntry & Partial<MatchHistoryEntry> = match()
    global.players = global.players.map(p => ({ ...p, forfeited: undefined }))
    const html = renderToStaticMarkup(createElement(ServerMatchList, { matches: [global] }))
    expect(html).toContain('Survivor won')
    expect(html).toContain('eu')
    expect(html).toContain('2 players')
    expect(html).toContain('Recorded players and equipment')
    expect(html).not.toContain('(you)')
    expect(html).not.toContain('Loss')
    expect(html).not.toContain('Elo')
  })

  it('identifies a departure as a loss and retains its rated consequence', () => {
    const html = render(match())
    expect(html).toContain('Loss · left game')
    expect(html).toContain('−12 Elo · 1488')
    expect(html).toContain('Left before the end and did not return. The match counted, so this is a loss.')
    expect(html).toContain('left game · loss')
  })

  it('uses saved equipment and levels even while a different live build exists', () => {
    const live = newMatch()
    live.pawns[0].slots[0] = 'boomerang'
    live.pawns[0].levels[0] = 5
    live.scores[0].masteries.range = 5
    frame.localPlayer = 0
    pushState(live)
    const html = render(match())
    expect(html).toContain('Lightning level 4 of')
    expect(html).toContain('Fireball level 3 of')
    expect(html).toContain('Armor level 2 of')
    expect(html).toContain('Range mastery 3 of')
    expect(html).not.toContain('boomerang.png')
    expect(html).not.toContain('Range mastery 5 of')
  })

  it('leaves legacy missing equipment and score visibly absent instead of inventing a build', () => {
    const m = match()
    m.players = [{ player: 0, name: 'Legacy', kills: 1, deaths: 2, won: false }]
    m.queue = 'casual'; m.delta = null; m.rating = null; m.outcome = 'loss'
    const html = render(m)
    expect(html).toContain('Casual')
    expect(html).toContain('Not rated')
    expect(html).toContain('Equipment was not recorded for this player')
    expect(html).not.toContain('loadout-slot')
    expect(html).not.toContain('Score 0')
    expect(html).not.toContain('Elo')
  })

  it('does not call the public-profile subject the current viewer', () => {
    expect(render(match(), false)).not.toContain('(you)')
    expect(render(match())).toContain('(you)')
  })

  it('lets a local scoreboard row expand when equipment exists without detailed counters', () => {
    const r: MatchRecord = { id: 'local', date: 1000, teamMode: 'ffa', gameMode: 'rounds', settings: DEFAULT_SETTINGS, rounds: 2, durationSec: 100, self: 0, outcome: 'loss', winners: [], kills: [], damage: [], participants: [{ player: 0, profileId: 'local-player', name: 'Saved', color: 0xffffff, kind: 'human', team: 0, score: 1, kills: 2, deaths: 3, damage: 4, won: false, build }] }
    const html = renderToStaticMarkup(createElement(MatchScoreboard, { r }))
    expect(html).toContain('aria-label="Show Saved&#x27;s match details"')
    expect(html).toContain('aria-expanded="false"')
  })
})
