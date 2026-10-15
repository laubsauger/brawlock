import { useEffect, useState } from 'react'
import { getCareer, getEncounters, getLocalLeaderboard, getMatchHistory, onStatsChange, profileIdOf, type Encounter } from '../../game/stats'
import { getProfile } from '../../game/profile'
import type { PlayerSlot } from '../../sim'

/** Re-read local stats whenever a match is recorded. */
export function useStats<T>(read: () => T): T {
  const [v, setV] = useState(read)
  useEffect(() => onStatsChange(() => setV(read)), [read])
  return v
}

const readEncounters = (): Map<string, Encounter> => {
  try {
    return new Map(getEncounters().map((e) => [e.profileId, e]))
  } catch {
    return new Map()
  }
}

export function useEncounters(): Map<string, Encounter> {
  return useStats(readEncounters)
}

/** "You 3–1" against this slot's player, or null when you have never met. */
export function headToHead(enc: Map<string, Encounter>, slot: PlayerSlot): { text: string; tone: 'up' | 'down' | 'even' } | null {
  const e = enc.get(profileIdOf(slot))
  if (!e || e.games === 0) return null
  const tone = e.wins > e.losses ? 'up' : e.wins < e.losses ? 'down' : 'even'
  return { text: `You ${e.wins}–${e.losses}`, tone }
}

export const readCareer = () => {
  try {
    return getCareer()
  } catch {
    return null
  }
}

export const readHistory = () => {
  try {
    return getMatchHistory(50)
  } catch {
    return []
  }
}

export const readLeaderboard = () => {
  try {
    return getLocalLeaderboard(getProfile().id)
  } catch {
    return []
  }
}

export const readEncounterList = () => {
  try {
    return getEncounters()
  } catch {
    return []
  }
}

/** "3:07" from seconds */
export function duration(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}

/** "just now", "5 min ago", "yesterday", "12 Oct" */
export function ago(ms: number): string {
  const d = Date.now() - ms
  if (d < 60_000) return 'just now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`
  if (d < 2 * 86_400_000) return 'yesterday'
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
