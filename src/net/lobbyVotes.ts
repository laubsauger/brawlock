import type { MatchSettings } from '../sim/types'

export const LOBBY_VOTE_MS = 10_000
export const LOBBY_VOTE_CHOICES = ['low', 'medium', 'high'] as const
export type LobbyVoteChoice = typeof LOBBY_VOTE_CHOICES[number]
export const LOBBY_VOTE_SETTINGS = {
  startGold: { label: 'Start gold' },
  roundGold: { label: 'Round gold' },
  killGold: { label: 'Kill gold' },
  winGold: { label: 'Win gold' },
} as const satisfies Partial<Record<keyof MatchSettings, { label: string }>>
export type LobbyVoteSetting = keyof typeof LOBBY_VOTE_SETTINGS

/** Keep proposals near the host's economy; zero rewards can still be voted up. */
export function lobbyVoteValues(current: number): Record<LobbyVoteChoice, number> {
  if (!Number.isInteger(current) || current < 0 || current > 9999) throw new Error('Invalid lobby vote value')
  return { low: Math.max(0, Math.min(current - 1, Math.round(current * 0.8))),
    medium: current, high: Math.min(9999, Math.max(current + 1, Math.round(current * 1.5))) }
}

export interface LobbyVoteView {
  id: number
  setting: LobbyVoteSetting
  current: number
  /** Local session clock, reconstructed from remaining time on the wire. */
  closesAt: number
  eligible: number[]
  votes: Partial<Record<number, LobbyVoteChoice>>
}
export type LobbyVoteWire = Omit<LobbyVoteView, 'closesAt'> & { inMs: number }
export interface LobbyVoteResult {
  id: number
  setting: LobbyVoteSetting
  value: number
  reason: 'won' | 'tie' | 'noVotes' | 'cancelled'
}

export function isLobbyVoteSetting(value: unknown): value is LobbyVoteSetting {
  return typeof value === 'string' && Object.hasOwn(LOBBY_VOTE_SETTINGS, value)
}
export function isLobbyVoteChoice(value: unknown): value is LobbyVoteChoice {
  return LOBBY_VOTE_CHOICES.some((choice) => choice === value)
}
export function settleLobbyVote(vote: LobbyVoteView): LobbyVoteResult {
  const counts = { low: 0, medium: 0, high: 0 }
  for (const player of vote.eligible) {
    const choice = vote.votes[player]
    if (choice) counts[choice]++
  }
  const best = Math.max(...Object.values(counts))
  const winners = LOBBY_VOTE_CHOICES.filter((choice) => counts[choice] === best)
  const reason = best === 0 ? 'noVotes' : winners.length === 1 ? 'won' : 'tie'
  return { id: vote.id, setting: vote.setting, value: reason === 'won' ? lobbyVoteValues(vote.current)[winners[0]] : vote.current, reason }
}
