/**
 * Recovery from stale builds. Every deploy renames the hashed chunks and
 * GitHub Pages drops the old ones, so a page loaded before a deploy fails the
 * moment it lazily imports a chunk (e.g. the PeerJS bundle when joining).
 * - A failed chunk import reloads the page once, keeping a pending room code.
 * - A periodic check of version.json offers a reload outside of matches.
 */
import { useGame } from '../game/store'
import { toast } from '../ui/lib/toast'

declare const __BUILD_ID__: string

export const PENDING_ROOM_KEY = 'brawlock.pendingRoom'
const RELOAD_KEY = 'brawlock.staleReloadAt'
const CHECK_MS = 90_000

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
  const url = new URL(window.location.href)
  const room = pendingRoom()
  if (room && useGame.getState().lobby.role !== 'host') url.searchParams.set('room', room)
  window.location.replace(url.toString())
}

function isChunkError(reason: unknown): boolean {
  const msg = reason instanceof Error ? reason.message : String(reason ?? '')
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(msg)
}

async function newerBuildAvailable(): Promise<boolean> {
  if (__BUILD_ID__.startsWith('dev-')) return false
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return false
    const { build } = (await res.json()) as { build?: string }
    return typeof build === 'string' && build !== __BUILD_ID__
  } catch {
    return false
  }
}

export function installStaleBuildRecovery(): void {
  window.addEventListener('vite:preloadError', (e) => {
    e.preventDefault()
    reloadOnce()
  })
  window.addEventListener('unhandledrejection', (e) => {
    if (isChunkError(e.reason)) reloadOnce()
  })

  let notified = false
  const check = async () => {
    if (notified || useGame.getState().screen === 'match') return
    if (await newerBuildAvailable()) {
      notified = true
      toast('A new version is available. Reload the page (Cmd/Ctrl+R) before joining a game.')
    }
  }
  window.setInterval(check, CHECK_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check()
  })
}

/** Called by flows that catch chunk failures themselves (e.g. join). */
export function recoverFromChunkError(reason: unknown): boolean {
  if (!isChunkError(reason)) return false
  reloadOnce()
  return true
}
