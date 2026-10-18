/**
 * How the stats read on screen: distances in tiles (one arena tile is 192
 * game units; one unit everywhere, so "31 tiles" means the same on every
 * screen), times as seconds or m:ss, award values by their unit, kill causes
 * by name, and a rating trend replayed from the stored matches.
 */
import { ELO_START, eloUpdate, pairOutcome, type Award, type MatchRecord } from '../../game/stats'
import { displayName } from '../data/catalog'

export const TILE_UNITS = 192

/** 5800 -> "30 tiles", 150 -> "1 tile", 40 -> "under a tile" */
export function tiles(units: number): string {
  if (units < TILE_UNITS * 0.5) return units <= 0 ? '0 tiles' : 'under a tile'
  const n = Math.round(units / TILE_UNITS)
  return `${n.toLocaleString()} ${n === 1 ? 'tile' : 'tiles'}`
}

/** 12.4 -> "12 s", 75 -> "1:15", 3725 -> "1:02:05" */
export function seconds(s: number): string {
  const t = Math.max(0, Math.round(s))
  if (t < 60) return `${t} s`
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = String(t % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** 0.62 -> "62%" (shares are stored as 0..1) */
export function percent(share: number | null): string {
  return share == null ? '–' : `${Math.round(share * 100)}%`
}

/** An award's value as players read it. */
export function awardValue(a: Pick<Award, 'value' | 'unit'>): string {
  switch (a.unit) {
    case 'u':
      return tiles(a.value)
    case 's':
      return seconds(a.value)
    case '%':
      return percent(a.value)
    default:
      return Math.round(a.value).toLocaleString()
  }
}

/** Kill / death cause id -> name ('lava', 'obstacle', spell ids). */
export function causeLabel(id: string): string {
  if (id === 'lava') return 'Lava'
  if (id === 'obstacle') return 'Pillar blast'
  if (id === 'disconnect') return 'Left the game'
  if (id === 'unknown' || !id) return 'Other'
  return displayName(id) || id
}

/** Icon (a spell / item id from /icons) per award, picked for what the award is about. */
export const AWARD_ICON: Record<string, string> = {
  butcher: 'fireball',
  marathon: 'boots',
  pinball: 'bouncer',
  frequentFlyer: 'thrust',
  lavaLover: 'meteor',
  oops: 'cursed_ring',
  sniper: 'lightning',
  untouchable: 'armor',
  escapeArtist: 'teleport',
  ringOfFire: 'scourge',
}

/**
 * Your rating after each stored match, oldest first, replayed with the same
 * Elo rule the record uses. The history keeps the last 200 matches, so when
 * you have played more the replay starts late; it is then shifted so its end
 * meets your stored rating (the shape stays exact, the start is anchored).
 * Empty when you have not played.
 */
export function ratingTrend(history: readonly MatchRecord[], selfProfileId: string, current: number | null): number[] {
  const ratings = new Map<string, number>()
  const out: number[] = []
  for (const rec of [...history].reverse()) {
    const ps = rec.participants
    const before = ps.map((p) => ratings.get(p.profileId) ?? ELO_START)
    const after = eloUpdate(before, (i, j) => pairOutcome(rec, ps[i], ps[j]))
    ps.forEach((p, i) => ratings.set(p.profileId, after[i]))
    const me = ps.find((p) => p.player === rec.self)
    if (me && me.profileId === selfProfileId) out.push(after[ps.indexOf(me)])
  }
  if (out.length && current != null) {
    const shift = current - out[out.length - 1]
    if (Math.abs(shift) > 0.5) return out.map((v) => v + shift)
  }
  return out
}
