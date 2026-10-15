import { useGame } from '../../game/store'

/**
 * First-run name prompt. The name lives in settings.playerName (persisted by
 * the store); this flag only remembers that the player picked one, so the
 * splash asks exactly once.
 */
const KEY = 'brawlock.nameChosen.v1'
export const NAME_MAX = 16

export function hasChosenName(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return true // no storage: never nag
  }
}

/** Save a display name (trimmed, 1..16 chars). Returns the saved name. */
export function chooseName(raw: string): string {
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) || useGame.getState().settings.playerName || 'Warlock'
  useGame.getState().setSettings({ playerName: name })
  try {
    localStorage.setItem(KEY, '1')
  } catch {
    /* private mode */
  }
  return name
}
