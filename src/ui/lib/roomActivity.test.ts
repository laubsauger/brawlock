import { describe, expect, it } from 'vitest'
import { roomActivity } from './roomActivity'

describe('browser match activity', () => {
  it('shows the current round, activity and total elapsed match time', () => {
    expect(roomActivity({ phase: 'match', rankedRounds: 5, progress: { round: 3, elapsedSeconds: 245, phase: 'shop', final: false } })).toEqual({ label: 'Shopping', detail: 'Round 3/5 · 4:05 elapsed' })
    expect(roomActivity({ phase: 'match', progress: { round: 7, elapsedSeconds: 3602, phase: 'fight', final: false } })).toEqual({ label: 'Fighting', detail: 'Round 7 · 60:02 elapsed' })
    expect(roomActivity({ phase: 'match', progress: { round: 2, elapsedSeconds: 90, phase: 'roundEnd', final: false } }).label).toBe('Between rounds')
  })

  it('labels a tied-leader final without inventing a sixth scheduled round', () => {
    expect(roomActivity({ phase: 'match', rankedRounds: 5, progress: { round: 6, elapsedSeconds: 900, phase: 'fight', final: true } })).toEqual({ label: 'Fighting', detail: 'Final brawl · 15:00 elapsed' })
  })

  it('hides previous match progress in lobbies and retains completed match duration on results', () => {
    const progress = { round: 4, elapsedSeconds: 370, phase: 'gameOver' as const, final: false }
    expect(roomActivity({ phase: 'lobby', progress })).toEqual({ label: 'Waiting', detail: null })
    expect(roomActivity({ phase: 'results', progress })).toEqual({ label: 'Between matches', detail: 'Round 4 · 6:10 elapsed' })
    // Older listings can omit progress; no made-up round or running stopwatch.
    expect(roomActivity({ phase: 'match' })).toEqual({ label: 'In a match', detail: null })
  })
})
