import type { MatchSettings } from '../src/sim/types'
import type { FinishedMatch } from '../src/net/leaderboard'
export interface AnalyticsCounts {
  guests: number; accounts: number; newGuests: number; newAccounts: number; visits: number; minutes: number; peak: number
  started: number; completed: number; abandoned: number; interrupted: number; running: number; completedSeconds: number; completedRounds: number
  from: string; through: string; coverage: 'complete' | 'partial' | 'none'
}
export interface AnalyticsReport {
  version: 3; generatedAt: number; trackingSince: number; identityTrackingSince: number; dimensionTrackingSince: number; days: number; from: string; through: string
  browsers: { seen: number; new: number; guestToAccount: number }
  visitors: { kind: 'guest' | 'account'; seen: number; new: number }[]
  lifetimeVisitors: { kind: 'guest' | 'account'; seen: number }[]
  matches: { region: string; queue: string; started: number; completed: number; abandoned: number; interrupted: number; running: number; completedSeconds: number; completedRounds: number; botSeats: number }[]
  participation: { region: string; queue: string; kind: 'guest' | 'account'; participations: number; uniquePlayers: number }[]
  daily: { day: string; browsers: { seen: number; new: number; guestToAccount: number }; traffic: { day: string; kind: 'guest' | 'account'; seen: number; new: number; sessions: number; activeMs: number }[]; matches: { day: string; started: number; completed: number; abandoned: number; interrupted: number }; peakOnline: number }[]
  series: { days: number; current: AnalyticsCounts; previous: AnalyticsCounts; daily: (AnalyticsCounts & { period: string })[]; weekly: (AnalyticsCounts & { period: string })[] }[]
  facts: {
    from: string; through: string
    traffic: { day: string; person: string; browser: string | null; kind: 'guest' | 'account'; region: string; build: string; net: string; screen: string; sessions: number; active_ms: number; firstAt: number }[]
    browsers: { day: string; browser: string; firstAt: number; convertedAt: number | null; convertedRegion: string | null; convertedBuild: string | null }[]
    matches: { id: string; room: string | null; region: string; queue: string; game_mode: string; team_mode: string; build: string | null; commit_id: string | null; settings: MatchSettings | null; started_at: number; ended_at: number | null; status: string; seconds: number; rounds: number; bots: number; players: { person: string; kind: 'guest' | 'account' }[] }[]
    samples: { at: number; region: string; build: string; net: string; screen: string; kind: 'guest' | 'account'; people: number }[]
    peaks: { day: string; online: number }[]
  }
}
export interface AnalyticsStore {
  recover(): void
  presence(beat: { device: string; accountId: string | null; region: string; online: number; build?: string; net?: string; screen?: string; sample?: { region: string; build: string; net: string; screen: string; kind: 'guest' | 'account'; people: number }[] }): void
  start(match: { id: string; region: string; queue: 'casual' | 'ranked' | 'custom'; settings: MatchSettings; devices: string[]; bots: number; build?: string | null; room?: string | null }): void
  join(id: string, device: string): void
  finish(id: string, match: FinishedMatch): void
  abandon(id: string): void
  report(days?: number): AnalyticsReport
  close(): void
}
export function openAnalytics(file: string, opts?: { now?: () => number; serverCommit?: string | null }): AnalyticsStore
