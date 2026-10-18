import type { PublicRoom } from '../../net/online'

/** Same public room eligibility as Quick Play; the join request also accounts for pending reservations. */
export function quickPlayAvailability(rooms: readonly PublicRoom[], region: string): string {
  const eligible = rooms.filter((r) => r.kind === 'server' && r.region.id === region &&
    typeof r.joinable === 'number' && r.joinable > 0 &&
    (r.phase === 'match' || (r.quick && (r.phase === 'lobby' || r.phase === 'results'))))
  if (!eligible.length) return 'No open games · start a new one'
  const waiting = eligible.filter((r) => r.phase !== 'match').length
  if (eligible.length === 1) return waiting ? '1 open lobby · join other players' : '1 game running · play next round'
  return `${eligible.length} open games · ${waiting} waiting to start`
}
