import { useGame } from '../game/store'

declare const __BUILD_ID__: string

export const BUILD_UPDATE_REQUIRED = 'A new version is ready. Reload Brawlock before playing.'
let updateAvailable = false
let checking: Promise<void> | null = null
const listeners = new Set<() => void>()

export const getBuildUpdate = () => updateAvailable
export function onBuildUpdate(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

async function probe(currentBuild: string): Promise<void> {
  if (updateAvailable || currentBuild.startsWith('dev-') || useGame.getState().screen === 'match') return
  if (checking) return checking
  checking = (async () => {
    const response = await fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error('Could not check the game version. Please try again.')
    const { build } = await response.json() as { build?: unknown }
    if (typeof build !== 'string' || !build) throw new Error('The game version response is invalid. Please try again.')
    // Never interrupt a match entered while a background check was in flight.
    if (build === currentBuild || updateAvailable || useGame.getState().screen === 'match') return
    updateAvailable = true
    for (const listener of listeners) listener()
  })().finally(() => { checking = null })
  return checking
}

/** Background checks retry on the next interval/focus; entry checks below must succeed. */
export async function checkBuildVersion(currentBuild = __BUILD_ID__): Promise<void> {
  try { await probe(currentBuild) } catch { /* A background network failure is not proof of an update. */ }
}

/** Check before acquiring a play lease, reserving a seat or connecting to a room. */
export async function ensureCurrentBuild(currentBuild = __BUILD_ID__): Promise<void> {
  await probe(currentBuild)
  if (updateAvailable) throw new Error(BUILD_UPDATE_REQUIRED)
}
