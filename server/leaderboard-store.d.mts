import type { RatingReceiptStore } from '../src/net/ratingAuthority'

/** One identity's recorded games in a period; `device` never leaves the servers. */
export interface PlayerActivity {
  device: string
  name: string
  matches: number
  wins: number
  forfeits: number
  seconds: number
  kills: number
  deaths: number
  queues: { ranked: number; casual: number; custom: number }
  /** distinct UTC dates with a recorded game */
  days: number
  firstAt: number
  lastAt: number
}

/** Open (or create) the SQLite leaderboard at `file` (':memory:' for tests). */
export function openLeaderboard(file: string): RatingReceiptStore & {
  playerActivity(since: number, until: number): PlayerActivity[]
  historySince(): number | null
}
