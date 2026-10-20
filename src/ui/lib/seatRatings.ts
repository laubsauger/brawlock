import { online, session } from '../../game/session'

/** A seat's public season record: global Elo, counted matches and wins. */
export interface SeatRating { elo: number; matches: number; wins: number }

const known = new Map<string, SeatRating | null>()
const asked = new Set<string>()

/** Loaded record of an account seat (`a_...` rating key); null: none yet, undefined: not loaded. */
export function seatRating(profileId: string | undefined): SeatRating | null | undefined {
  return profileId ? known.get(profileId) : undefined
}

/**
 * Fetch the public records of account seats once per browser session, from the room's region
 * (ratings are global). Guests and player-hosted games have none. Results land in the cache
 * the HUD polls, so callers never wait on it.
 */
export function loadSeatRatings(profileIds: (string | undefined)[]): void {
  const region = session.region()
  if (!region) return
  for (const id of profileIds) {
    if (!id || !id.startsWith('a_') || asked.has(id)) continue
    asked.add(id)
    online.profile(region.id, id)
      .then((p) => known.set(id, p ? { elo: Math.round(p.rating), matches: p.matches, wins: p.wins } : null))
      .catch(() => asked.delete(id))
  }
}
