import type { RatingReceiptStore } from '../src/net/ratingAuthority'

/** Open (or create) the SQLite leaderboard at `file` (':memory:' for tests). */
export function openLeaderboard(file: string): RatingReceiptStore
