/**
 * Recovery from stale builds. Every deploy renames the hashed chunks and
 * GitHub Pages drops the old ones, so a page loaded before a deploy fails the
 * moment it lazily imports a chunk (e.g. the PeerJS bundle when joining).
 * - A failed chunk import reloads the page once, keeping a pending room code.
 * - Version checks require a reload outside of matches before playing again.
 */
import { useGame } from '../game/store'
import { session } from '../game/session'
import { PENDING_ROOM_KEY } from './pendingRoom'
import { checkBuildVersion } from './buildVersion'

export { PENDING_ROOM_KEY } from './pendingRoom'
export { checkBuildVersion, getBuildUpdate, onBuildUpdate } from './buildVersion'
const RELOAD_KEY = 'brawlock.staleReloadAt'
const CHECK_MS = 15_000

function pendingRoom(): string | null {
  try {
    return useGame.getState().lobby.roomCode ?? sessionStorage.getItem(PENDING_ROOM_KEY)
  } catch {
    return null
  }
}

function reloadOnce(): void {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
    // never loop: at most one automatic reload per 30 s
    if (Date.now() - last < 30_000) return
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch {
    /* storage blocked: still reload once */
  }
  reloadLatestBuild()
}

/** Explicit user action: preserve a guest's room, without the automatic-retry cooldown. */
export function reloadLatestBuild(): void {
  const url = new URL(window.location.href)
  const room = pendingRoom()
  const localHost = useGame.getState().lobby.role === 'host' && session.transport() === 'p2p'
  url.searchParams.delete('room')
  if (room && !localHost) url.searchParams.set('room', room)
  window.location.replace(url.toString())
}

function isChunkError(reason: unknown): boolean {
  const msg = reason instanceof Error ? reason.message : String(reason ?? '')
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(msg)
}

export function installStaleBuildRecovery(): void {
  window.addEventListener('vite:preloadError', (e) => {
    e.preventDefault()
    reloadOnce()
  })
  window.addEventListener('unhandledrejection', (e) => {
    if (isChunkError(e.reason)) reloadOnce()
  })

  const check = () => checkBuildVersion()
  void check()
  window.setInterval(check, CHECK_MS)
  window.addEventListener('focus', () => { void check() })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check()
  })
  useGame.subscribe((state, previous) => {
    if (state.screen !== previous.screen && state.screen !== 'match') void check()
  })
}

/** Called by flows that catch chunk failures themselves (e.g. join). */
export function recoverFromChunkError(reason: unknown): boolean {
  if (!isChunkError(reason)) return false
  reloadOnce()
  return true
}
