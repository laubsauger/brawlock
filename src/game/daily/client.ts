/**
 * The daily's calls to the account service (server/daily.mjs): the day's board, an attempt token
 * with its salt, the run's submission and a guest's claim. Builds without accounts or a site play
 * offline: the day from the local clock, a local salt, nothing on the board.
 */
import { accountsEnabled } from '../account'
import { siteApi, siteCredentials, SITE_URL } from '../../lib/site'
import type { DailyTape } from './tape'

declare const __DAILY_ID__: string
/** this build's verifier id (scripts/daily-id.mjs) */
export const DAILY_ID: string = typeof __DAILY_ID__ === 'string' ? __DAILY_ID__ : 'dev'

/** the board is reachable from this build */
export const dailyOnline = accountsEnabled || !!SITE_URL

export interface DailyBoardRow {
  rank: number
  name: string | null
  waves: number
  time: number
  attempt: string
  build: string
}

export interface DailyYou {
  best: { waves: number; time: number } | null
  first: { waves: number; time: number } | null
  attempts: number
  ranked: number
  streak: { count: number; smoulder: boolean; nextReward: number }
  week: { day: number; waves: number | null }[]
}

export interface DailySummary {
  day: number
  number: number
  name: string
  serverNow: number
  nextDay: number
  closesAt: number
  dailyIds: string[]
  board: { view: 'best' | 'first'; rows: DailyBoardRow[]; you: DailyBoardRow | null; players: number }
  you: DailyYou | null
}

export interface DailyVerified {
  status: 'verified'
  waves: number
  time: number
  bounty: number
  rank: number | null
  players: number
  listed: boolean
  best: { waves: number; time: number } | null
  streak: { count: number; smoulder: boolean }
  reward: { embers: number; balance: number; day: number } | null
}

const post = async (path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> } | null> => {
  try {
    const res = await fetch(siteApi(path), { method: 'POST', credentials: siteCredentials, cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
  } catch {
    return null
  }
}

export async function fetchDaily(device: string, view: 'best' | 'first' = 'best', day?: number): Promise<DailySummary | null> {
  if (!dailyOnline) return null
  try {
    const q = new URLSearchParams({ view, device, ...(day !== undefined ? { day: String(day) } : {}) })
    const res = await fetch(siteApi(`/api/daily?${q}`), { credentials: siteCredentials, cache: 'no-store' })
    return res.ok ? ((await res.json()) as DailySummary) : null
  } catch {
    return null
  }
}

export type AttemptToken = { attempt: string; salt: number; expiresAt: number; day: number }

/** A ranked attempt, or why not ('cap', 'rate', 'update', 'day', 'offline'). */
export async function requestAttempt(day: number, device: string): Promise<AttemptToken | { code: string }> {
  if (!dailyOnline) return { code: 'offline' }
  const r = await post('/api/daily/attempt', { day, dailyId: DAILY_ID, device })
  if (!r) return { code: 'offline' }
  if (r.status === 201) return r.body as unknown as AttemptToken
  return { code: typeof r.body.code === 'string' ? r.body.code : 'offline' }
}

async function gzipBase64(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
  const out = new Uint8Array(await new Response(stream).arrayBuffer())
  let bin = ''
  for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode(...out.subarray(i, i + 0x8000))
  return btoa(bin)
}

export type SubmitOutcome = DailyVerified | { status: 'rejected'; code: string } | { status: 'retry' }

/** Post a finished run. 'retry': the service is busy or unreachable, try again later. */
export async function submitRun(attempt: string, tape: DailyTape, claimed: { waves: number; time: number }, device: string): Promise<SubmitOutcome> {
  const r = await post('/api/daily/submit', { attempt, tape: await gzipBase64(JSON.stringify(tape)), claimed, device })
  if (!r || r.status === 503) return { status: 'retry' }
  if (r.status === 200) return r.body as unknown as DailyVerified
  return { status: 'rejected', code: typeof r.body.code === 'string' ? r.body.code : String(r.status) }
}

/** Sign-in claims today's run made as a guest on this browser. */
export async function claimRun(attempt: string, device: string): Promise<DailyVerified | null> {
  const r = await post('/api/daily/claim', { attempt, device })
  return r && r.status === 200 && r.body.status === 'verified' ? (r.body as unknown as DailyVerified) : null
}
