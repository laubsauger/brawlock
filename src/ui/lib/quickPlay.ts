import type { PublicRoom } from '../../net/online'

/**
 * Same public room eligibility as Quick Play (King of the Hill and other casual games are separate
 * queues); the join request also accounts for pending reservations. `waiting`: eligible lobbies
 * and results screens, the rest are running matches that seat a joiner next round.
 */
export function quickPlayGames(rooms: readonly PublicRoom[], region: string, hill = false): { available: number; waiting: number } {
  const eligible = rooms.filter((r) => r.kind === 'server' && !r.ranked && r.region.id === region && (r.gameMode === 'hill') === hill &&
    typeof r.joinable === 'number' && r.joinable > 0 &&
    (r.phase === 'match' || (r.quick && (r.phase === 'lobby' || r.phase === 'results'))))
  return { available: eligible.length, waiting: eligible.filter((r) => r.phase !== 'match').length }
}

/** The Quick Play menu line for those games. */
export function quickPlayAvailability(rooms: readonly PublicRoom[], region: string, hill = false): string {
  const { available, waiting } = quickPlayGames(rooms, region, hill)
  if (!available) return 'Create a public game · bots fill empty seats'
  if (available === 1) return waiting ? 'Join the open lobby · play with others' : 'Join the running game · play next round'
  return `Join an open game · ${available} available · ${waiting} waiting`
}

/**
 * Browse games menu entry: how many listed games a player could join or watch right now
 * (the Browse list greys out full rooms and ranked games already under way), and how many
 * people are in them, so the entry shows there is something to browse.
 */
export function browseGames(rooms: readonly PublicRoom[]): { open: number; players: number } {
  const open = rooms.filter((r) => r.humans < r.max && !(r.ranked && r.phase !== 'lobby'))
  return { open: open.length, players: open.reduce((n, r) => n + r.humans, 0) }
}

/** The Browse games entry's count line for those games. */
export function browseAvailability(rooms: readonly PublicRoom[]): { open: number; sub: string } {
  const { open, players } = browseGames(rooms)
  if (!open) return { open: 0, sub: 'No open games right now' }
  return { open, sub: `${open} open ${open === 1 ? 'game' : 'games'} · ${players} ${players === 1 ? 'player' : 'players'}` }
}
