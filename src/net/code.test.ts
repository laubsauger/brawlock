import { describe, expect, it } from 'vitest'
import { CODE_ALPHABET, CODE_LENGTH, codeFromSearch, newRoomCode, parseRoomCode, peerIdForCode, roomLink } from './code'

describe('room codes', () => {
  /** Why: codes are read out loud and typed; I/O would be confused with 1/0. */
  it('are 5 letters without I or O', () => {
    for (let i = 0; i < 2000; i++) {
      const c = newRoomCode()
      expect(c).toMatch(/^[A-HJ-NP-Z]{5}$/)
    }
    expect(CODE_ALPHABET).not.toMatch(/[IO]/)
    expect(CODE_LENGTH).toBe(5)
  })

  it('use every letter (crypto, no modulo bias toward the start of the alphabet)', () => {
    const seen = new Map<string, number>()
    for (let i = 0; i < 4000; i++) for (const ch of newRoomCode()) seen.set(ch, (seen.get(ch) ?? 0) + 1)
    expect(seen.size).toBe(CODE_ALPHABET.length)
    const counts = [...seen.values()]
    // 20000 letters / 24 ≈ 833 each; a biased generator would skew far more than this
    expect(Math.min(...counts)).toBeGreaterThan(650)
    expect(Math.max(...counts)).toBeLessThan(1020)
  })

  it('normalize the ways people type or paste them', () => {
    expect(parseRoomCode('krzbw')).toEqual({ code: 'KRZBW' })
    expect(parseRoomCode(' krz-bw ')).toEqual({ code: 'KRZBW' })
    expect(parseRoomCode('K R Z B W')).toEqual({ code: 'KRZBW' })
    expect(parseRoomCode('https://x.github.io/brawlock/?room=KRZBW')).toEqual({ code: 'KRZBW' })
  })

  it('explain what is wrong with a bad code', () => {
    expect(parseRoomCode('')).toHaveProperty('problem')
    expect(parseRoomCode('KROBW')).toEqual({ problem: expect.stringMatching(/I or O/) })
    expect(parseRoomCode('KR0BW')).toEqual({ problem: expect.stringMatching(/I or O/) }) // digit zero
    expect(parseRoomCode('KRZ5W')).toEqual({ problem: expect.stringMatching(/letters only/) })
    expect(parseRoomCode('KR')).toEqual({ problem: expect.stringMatching(/5 letters; this one has 2/) })
  })

  it('round-trip through the invite link', () => {
    const url = roomLink('https://x.github.io/brawlock/?join=old', 'KRZBW')
    expect(url).toBe('https://x.github.io/brawlock/?room=KRZBW')
    expect(codeFromSearch(new URL(url).search)).toBe('KRZBW')
    expect(codeFromSearch('?room=KR0BW')).toBeNull()
    expect(codeFromSearch('')).toBeNull()
    expect(peerIdForCode('KRZBW')).toBe('brawlock-KRZBW')
  })
})
