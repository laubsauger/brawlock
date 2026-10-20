import { create } from 'zustand'
import { safeLocalStorage, type KV } from '../../game/profile'
import type { ReleaseNotes } from '../../../scripts/release-version.mjs'

declare const __RELEASE_NOTES__: ReleaseNotes[]

export const releaseNotes = __RELEASE_NOTES__
export const currentRelease = releaseNotes[0]
export const RELEASE_SEEN_KEY = 'brawlock.releaseNotes.seen'

/** First visits establish a baseline silently; only returning players see an update. */
export function shouldAnnounceRelease(previous: string | null, current = currentRelease.version): boolean {
  return previous !== null && previous !== current
}

export function readSeenRelease(storage: KV | null = safeLocalStorage()): string | null {
  try { return storage?.getItem(RELEASE_SEEN_KEY) ?? null }
  catch { return null }
}

export function rememberRelease(version: string, storage: KV | null = safeLocalStorage()): void {
  try { storage?.setItem(RELEASE_SEEN_KEY, version) }
  catch { /* Optional read preference: the dialog still works for this visit. */ }
}

export const useReleaseNotes = create<{ open: boolean; show(): void; hide(): void }>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}))
