import type { LeaderboardStore } from '../src/net/leaderboard'

/** Open (or create) the SQLite leaderboard at `file` (':memory:' for tests). */
export function openLeaderboard(file: string): LeaderboardStore
