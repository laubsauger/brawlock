import { describe, expect, it } from 'vitest'
import { openLeaderboard } from '../../server/leaderboard-store.mjs'
import { localRatingAuthority, type RatingSubmission } from './ratingAuthority'

const first = 'a_account-first'
const second = 'a_account-second'
function submission(key: string, at: number, region = 'us'): RatingSubmission {
  return { key, at, region, room: 'ABCDE', minSeconds: 1, match: {
    ticks: 120, rounds: 1, teamMode: 'ffa', gameMode: 'rounds', bots: 0,
    seats: [
      { player: 0, device: first, name: 'CinderFox', roundsPlayed: 1, roundsWon: 1, kills: 1, deaths: 0, won: true },
      { player: 1, device: second, name: 'AshMage', roundsPlayed: 1, roundsWon: 0, kills: 0, deaths: 1, won: false },
    ], ranked: [{ groups: [[0], [1]], team: { 0: 0, 1: 1 } }],
  } }
}

describe('account-ranked canonical rating names', () => {
  it('preserves verified match-time labels while current reserved names overlay boards and public profiles', async () => {
    const store = openLeaderboard(':memory:')
    let names = new Map([[first, 'CinderFox'], [second, 'AshMage']])
    const authority = localRatingAuthority(store, { minSeconds: 1, clock: () => 10_000,
      names: async (devices) => new Map(devices.map((device) => [device, names.get(device)!])) })
    try {
      const original = submission('account-match-first', 2000)
      expect(await authority.record(original)).toEqual({ status: 'rated' })
      expect(store.players([first]).get(first)?.name).toBe('CinderFox')
      names = new Map([[first, 'PhoenixMage'], [second, 'AshMage']])
      const board = await authority.read(`/leaderboard?period=all&device=${first}`)
      expect(board.body).toMatchObject({ you: { name: 'PhoenixMage', matches: 1 }, entries: [{ name: 'PhoenixMage' }, { name: 'AshMage' }] })
      const publicId = (board.body as { you: { publicId: string } }).you.publicId
      expect((await authority.read(`/profiles/${publicId}`)).body).toMatchObject({ name: 'PhoenixMage', matches: 1 })
      expect((await authority.read(`/players/${first}`)).body).toMatchObject({ name: 'PhoenixMage', matches: 1 })
      // An older EU result arrives after rename; its original payload stays retryable.
      const delayed = submission('account-match-delayed', 1000, 'eu')
      expect(await authority.record(delayed)).toEqual({ status: 'rated' })
      expect(store.players([first]).get(first)).toMatchObject({ name: 'CinderFox', matches: 2, firstAt: 1000, lastAt: 2000 })
      expect((await authority.read(`/players/${first}`)).body).toMatchObject({ name: 'PhoenixMage', matches: 2 })
      expect(delayed.match.seats[0].name).toBe('CinderFox')
      expect(await authority.record(original)).toEqual({ status: 'rated' })
      expect(await authority.record(delayed)).toEqual({ status: 'rated' })
      expect(store.players([first]).get(first)?.matches).toBe(2)
    } finally { authority.close!() }
  })

  it('commits ranked results locally while account names are offline and resumes canonical reads without duplicating original receipts', async () => {
    const store = openLeaderboard(':memory:')
    let offline = false
    let lookups = 0
    const authority = localRatingAuthority(store, { minSeconds: 1, names: async () => {
      lookups++
      if (offline) throw new Error('Account authority unavailable')
      return new Map([[first, 'PhoenixMage'], [second, 'AshMage']])
    } })
    try {
      const original = submission('account-name-known', 1000)
      expect(await authority.record(original)).toEqual({ status: 'rated' })
      expect(lookups).toBe(0)
      offline = true
      await expect(authority.read('/leaderboard')).rejects.toThrow(/Account authority unavailable/)
      const duringOutage = submission('account-name-offline', 2000, 'eu')
      expect(await authority.record(duringOutage)).toEqual({ status: 'rated' })
      expect(await authority.record(original)).toEqual({ status: 'rated' })
      expect(await authority.record(duringOutage)).toEqual({ status: 'rated' })
      expect(lookups).toBe(1)
      expect(store.players([first]).get(first)).toMatchObject({ name: 'CinderFox', matches: 2 })
      offline = false
      expect((await authority.read(`/players/${first}`)).body).toMatchObject({ name: 'PhoenixMage', matches: 2 })
      expect(await authority.record(duringOutage)).toEqual({ status: 'rated' })
      expect(store.players([first]).get(first)?.matches).toBe(2)
    } finally { authority.close!() }
  })

  it('refuses incomplete canonical name reads instead of displaying historical labels as current identities', async () => {
    const store = openLeaderboard(':memory:')
    const authority = localRatingAuthority(store, { minSeconds: 1, names: async () => new Map() })
    try {
      expect(await authority.record(submission('account-name-unresolved', 1000))).toEqual({ status: 'rated' })
      await expect(authority.read('/leaderboard')).rejects.toThrow(/Missing canonical player name/)
    } finally { authority.close!() }
  })
})
