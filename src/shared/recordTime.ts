/** Finished-match records (ratings, history, analytics) count time in 1/60 s ticks whatever the
 * simulation rate, so records stored by 60 Hz builds stay comparable after a TICK_HZ change.
 * net/leaderboard.ts converts a match into record time; the account service reads it too. */
export const RECORD_HZ = 60
export const recordSeconds = (ticks: number) => ticks / RECORD_HZ
