import { describe, expect, it } from 'vitest'
import type { PublicRoom } from '../../net/online'
import { browseAvailability, quickPlayAvailability } from './quickPlay'

const room = (patch: Partial<PublicRoom> = {}): PublicRoom => ({ code: 'ABCDE', host: null, humans: 2, bots: 8, max: 10, joinable: 8, phase: 'lobby', quick: true, teamMode: 'ffa', gameMode: 'rounds', winScore: 5, kind: 'server', region: { id: 'eu' } as PublicRoom['region'], ...patch })
describe('Quick Play menu availability', () => {
  it('distinguishes an open lobby from a running match that seats you next round', () => {
    expect(quickPlayAvailability([room()], 'eu')).toBe('Join the open lobby · play with others')
    expect(quickPlayAvailability([room({ phase: 'match' })], 'eu')).toBe('Join the running game · play next round')
  })
  it('counts eligible matches and lobbies in the selected region, including replaceable bots', () => {
    expect(quickPlayAvailability([room(), room({ phase: 'match', quick: false }), room({ phase: 'results' })], 'eu')).toBe('Join an open game · 3 available · 2 waiting')
  })
  it('excludes P2P games, full rooms, manual waiting rooms and other regions', () => {
    expect(quickPlayAvailability([room({ ranked: true }), room({ kind: 'p2p' }), room({ joinable: 0 }), room({ quick: false }), room({ quick: false, phase: 'results' }), room({ region: { id: 'us-west' } as PublicRoom['region'] })], 'eu')).toBe('Create a public game · bots fill empty seats')
  })
})
describe('Browse games menu availability', () => {
  it('counts only games a player can still join or watch, so the badge never advertises a dead end', () => {
    const rooms = [room(), room({ kind: 'p2p', quick: false, humans: 1 }), room({ ranked: true, phase: 'match' }), room({ humans: 10 })]
    expect(browseAvailability(rooms)).toEqual({ open: 2, sub: '2 open games · 3 players' })
  })
  it('says plainly when nothing is listed', () => {
    expect(browseAvailability([room({ ranked: true, phase: 'match' })])).toEqual({ open: 0, sub: 'No open games right now' })
  })
})
