import { describe, expect, it } from 'vitest'
import { feedText } from './Announce'
import { FeedTally } from './killTags'

const texts = (tags: { text: string }[]) => tags.map((t) => t.text)

describe('kill feed accolades', () => {
  it('tags First Blood on the first credited kill only', () => {
    const t = new FeedTally()
    expect(texts(t.death(1, 0, 1))).toEqual(['First Blood'])
    expect(texts(t.death(2, 3, 20))).toEqual([])
  })

  it("tags anyone's multi kill, not just the local player's (the voice only calls your own)", () => {
    const t = new FeedTally()
    t.death(1, 5, 1)
    expect(texts(t.death(2, 5, 2))).toEqual(['Double Kill'])
    expect(texts(t.death(3, 5, 4.5))).toEqual(['Triple Kill', 'Killing Spree'])
    // outside the multi-kill window the chain starts over
    expect(texts(t.death(4, 5, 30))).toEqual([])
  })

  it('tags Shutdown when a streak of 3+ ends, even by a lava push, and puts it before streaks', () => {
    const t = new FeedTally()
    for (const [victim, at] of [[1, 1], [2, 20], [3, 40]] as const) t.death(victim, 0, at)
    expect(texts(t.death(0, 4, 60))).toEqual(['Shutdown'])
    // the victim's streak is over: killing them again is no Shutdown
    expect(texts(t.death(0, 4, 90))).toEqual([])
  })

  it('credits nothing for a death without a killer or by your own hand', () => {
    const t = new FeedTally()
    expect(t.death(1, null, 1)).toEqual([])
    expect(t.death(1, 1, 2)).toEqual([])
    expect(texts(t.death(2, 0, 3))).toEqual(['First Blood'])
  })

  it('keeps at most two tags, loudest first, and starts over on reset', () => {
    const t = new FeedTally()
    // player 1 is on a streak of 3
    for (const [victim, at] of [[9, 0], [10, 5], [11, 10]] as const) t.death(victim, 1, at)
    t.death(8, 0, 15)
    t.death(7, 0, 25)
    t.death(6, 0, 40)
    t.death(5, 0, 41)
    // player 0's fifth kill, third in a chain, ends player 1's streak: Triple Kill, Shutdown, Rampage
    expect(texts(t.death(1, 0, 42))).toEqual(['Triple Kill', 'Shutdown'])
    t.reset()
    expect(texts(t.death(1, 0, 0))).toEqual(['First Blood'])
  })

  it('reads the accolades out to screen readers after the kill', () => {
    const t = new FeedTally()
    const tags = t.death(1, 0, 1)
    const who = { name: 'Thorn', color: '#fff' }
    expect(feedText({ killer: who, victim: { name: 'Ash', color: '#fff' }, cause: 'fireball', lava: false, local: false, tags })).toBe('Thorn killed Ash with Fireball: First Blood')
  })
})
