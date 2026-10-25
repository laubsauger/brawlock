import { cleanBuild } from '../game/stats'
import type { MatchHistoryEntry, GlobalMatchEntry } from './leaderboard'

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const integer = (v: unknown, max: number) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max
const only = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every((key) => keys.includes(key))
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function validHistoryBuild(value: unknown): boolean {
  return object(value) && only(value, ['slots', 'levels', 'masteries'])
    && object(value.masteries) && only(value.masteries, ['duration', 'range', 'lifesteal']) && !!cleanBuild(value)
}

/** Reject malformed records and private identity fields at the public response boundary. */
export function validMatchHistory(value: unknown): value is MatchHistoryEntry[] {
  return validMatches(value, true)
}
export function validGlobalMatches(value: unknown): value is GlobalMatchEntry[] {
  return validMatches(value, false)
}
function validMatches(value: unknown, personal: boolean): boolean {
  if (!Array.isArray(value) || value.length > 10) return false
  const matches = new Set<string>()
  for (const m of value) {
    if (!object(m) || !only(m, ['id', 'queue', 'at', 'region', 'ticks', 'rounds', 'teamMode', 'gameMode', 'players', ...(personal ? ['self', 'outcome', 'delta', 'rating'] : [])])
      || typeof m.id !== 'string' || !uuid.test(m.id) || matches.has(m.id)
      || !['ranked', 'casual', 'custom'].includes(m.queue as string) || !integer(m.at, 9_000_000_000_000)
      || typeof m.region !== 'string' || m.region.length > 32 || !integer(m.ticks, 60 * 60 * 24 * 60) || !integer(m.rounds, 10000)
      || !['ffa', 'teams', 'shuffle'].includes(m.teamMode as string) || !['rounds', 'deathmatch', 'hill'].includes(m.gameMode as string)
      || (personal && (!integer(m.self, 9) || !['win', 'loss', 'forfeit'].includes(m.outcome as string)
        || ![m.delta, m.rating].every((n) => n === null || typeof n === 'number' && Number.isFinite(n))))
      || !Array.isArray(m.players) || m.players.length < 1 || m.players.length > 10) return false
    const players = new Set<number>()
    for (const p of m.players) {
      if (!object(p) || !only(p, ['player', 'name', 'color', 'kind', 'team', 'score', 'roundsPlayed', 'roundsWon', 'kills', 'deaths', 'won', 'forfeited', 'build'])
        || !integer(p.player, 9) || players.has(p.player as number)
        || typeof p.name !== 'string' || p.name.length < 1 || p.name.length > 24 || /[\u0000-\u001f\u007f]/.test(p.name)
        || (p.color !== undefined && !integer(p.color, 0xffffff)) || (p.team !== undefined && !integer(p.team, 9))
        || (p.kind !== undefined && !['human', 'bot'].includes(p.kind as string))
        || (p.score !== undefined && (typeof p.score !== 'number' || !Number.isFinite(p.score)))
        || (p.roundsPlayed !== undefined && !integer(p.roundsPlayed, 10000)) || (p.roundsWon !== undefined && !integer(p.roundsWon, 10000))
        || !integer(p.kills, 1_000_000) || !integer(p.deaths, 1_000_000) || typeof p.won !== 'boolean'
        || (p.forfeited !== undefined && (typeof p.forfeited !== 'boolean' || p.forfeited && p.won))
        || (p.build !== undefined && !validHistoryBuild(p.build))) return false
      players.add(p.player as number)
    }
    if (personal) {
      if (!players.has(m.self as number)) return false
      const self = m.players.find((p) => object(p) && p.player === m.self)
      if (m.outcome !== (self.forfeited ? 'forfeit' : self.won ? 'win' : 'loss')) return false
    }
    matches.add(m.id)
  }
  return true
}
