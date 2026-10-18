import { describe, expect, it } from 'vitest'
import { ELO_START, type MatchRecord, type Participant } from '../../game/stats'
import { awardValue, causeLabel, ratingTrend, seconds, tiles, TILE_UNITS } from './statFormat'

describe('stats read in one friendly unit', () => {
  it('shows distances in tiles everywhere (a tile is 192 game units)', () => {
    expect(tiles(TILE_UNITS * 31)).toBe('31 tiles')
    expect(tiles(TILE_UNITS)).toBe('1 tile')
    expect(tiles(40)).toBe('under a tile')
    expect(tiles(0)).toBe('0 tiles')
  })

  it('shows times as seconds, then m:ss', () => {
    expect(seconds(12.4)).toBe('12 s')
    expect(seconds(75)).toBe('1:15')
  })

  it('formats award values by their unit; shares are stored as 0..1', () => {
    expect(awardValue({ value: 0.62, unit: '%' })).toBe('62%')
    expect(awardValue({ value: TILE_UNITS * 9, unit: 'u' })).toBe('9 tiles')
    expect(awardValue({ value: 14.2, unit: 's' })).toBe('14 s')
    expect(awardValue({ value: 5, unit: '' })).toBe('5')
  })

  it('names kill causes', () => {
    expect(causeLabel('lava')).toBe('Lava')
    expect(causeLabel('fireball')).toBe('Fireball')
  })
})

const part = (player: number, profileId: string, won: boolean, score: number): Participant => ({ player, profileId, name: profileId, color: 0, kind: 'human', team: player, score, kills: 0, deaths: 0, damage: 0, won })
const match = (id: string, meWon: boolean): MatchRecord =>
  ({ id, date: 0, teamMode: 'ffa', gameMode: 'rounds', settings: {} as MatchRecord['settings'], rounds: 3, durationSec: 60, participants: [part(0, 'me', meWon, meWon ? 3 : 1), part(1, 'bot:hard', !meWon, meWon ? 1 : 3)], winners: [meWon ? 0 : 1], self: 0, outcome: meWon ? 'win' : 'loss', kills: [], damage: [] }) as MatchRecord

describe('rating trend', () => {
  it('replays your rating match by match, up after a win and down after a loss', () => {
    // history is newest first, as stored
    const trend = ratingTrend([match('c', false), match('b', true), match('a', true)], 'me', null)
    expect(trend).toHaveLength(3)
    expect(trend[0]).toBeGreaterThan(ELO_START)
    expect(trend[1]).toBeGreaterThan(trend[0])
    expect(trend[2]).toBeLessThan(trend[1])
  })

  it('anchors the end to the stored rating when older matches fell out of the history', () => {
    const trend = ratingTrend([match('b', true), match('a', true)], 'me', 1700)
    expect(Math.round(trend[trend.length - 1])).toBe(1700)
  })

  it('is empty before your first match', () => {
    expect(ratingTrend([], 'me', null)).toEqual([])
  })
})
