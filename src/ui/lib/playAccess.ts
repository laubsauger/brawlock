import { useSyncExternalStore } from 'react'
import { isPlaySupported, PLAY_MEDIA } from '../../game/playAccess'
export { isPlaySupported, PLAY_REQUIREMENT } from '../../game/playAccess'

function subscribe(changed: () => void): () => void {
  if (typeof globalThis.matchMedia !== 'function') return () => {}
  const queries = PLAY_MEDIA.map((query) => globalThis.matchMedia(query))
  queries.forEach((query) => query.addEventListener('change', changed))
  return () => queries.forEach((query) => query.removeEventListener('change', changed))
}

export function usePlaySupported(): boolean {
  return useSyncExternalStore(subscribe, isPlaySupported, () => false)
}
