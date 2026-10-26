import { describe, expect, it } from 'vitest'
import type { PublicRoom } from '../../net/online'
import { browseGames, quickPlayGames } from './quickPlay'

const room = (patch: Partial<PublicRoom> = {}): PublicRoom => ({ code: 'ABCDE', host: null, humans: 2, bots: 8, max: 10, joinable: 8, phase: 'lobby', quick: true, teamMode: 'ffa', gameMode: 'rounds', winScore: 5, kind: 'server', region: { id: 'eu' } as PublicRoom['region'], ...patch })
describe('Quick Play menu availability', () => {
  it('distinguishes an open lobby from a running match that seats you next round', () => {
    expect(quickPlayGames([room()], 'eu')).toEqual({ available: 1, waiting: 1 })
    expect(quickPlayGames([room({ phase: 'match' })], 'eu')).toEqual({ available: 1, waiting: 0 })
  })
  it('counts eligible matches and lobbies in the selected region, including replaceable bots', () => {
    expect(quickPlayGames([room(), room({ phase: 'match', quick: false }), room({ phase: 'results' })], 'eu')).toEqual({ available: 3, waiting: 2 })
  })
  it('excludes P2P games, full rooms, manual waiting rooms and other regions', () => {
    expect(quickPlayGames([room({ ranked: true }), room({ kind: 'p2p' }), room({ joinable: 0 }), room({ quick: false }), room({ quick: false, phase: 'results' }), room({ region: { id: 'us-west' } as PublicRoom['region'] })], 'eu')).toEqual({ available: 0, waiting: 0 })
  })
})
describe('Browse games menu availability', () => {
  it('counts only games a player can still join or watch, so the badge never advertises a dead end', () => {
    const rooms = [room(), room({ kind: 'p2p', quick: false, humans: 1 }), room({ ranked: true, phase: 'match' }), room({ humans: 10 })]
    expect(browseGames(rooms)).toEqual({ open: 2, players: 3 })
  })
  it('counts nothing when nothing is listed', () => {
    expect(browseGames([room({ ranked: true, phase: 'match' })])).toEqual({ open: 0, players: 0 })
  })
})
