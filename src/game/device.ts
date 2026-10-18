/**
 * Anonymous device id (M4.1): a random id persisted per browser (localStorage
 * `brawlock.device.v1`), sent in `hello`. Hosts and servers use it to give a returning
 * device its seat back after a browser restart (the per-tab reconnect key does not
 * survive that); later it anchors ranked ratings. No accounts, nothing personal.
 */
import { safeLocalStorage } from './profile'

const KEY = 'brawlock.device.v1'
let cached: string | null = null

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `d${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
}

export function getDeviceId(): string {
  if (cached) return cached
  const store = safeLocalStorage()
  let id: string | null = null
  try {
    id = store?.getItem(KEY) ?? null
  } catch {
    id = null
  }
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    id = randomId()
    try {
      store?.setItem(KEY, id)
    } catch {
      /* private mode: this tab only */
    }
  }
  cached = id
  return id
}
