import { createAuthClient } from 'better-auth/client'
import { passkeyClient } from '@better-auth/passkey/client'
import { useAccount } from './accountState'
import { getDeviceId } from './device'
import { controllerKey } from './clientKey'
import { showRankedConflict } from './rankedControl'

export type AccountProvider = 'google' | 'discord' | 'microsoft'
export interface AccountPlayer {
  id: string
  /** Private own-account display only; never propagated to game slots or public stats. */
  email: string
  profile: { name: string; color: number | null } | null
  game: { region: string; room: string } | null
}
export const accountsEnabled = import.meta.env.VITE_ACCOUNTS_ENABLED === 'true'
// Same-origin by design: cookies and passkeys belong to the approved game domain.
export const accountAuth = createAuthClient({ plugins: [passkeyClient()] })

async function accountJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store' })
  const body = await response.json()
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Account request failed.')
  return body as T
}

export function accountProviders(): Promise<{ providers: AccountProvider[] }> {
  return accountJson('/api/account/config')
}

export async function currentAccount(): Promise<AccountPlayer | null> {
  const response = await fetch('/api/account', { credentials: 'same-origin', cache: 'no-store' })
  if (response.status === 401) return null
  const body = await response.json()
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not load your account.')
  return body as AccountPlayer
}

let refreshing: Promise<AccountPlayer | null> | null = null
let mutating: Promise<void> | null = null
let revision = 0

function publish(player: AccountPlayer | null): void {
  revision++
  useAccount.setState({ player, loaded: true, error: null })
}

/** Refresh cookie-backed identity; concurrent menu requests share only this read. */
export function refreshAccount(): Promise<AccountPlayer | null> {
  if (mutating) return mutating.then(() => refreshAccount())
  if (refreshing) return refreshing
  const started = revision
  refreshing = currentAccount().then((player) => {
    if (started === revision) publish(player)
    return useAccount.getState().player
  }).catch((error: unknown) => {
    if (started === revision) useAccount.setState({ loaded: true, error: error instanceof Error ? error.message : 'Could not load your account.' })
    throw error
  }).finally(() => { refreshing = null })
  return refreshing
}

/** Keep account writes ordered; a read cannot publish the pre-write identity. */
function mutateAccount<T>(request: () => Promise<T>, commit: (value: T) => void): Promise<T> {
  ++revision
  const run = async () => {
    const result = await request()
    commit(result)
    return result
  }
  const task = mutating ? mutating.then(run) : run()
  // This barrier only orders later actions; callers still receive task's rejection.
  const settled = task.then(() => {}, () => {})
  mutating = settled
  void settled.then(() => { if (mutating === settled) mutating = null })
  return task
}

/** A new, one-use credential for each regional action. Never store or reuse it. */
export async function getAdmissionToken(required = false, takeover = false): Promise<string | null> {
  if (!accountsEnabled) {
    if (required) throw new Error('Sign in is unavailable in this build.')
    return null
  }
  // A signed-in player can still play casually while choosing a reserved name.
  if (!required && !(await refreshAccount())?.profile) return null
  if (mutating) await mutating
  const started = revision
  const response = await fetch('/api/account/admission', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device: getDeviceId(), controller: controllerKey(), takeover }),
  })
  if (response.status === 401) {
    if (started === revision) publish(null)
    if (!required) return null
    throw new Error('Sign in before joining ranked.')
  }
  const body = await response.json()
  if (started !== revision) throw new Error('Your account changed while connecting. Try joining again.')
  if (response.status === 409 && body.rankedConflict) showRankedConflict(body.rankedConflict)
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not verify your account.')
  if (typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(body.token)) throw new Error('The account service returned an invalid admission ticket.')
  return body.token
}

export async function saveAccountProfile(profile: { name: string; color: number | null }, claimed: boolean): Promise<AccountPlayer> {
  return mutateAccount(() => accountJson<AccountPlayer>('/api/account', {
    method: claimed ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(profile),
  }), publish)
}

/** A lobby color preference must not rename an account from a stale tab. */
export function saveAccountColor(color: number | null): Promise<AccountPlayer> {
  return mutateAccount(() => accountJson<AccountPlayer>('/api/account', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ color }),
  }), publish)
}

export async function signOutAccount(): Promise<void> {
  return mutateAccount(async () => {
    const result = await accountAuth.signOut()
    if (result.error) throw new Error(result.error.message ?? 'Could not sign out.')
  }, () => publish(null))
}

export function accountCallbackURL(origin: string, base: string, rankedRegion?: string): string {
  const url = new URL(base, origin)
  url.searchParams.set('account', rankedRegion ? 'ranked' : 'open')
  if (rankedRegion) url.searchParams.set('region', rankedRegion)
  return url.href
}
