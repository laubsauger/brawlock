/**
 * Recovery from stale builds. Every deploy renames the hashed chunks and
 * GitHub Pages drops the old ones, so a page loaded before a deploy fails the
 * moment it lazily imports a chunk (e.g. the PeerJS bundle when joining).
 * - A failed chunk import reloads the page once, keeping a pending room code.
 * - A periodic check of version.json offers a reload outside of matches.
 */
import { useGame } from '../game/store'
import { session } from '../game/session'
import { PENDING_ROOM_KEY } from './pendingRoom'

declare const __BUILD_ID__: string

export { PENDING_ROOM_KEY } from './pendingRoom'
const RELOAD_KEY = 'brawlock.staleReloadAt'
const CHECK_MS = 90_000
let updateAvailable = false
const updateListeners = new Set<() => void>()
export const getBuildUpdate = () => updateAvailable
export function onBuildUpdate(listener: () => void): () => void {
  updateListeners.add(listener)
  return () => updateListeners.delete(listener)
}

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

async function newerBuildAvailable(currentBuild: string): Promise<boolean> {
  if (currentBuild.startsWith('dev-')) return false
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return false
    const { build } = (await res.json()) as { build?: string }
    return typeof build === 'string' && build !== currentBuild
  } catch {
    return false
  }
}

export async function checkBuildVersion(currentBuild = __BUILD_ID__): Promise<void> {
  if (updateAvailable || useGame.getState().screen === 'match') return
  if (await newerBuildAvailable(currentBuild)) {
    // The request may have started in a menu just before the player entered a match.
    if (updateAvailable || useGame.getState().screen === 'match') return
    updateAvailable = true
    for (const listener of updateListeners) listener()
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

  const check = () => checkBuildVersion()
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
