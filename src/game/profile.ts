/**
 * Local player profile: a stable per-browser id (survives reloads and new tabs),
 * the display name (settings.playerName) and an optional preferred color.
 * Peers send the id in `hello` so hosts and local stats recognize players across
 * matches. This is not the per-tab reconnect key (game/session.ts), which only
 * lets a reloaded tab reclaim its pawn mid-match.
 *
 * Storage is best effort: private mode or corrupt data fall back to a fresh
 * in-memory profile instead of throwing.
 */
import { useGame } from './store'

export interface Profile {
  id: string
  name: string
  /** 0xRRGGBB the player would like; the host grants it if no one else has it */
  color: number | null
}

interface StoredProfile {
  id: string
  color: number | null
}

const KEY = 'brawlock.profile.v1'

/** Minimal Storage subset, injectable for tests. */
export interface KV {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function safeLocalStorage(): KV | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
    const b = new Uint8Array(16)
    crypto.getRandomValues(b)
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  } catch {
    return Math.random().toString(36).slice(2) + Date.now().toString(36)
  }
}

function isColor(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffff
}

let memo: StoredProfile | null = null

function load(kv: KV | null): StoredProfile {
  if (memo) return memo
  let p: StoredProfile | null = null
  try {
    const raw = kv?.getItem(KEY)
    if (raw) {
      const v = JSON.parse(raw) as Partial<StoredProfile>
      if (typeof v.id === 'string' && v.id.length >= 8 && v.id.length <= 64) {
        p = { id: v.id, color: isColor(v.color) ? v.color : null }
      }
    }
  } catch {
    /* corrupt: start over */
  }
  if (!p) {
    p = { id: randomId(), color: null }
    save(kv, p)
  }
  memo = p
  return p
}

function save(kv: KV | null, p: StoredProfile): void {
  try {
    kv?.setItem(KEY, JSON.stringify(p))
  } catch {
    /* quota / private mode: keep it in memory for this session */
  }
}

/** The local profile. Creates and persists the id on first use. */
export function getProfile(kv: KV | null = safeLocalStorage()): Profile {
  const p = load(kv)
  return { id: p.id, name: useGame.getState().settings.playerName, color: p.color }
}

export function setPreferredColor(color: number | null, kv: KV | null = safeLocalStorage()): void {
  const p = load(kv)
  memo = { ...p, color: isColor(color) ? color : null }
  save(kv, memo)
}

/** @internal tests */
export function _resetProfileCache(): void {
  memo = null
}
