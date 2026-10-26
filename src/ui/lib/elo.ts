import type { MatchRecord } from '../../game/stats'
import type { PublicRoom } from '../../net/online'

interface EloLabel { label: string; title: string; tone: string }
const neutral = 'text-ash'

/** A live room's Elo policy as the server states it; liveEloLabel words it. */
export type LiveElo =
  | { kind: 'playerHosted' } | { kind: 'unknown' } | { kind: 'off' }
  | { kind: 'on'; needsHumans: boolean; minSeconds: number; ranked: { players: number; rounds: number } | null }

/** Live policy is provisional: duration, distinct devices and participation settle at the end. */
export function liveElo(room: PublicRoom): LiveElo {
  if (room.kind === 'p2p') return { kind: 'playerHosted' }
  if (!room.elo) return { kind: 'unknown' }
  if (!room.elo.enabled) return { kind: 'off' }
  // bots never count toward the two humans
  return { kind: 'on', needsHumans: room.humans < 2, minSeconds: room.elo.minSeconds, ranked: room.rankedRounds ? { players: room.max, rounds: room.rankedRounds } : null }
}

export function liveEloLabel(room: PublicRoom): EloLabel {
  const elo = liveElo(room)
  if (elo.kind === 'playerHosted') return { label: 'Unranked', title: 'Player-hosted games do not affect global Elo.', tone: neutral }
  if (elo.kind === 'unknown') return { label: 'Elo unknown', title: 'This server has not supplied its Elo policy.', tone: neutral }
  if (elo.kind === 'off') return { label: 'Unranked', title: 'This server does not record global Elo.', tone: neutral }
  const format = elo.ranked ? `${elo.ranked.players} players · ${elo.ranked.rounds} rounds plus a final brawl for tied leaders. Target 15–20 minutes; match length varies. ` : ''
  const title = format + `Global Elo counts after a completed match of at least ${elo.minSeconds} seconds with two humans on distinct devices who played a round together (or until one of them left). Leaving a match that counts is a loss. Bots do not contribute to Elo.`
  return { label: elo.needsHumans ? 'Elo · needs 2 humans' : 'Elo enabled', title, tone: 'text-gold' }
}

/** A saved match's Elo verdict exactly as the server recorded it; historyEloLabel words it. */
export function historyElo(record: Pick<MatchRecord, 'rating'>): { status: 'unknown' | 'rated' | 'unrated' | 'unavailable'; reason: string | null } {
  return { status: record.rating?.status ?? 'unknown', reason: record.rating?.reason ?? null }
}

/** Never infer a historical verdict from player counts or local Elo. */
export function historyEloLabel(record: Pick<MatchRecord, 'rating'>): EloLabel {
  const { status, reason } = historyElo(record)
  if (status === 'unknown') return { label: 'Elo unknown', title: 'This older record did not save a global Elo verdict.', tone: neutral }
  if (status === 'rated') return { label: 'Elo rated', title: 'The server confirmed this match was recorded for global Elo.', tone: 'text-gold' }
  if (status === 'unavailable') return { label: 'Elo unavailable', title: reason ?? 'The server could not confirm the global Elo result.', tone: neutral }
  return { label: 'Unranked', title: reason ? `No global Elo: ${reason}` : 'This match did not affect global Elo.', tone: neutral }
}
