export interface DailySpeaker {
  id: string
  profile: { name: string; color: number | null } | null
}
export interface DailyVerifier {
  ids(): string[]
  run(dailyId: string, input: { day: number; salt: number; tape: unknown }): Promise<unknown>
}
export interface DailyOptions {
  origin: string
  /** Exact HTTPS origins embedding the client (itch.io): guests only, CORS without cookies. */
  embeds?: string[]
  speaker: (request: Request) => Promise<DailySpeaker | null>
  names: (ids: string[]) => Map<string, string | null>
  reward: (accountId: string, day: number, base: number) => { duplicate: boolean; reward: { base: number; balance: number } | null }
  verifier: DailyVerifier
  now?: () => number
}
export const DAILY_RANKED_ATTEMPTS: number
export const DAILY_TOKEN_MS: number
export const DAILY_CLOSE_MS: number
export const DAILY_EMBERS: number
export const DAILY_STREAK_EMBERS: number
export function streakOf(played: Set<number>, outage: (day: number) => boolean, today: number, from?: number): { count: number; smoulder: boolean }
export function openDaily(file: string, options: DailyOptions): {
  handler(request: Request): Promise<Response>
  close(): void
}
