import { describe, expect, it } from 'vitest'
import { BOUNTY_SPELLS, CHAMPIONS, DAY_MS, LAUNCH_DAY, OMENS, dailyNumber, dayOf, defineDay } from './calendar'

/**
 * Everyone plays the same day (docs/moonshot/specs/daily.md): the day must turn at 00:00 UTC
 * whatever the local clock, and a started day must never change under the players who played it.
 */
describe('daily calendar', () => {
  it('turns at 00:00 UTC exactly', () => {
    const start = LAUNCH_DAY * DAY_MS
    expect(dayOf(start - 1)).toBe(LAUNCH_DAY - 1)
    expect(dayOf(start)).toBe(LAUNCH_DAY)
    expect(dayOf(start + DAY_MS - 1)).toBe(LAUNCH_DAY)
    expect(dailyNumber(LAUNCH_DAY)).toBe(1)
  })

  it('a champion per weekday: Daily #1 is a Monday, Sunday has the Brutal Abbess', () => {
    expect(defineDay(LAUNCH_DAY).champion).toBe(CHAMPIONS[1])
    expect(defineDay(LAUNCH_DAY + 6).champion.tier).toBe('brutal')
    for (let d = LAUNCH_DAY; d < LAUNCH_DAY + 14; d++) expect(defineDay(d).champion).toBe(defineDay(d + 7).champion)
  })

  it('each omen once per nine-day cycle, never the same omen across a cycle boundary', () => {
    for (let cycle = Math.floor(LAUNCH_DAY / 9); cycle < Math.floor(LAUNCH_DAY / 9) + 60; cycle++) {
      const ids = Array.from({ length: 9 }, (_, i) => defineDay(cycle * 9 + i).omen.id)
      expect(new Set(ids).size).toBe(OMENS.length)
      expect(defineDay(cycle * 9 + 9).omen.id).not.toBe(ids[8])
    }
  })

  it('never the same bounty two days running, always from the list', () => {
    for (let d = LAUNCH_DAY; d < LAUNCH_DAY + 400; d++) {
      const b = defineDay(d).bounty
      expect(BOUNTY_SPELLS).toContain(b)
      expect(defineDay(d + 1).bounty).not.toBe(b)
    }
  })

  it('five waves of seven bots and the champion, with fixed builds', () => {
    const day = defineDay(LAUNCH_DAY + 3)
    expect(day.waves.map((w) => w.map((b) => b.tier))).toEqual([['easy'], ['easy', 'easy'], ['medium', 'easy'], ['medium', 'medium'], ['hard']])
    expect(day.waves[4][0]).toMatchObject({ champion: true, name: 'Brother Thrum', build: 'brawler' })
    expect(new Set(day.waves.flat().map((b) => b.seat)).size).toBe(8)
  })

  // A started day must not change: this table fails when a definition moves (add a `from` day instead).
  it('the first 21 days stay as defined', () => {
    const GOLDEN = [[1,"Cinder","slickStone","snowball","artillery,blink,leech,blink,leech,duelist,hunter,duelist"],[2,"Rook","feast","boomerang","blink,hunter,duelist,artillery,brawler,leech,blink,blink"],[3,"Mother Ash","hungryLava","snowball","artillery,duelist,hunter,blink,leech,brawler,artillery,artillery"],[4,"Thrum","leanYear","cluster","duelist,artillery,brawler,leech,blink,hunter,duelist,brawler"],[5,"Vesper","bloodMoon","snowball","duelist,leech,blink,artillery,brawler,hunter,duelist,leech"],[6,"Old Hob","slickStone","thrust","hunter,blink,leech,brawler,artillery,duelist,hunter,hunter"],[7,"the Abbess","leanYear","homing","leech,duelist,hunter,brawler,artillery,blink,leech,brawler"],[8,"Cinder","glassBones","meteor","blink,hunter,duelist,artillery,brawler,leech,blink,duelist"],[9,"Rook","clear","bouncer","duelist,leech,blink,leech,blink,artillery,brawler,blink"],[10,"Mother Ash","coldLava","snowball","brawler,hunter,duelist,leech,blink,artillery,brawler,artillery"],[11,"Thrum","feast","homing","artillery,blink,leech,duelist,hunter,brawler,artillery,brawler"],[12,"Vesper","suddenCollapse","bouncer","duelist,leech,blink,artillery,brawler,hunter,duelist,leech"],[13,"Old Hob","hungryLava","boomerang","hunter,brawler,artillery,brawler,artillery,blink,leech,hunter"],[14,"the Abbess","slickStone","snowball","blink,artillery,brawler,hunter,duelist,leech,blink,hunter"],[15,"Cinder","leanYear","boomerang","leech,duelist,hunter,duelist,hunter,brawler,artillery,duelist"],[16,"Rook","hungryLava","cluster","brawler,leech,blink,hunter,duelist,artillery,brawler,blink"],[17,"Mother Ash","clear","homing","leech,brawler,artillery,duelist,hunter,blink,leech,artillery"],[18,"Thrum","coldLava","boomerang","brawler,leech,blink,hunter,duelist,artillery,brawler,brawler"],[19,"Vesper","bloodMoon","homing","artillery,blink,leech,blink,leech,duelist,hunter,leech"],[20,"Old Hob","suddenCollapse","cluster","hunter,brawler,artillery,blink,leech,duelist,hunter,hunter"],[21,"the Abbess","feast","lightning","blink,artillery,brawler,hunter,duelist,leech,blink,artillery"]]
    const now = Array.from({ length: 21 }, (_, i) => {
      const x = defineDay(LAUNCH_DAY + i)
      return [x.number, x.champion.short, x.omen.id, x.bounty, x.waves.flat().map((b) => b.build).join(',')]
    })
    expect(now).toEqual(GOLDEN)
  })
})
