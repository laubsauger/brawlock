import { describe, expect, it } from 'vitest'
import type { PublicRoom } from '../../net/online'
import { quickPlayAvailability } from './quickPlay'

const room = (patch: Partial<PublicRoom> = {}): PublicRoom => ({ code: 'ABCDE', host: null, humans: 2, bots: 8, max: 10, joinable: 8, phase: 'lobby', quick: true, teamMode: 'ffa', gameMode: 'rounds', winScore: 5, kind: 'server', region: { id: 'eu' } as PublicRoom['region'], ...patch })
describe('Quick Play menu availability', () => {
  it('distinguishes an open lobby from a running match that seats you next round', () => {
    expect(quickPlayAvailability([room()], 'eu')).toBe('1 open lobby · join other players')
    expect(quickPlayAvailability([room({ phase: 'match' })], 'eu')).toBe('1 game running · play next round')
  })
  it('counts eligible matches and lobbies in the selected region, including replaceable bots', () => {
    expect(quickPlayAvailability([room(), room({ phase: 'match', quick: false }), room({ phase: 'results' })], 'eu')).toBe('3 open games · 2 waiting to start')
  })
  it('excludes P2P games, full rooms, manual waiting rooms and other regions', () => {
    expect(quickPlayAvailability([room({ kind: 'p2p' }), room({ joinable: 0 }), room({ quick: false }), room({ quick: false, phase: 'results' }), room({ region: { id: 'us-west' } as PublicRoom['region'] })], 'eu')).toBe('No open games · start a new one')
  })
})
