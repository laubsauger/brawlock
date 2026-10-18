import { describe, expect, it } from 'vitest'
import { isLobbyVoteChoice, isLobbyVoteSetting, settleLobbyVote, type LobbyVoteView } from './lobbyVotes'

const vote: LobbyVoteView = { id: 1, setting: 'startGold', current: 47, closesAt: 10_000, eligible: [0, 1, 2], votes: {} }
describe('lobby vote settlement', () => {
  it('keeps custom host values when nobody votes or when choices tie', () => {
    expect(settleLobbyVote(vote)).toMatchObject({ value: 47, reason: 'noVotes' })
    expect(settleLobbyVote({ ...vote, votes: { 0: 'low', 1: 'high' } })).toMatchObject({ value: 47, reason: 'tie' })
  })
  it('uses the plurality and ignores ballots outside the frozen electorate', () => {
    expect(settleLobbyVote({ ...vote, votes: { 0: 'high', 1: 'high', 2: 'low', 3: 'low', 4: 'low' } })).toMatchObject({ value: 60, reason: 'won' })
  })
  it('accepts only the four proposed gold settings and three choices', () => {
    expect(isLobbyVoteSetting('startGold')).toBe(true)
    expect(isLobbyVoteSetting('__proto__')).toBe(false)
    expect(isLobbyVoteSetting('damage')).toBe(false)
    expect(isLobbyVoteChoice('high')).toBe(true)
    expect(isLobbyVoteChoice('9999')).toBe(false)
  })
})
