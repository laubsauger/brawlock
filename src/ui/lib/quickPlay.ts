import type { PublicRoom } from '../../net/online'

/** Same public room eligibility as Quick Play; the join request also accounts for pending reservations. */
export function quickPlayAvailability(rooms: readonly PublicRoom[], region: string): string {
  const eligible = rooms.filter((r) => r.kind === 'server' && !r.ranked && r.region.id === region &&
    typeof r.joinable === 'number' && r.joinable > 0 &&
    (r.phase === 'match' || (r.quick && (r.phase === 'lobby' || r.phase === 'results'))))
  if (!eligible.length) return 'Create a public game · bots fill empty seats'
  const waiting = eligible.filter((r) => r.phase !== 'match').length
  if (eligible.length === 1) return waiting ? 'Join the open lobby · play with others' : 'Join the running game · play next round'
  return `Join an open game · ${eligible.length} available · ${waiting} waiting`
}
