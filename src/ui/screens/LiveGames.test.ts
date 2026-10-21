import { describe, expect, it } from 'vitest'
import type { PublicRoom } from '../../net/online'
import { liveGames } from './LiveGames'

const room = (patch: Partial<PublicRoom> = {}): PublicRoom => ({ code: 'ABCDE', host: 'Mira', humans: 2, bots: 6, max: 10, joinable: 6, phase: 'lobby', quick: false, teamMode: 'ffa', gameMode: 'rounds', winScore: 5, kind: 'server', region: { id: 'eu', label: 'Europe' } as PublicRoom['region'], ...patch })

describe('main menu open games', () => {
  it('shows only games with people in them that a newcomer can still enter, so every row leads somewhere', () => {
    const shown = liveGames([
      room({ code: 'BOTS1', humans: 0 }),
      room({ code: 'FULL1', humans: 10 }),
      room({ code: 'RANK1', ranked: true, phase: 'match' }),
      room({ code: 'DRAIN', region: { id: 'eu', label: 'Europe', maintenance: { draining: true, message: null } } as PublicRoom['region'] }),
      room({ code: 'OPEN1' }),
      room({ code: 'WATCH', phase: 'match', joinable: 0 }),
    ])
    expect(shown.map((r) => r.code)).toEqual(['OPEN1', 'WATCH'])
  })
  it('keeps the menu short: at most three, in the order Browse games lists them', () => {
    expect(liveGames(['A', 'B', 'C', 'D'].map((code) => room({ code }))).map((r) => r.code)).toEqual(['A', 'B', 'C'])
  })
})
