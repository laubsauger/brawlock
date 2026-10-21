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

/**
 * Browse games menu entry: how many listed games a player could join or watch right now
 * (the Browse list greys out full rooms and ranked games already under way), and how many
 * people are in them, so the entry shows there is something to browse.
 */
export function browseAvailability(rooms: readonly PublicRoom[]): { open: number; sub: string } {
  const open = rooms.filter((r) => r.humans < r.max && !(r.ranked && r.phase !== 'lobby'))
  if (!open.length) return { open: 0, sub: 'No open games right now' }
  const players = open.reduce((n, r) => n + r.humans, 0)
  return { open: open.length, sub: `${open.length} open ${open.length === 1 ? 'game' : 'games'} · ${players} ${players === 1 ? 'player' : 'players'}` }
}
