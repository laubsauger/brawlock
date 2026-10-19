/** Public population only; no gameplay, identity or rating authority. */
export const PRESENCE_REGIONS = ['us-west', 'eu'] as const
export const PRESENCE_INTERVAL_MS = 30_000
export const PRESENCE_TTL_MS = 90_000
export interface PresenceSnapshot {
  regions: Record<string, number>
  total: number
}

export function parsePresence(value: unknown): PresenceSnapshot {
  const v = value as PresenceSnapshot
  if (!v || !v.regions || typeof v.regions !== 'object' || Object.keys(v.regions).length !== PRESENCE_REGIONS.length
    || PRESENCE_REGIONS.some((id) => !Number.isSafeInteger(v.regions[id]) || v.regions[id] < 0)
    || !Number.isSafeInteger(v.total) || v.total !== PRESENCE_REGIONS.reduce((sum, id) => sum + v.regions[id], 0)) throw new Error('Invalid online population response.')
  return v
}
