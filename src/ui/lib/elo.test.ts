import { describe, expect, it } from 'vitest'
import type { PublicRoom } from '../../net/online'
import { historyEloLabel, liveEloLabel } from './elo'

const room = (patch: Partial<PublicRoom> = {}): PublicRoom => ({ code: 'ABCDE', host: null, humans: 2, bots: 8, max: 10, joinable: 8, phase: 'lobby', quick: true, teamMode: 'ffa', gameMode: 'rounds', winScore: 5, kind: 'server', region: { id: 'eu' } as PublicRoom['region'], elo: { enabled: true, minSeconds: 120 }, ...patch })

describe('global Elo labels', () => {
  it('describes live policy without promising a completed rated match or counting bots', () => {
    expect(liveEloLabel(room({ humans: 1, bots: 9 })).label).toBe('Elo · needs 2 humans')
    expect(liveEloLabel(room()).label).toBe('Elo enabled')
    expect(liveEloLabel(room()).title).toContain('120 seconds')
    expect(liveEloLabel(room()).title).toContain('distinct devices')
    expect(liveEloLabel(room({ bots: 0 })).label).toBe('Elo enabled')
  })
  it('explains the scheduled eight-player ranked format without promising a deadline', () => {
    const label = liveEloLabel(room({ ranked: true, rankedRounds: 5, max: 8, bots: 6 }))
    expect(label.title).toContain('8 players · 5 rounds plus a final brawl for tied leaders')
    expect(label.title).toContain('Target 15–20 minutes; match length varies')
    expect(label.title).toContain('Bots do not contribute to Elo')
  })
  it('distinguishes disabled and player-hosted games from unknown server policy', () => {
    expect(liveEloLabel(room({ kind: 'p2p' })).label).toBe('Unranked')
    expect(liveEloLabel(room({ elo: { enabled: false, minSeconds: 120 } })).label).toBe('Unranked')
    expect(liveEloLabel(room({ elo: undefined })).label).toBe('Elo unknown')
  })
  it('uses the saved server verdict, preserving unknown history and failed writes', () => {
    expect(historyEloLabel({}).label).toBe('Elo unknown')
    expect(historyEloLabel({ rating: { status: 'rated' } }).label).toBe('Elo rated')
    expect(historyEloLabel({ rating: { status: 'unrated', reason: 'fewer than 2 humans' } })).toMatchObject({ label: 'Unranked', title: 'No global Elo: fewer than 2 humans' })
    expect(historyEloLabel({ rating: { status: 'unavailable', reason: 'Write failed' } })).toMatchObject({ label: 'Elo unavailable', title: 'Write failed' })
  })
})
