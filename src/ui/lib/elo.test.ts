import { describe, expect, it } from 'vitest'
import type { PublicRoom } from '../../net/online'
import { historyElo, liveElo } from './elo'

const room = (patch: Partial<PublicRoom> = {}): PublicRoom => ({ code: 'ABCDE', host: null, humans: 2, bots: 8, max: 10, joinable: 8, phase: 'lobby', quick: true, teamMode: 'ffa', gameMode: 'rounds', winScore: 5, kind: 'server', region: { id: 'eu' } as PublicRoom['region'], elo: { enabled: true, minSeconds: 120 }, ...patch })

describe('global Elo labels', () => {
  it('describes live policy without promising a completed rated match or counting bots', () => {
    expect(liveElo(room({ humans: 1, bots: 9 }))).toMatchObject({ kind: 'on', needsHumans: true })
    expect(liveElo(room())).toEqual({ kind: 'on', needsHumans: false, minSeconds: 120, ranked: null })
    expect(liveElo(room({ bots: 0 }))).toMatchObject({ kind: 'on', needsHumans: false })
  })
  it('states the scheduled ranked format from the room', () => {
    expect(liveElo(room({ ranked: true, rankedRounds: 5, max: 8, bots: 6 }))).toMatchObject({ kind: 'on', ranked: { players: 8, rounds: 5 } })
  })
  it('distinguishes disabled and player-hosted games from unknown server policy', () => {
    expect(liveElo(room({ kind: 'p2p' }))).toEqual({ kind: 'playerHosted' })
    expect(liveElo(room({ elo: { enabled: false, minSeconds: 120 } }))).toEqual({ kind: 'off' })
    expect(liveElo(room({ elo: undefined }))).toEqual({ kind: 'unknown' })
  })
  it('uses the saved server verdict, preserving unknown history and failed writes', () => {
    expect(historyElo({})).toEqual({ status: 'unknown', reason: null })
    expect(historyElo({ rating: { status: 'rated' } })).toEqual({ status: 'rated', reason: null })
    expect(historyElo({ rating: { status: 'unrated', reason: 'fewer than 2 humans' } })).toEqual({ status: 'unrated', reason: 'fewer than 2 humans' })
    expect(historyElo({ rating: { status: 'unavailable', reason: 'Write failed' } })).toEqual({ status: 'unavailable', reason: 'Write failed' })
  })
})
