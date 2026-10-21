import type { MatchRecord } from '../../game/stats'
import type { PublicRoom } from '../../net/online'

interface EloLabel { label: string; title: string; tone: string }
const neutral = 'text-ash'

/** Live policy is provisional: duration, distinct devices and participation settle at the end. */
export function liveEloLabel(room: PublicRoom): EloLabel {
  if (room.kind === 'p2p') return { label: 'Unranked', title: 'Player-hosted games do not affect global Elo.', tone: neutral }
  if (!room.elo) return { label: 'Elo unknown', title: 'This server has not supplied its Elo policy.', tone: neutral }
  if (!room.elo.enabled) return { label: 'Unranked', title: 'This server does not record global Elo.', tone: neutral }
  const format = room.rankedRounds ? `${room.max} players · ${room.rankedRounds} rounds plus a final brawl for tied leaders. Target 15–20 minutes; match length varies. ` : ''
  const title = format + `Global Elo counts after a completed match of at least ${room.elo.minSeconds} seconds with two humans on distinct devices who played a round together (or until one of them left). Leaving a match that counts is a loss. Bots do not contribute to Elo.`
  return { label: room.humans < 2 ? 'Elo · needs 2 humans' : 'Elo enabled', title, tone: 'text-gold' }
}

/** Never infer a historical verdict from player counts or local Elo. */
export function historyEloLabel(record: Pick<MatchRecord, 'rating'>): EloLabel {
  const rating = record.rating
  if (!rating) return { label: 'Elo unknown', title: 'This older record did not save a global Elo verdict.', tone: neutral }
  if (rating.status === 'rated') return { label: 'Elo rated', title: 'The server confirmed this match was recorded for global Elo.', tone: 'text-gold' }
  if (rating.status === 'unavailable') return { label: 'Elo unavailable', title: rating.reason ?? 'The server could not confirm the global Elo result.', tone: neutral }
  return { label: 'Unranked', title: rating.reason ? `No global Elo: ${rating.reason}` : 'This match did not affect global Elo.', tone: neutral }
}
