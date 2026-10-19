/** A one-use tab continuation, not an authentication credential or OAuth state. */
const KEY = 'brawlock.accountReturn.v1'
const MAX_AGE = 15 * 60_000
interface ReturnStore { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export interface AccountReturn { intent: 'open' | 'ranked'; region?: string; settings: boolean; problem: string | null }

/** Correlate the full-page trip before handing its URL to the auth library. */
export function prepareAccountReturn(callback: string, store: ReturnStore, now: number, nonce: string, settings = false): string {
  const url = new URL(callback)
  const intent = url.searchParams.get('account')
  const region = url.searchParams.get('region')
  if (!['open', 'ranked'].includes(intent ?? '') || !/^[A-Za-z0-9_-]{32,64}$/.test(nonce)
    || (intent === 'ranked' ? !region || !/^[a-z0-9][a-z0-9-]{0,23}$/.test(region) : region !== null)) throw new Error('Invalid sign-in continuation.')
  url.searchParams.set('accountReturn', nonce)
  store.setItem(KEY, JSON.stringify({ callback: url.href, at: now, settings }))
  return url.href
}

/** Consume even invalid markers. Bare ?account=ranked never skips the splash. */
export function consumeAccountReturn(href: string, store: ReturnStore, now: number): AccountReturn | null {
  const url = new URL(href)
  if (!url.searchParams.has('accountReturn')) return null
  const raw = store.getItem(KEY)
  store.removeItem(KEY)
  if (!raw) return null
  let record: { callback?: unknown; at?: unknown; settings?: unknown }
  try { record = JSON.parse(raw) } catch { return null }
  if (!record || typeof record.callback !== 'string' || typeof record.at !== 'number' || !Number.isFinite(record.at)
    || now < record.at || now - record.at > MAX_AGE || typeof record.settings !== 'boolean') return null
  let expected: URL
  try { expected = new URL(record.callback) } catch { return null }
  if (url.origin !== expected.origin || url.pathname !== expected.pathname
    || ['accountReturn', 'account', 'region'].some((key) => url.searchParams.get(key) !== expected.searchParams.get(key))) return null
  const intent = expected.searchParams.get('account')
  const region = expected.searchParams.get('region')
  if (intent !== 'open' && intent !== 'ranked') return null
  return { intent, ...(region ? { region } : {}), settings: record.settings,
    problem: url.searchParams.has('error') ? 'Sign-in was cancelled or could not be completed. Please try again.' : null }
}

let checked = false
let continuation: AccountReturn | null = null
/** Shared by splash and menu; React's repeated mounts cannot consume it twice. */
export function accountReturn(): AccountReturn | null {
  if (checked) return continuation
  checked = true
  if (!new URL(window.location.href).searchParams.has('accountReturn')) return null
  try { continuation = consumeAccountReturn(window.location.href, window.sessionStorage, Date.now()) }
  catch { continuation = null } // Unreadable tab state cannot authorize an intro bypass.
  return continuation
}

export function beginAccountReturn(callback: string, settings = false): string {
  if (new URL(callback).origin !== window.location.origin) throw new Error('Sign-in must return to this game origin.')
  return prepareAccountReturn(callback, window.sessionStorage, Date.now(), crypto.randomUUID(), settings)
}

export function cancelAccountReturn(): void { window.sessionStorage.removeItem(KEY) }
