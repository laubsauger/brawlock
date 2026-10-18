/** Server-confirmed outcome, attached only after the match's Elo transaction. */
export interface MatchRating {
  status: 'rated' | 'unrated' | 'unavailable'
  reason?: string
}
