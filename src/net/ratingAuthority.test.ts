import { describe, expect, it } from 'vitest'
import { openLeaderboard } from '../../server/leaderboard-store.mjs'
import { localRatingAuthority, validRatingSubmission, type RatingSubmission } from './ratingAuthority'
import { validMatchHistory, validGlobalMatches } from './matchHistory'
import { createMatch, DEFAULT_SETTINGS } from '../sim'
import { MatchTracker } from '../game/stats'

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

describe('authoritative casual and ranked match history', () => {
  it('publishes explicit public results from both regions without exposing private or unfinished games', async () => {
    const authority = localRatingAuthority(openLeaderboard(':memory:'), { minSeconds: 1 })
    try {
      for (const [index, region] of ['eu', 'us'].entries()) {
        await authority.record({ ...submission(`public-match-${region}`, 1000 + index, region), queue: 'casual', public: true })
      }
      await authority.record({ ...submission('private-match-result', 3000), queue: 'ranked', public: false })
      await authority.record({ ...submission('legacy-match-result', 4000), queue: 'custom' })
      const response = await authority.read('/matches?limit=10')
      expect(response.status).toBe(200)
      const matches = (response.body as { matches: unknown }).matches
      expect(validGlobalMatches(matches)).toBe(true)
      expect(matches).toMatchObject([{ region: 'us', queue: 'casual' }, { region: 'eu', queue: 'casual' }])
      expect((matches as unknown[]).length).toBe(2)
      expect(JSON.stringify(matches)).not.toMatch(/a_account|ABCDE|device|receipt|"self"/)
      expect((await authority.read('/matches?queue=ranked')).body).toEqual({ matches: [] })
      for (const path of ['/matches?limit=11', '/matches?limit=0', '/matches?queue=invalid']) expect((await authority.read(path)).status).toBe(400)
      expect(validRatingSubmission({ ...submission('invalid-public-flag', 5000), public: 'yes' })).toBe(false)
    } finally { authority.close!() }
  })

  it('keeps casual-only history and equipment without changing Elo, then filters ranked results and deduplicates retries', async () => {
    const store = openLeaderboard(':memory:')
    const authority = localRatingAuthority(store, { minSeconds: 1 })
    try {
      const casual = { ...submission('history-casual-first', 1000), queue: 'casual' as const }
      const slots = casual.match.seats.map((s) => ({ id: s.player, name: s.name, kind: 'human' as const, team: s.player, color: s.player + 1 }))
      const state = createMatch(DEFAULT_SETTINGS, slots, 42)
      const tracker = new MatchTracker({ localPlayer: 0, settings: DEFAULT_SETTINGS, slots })
      tracker.observe(state, [])
      casual.match.roster = casual.match.seats.map((s) => ({ ...s, kind: 'human', color: s.player + 1, team: s.player,
        build: tracker.buildOf(s.player)! }))
      expect(validRatingSubmission(casual)).toBe(true)
      const build = casual.match.roster[0].build!
      expect(validRatingSubmission({ ...casual, match: { ...casual.match, roster: casual.match.roster.map((p) => ({ ...p, build: { ...build, device: first } })) } })).toBe(false)
      expect(validRatingSubmission({ ...casual, match: { ...casual.match, roster: casual.match.roster.map((p) => ({ ...p, build: { ...build, masteries: { ...build.masteries, profileId: first } } })) } })).toBe(false)
      expect(await authority.record(casual)).toMatchObject({ status: 'unrated' })
      expect(store.players([first, second]).size).toBe(0)
      expect(await authority.record(casual)).toMatchObject({ status: 'unrated' })
      const read = await authority.read(`/players/${first}/history?queue=casual`)
      const matches = (read.body as { matches: unknown }).matches
      expect(validMatchHistory(matches)).toBe(true)
      expect(matches).toMatchObject([{ queue: 'casual', self: 0, outcome: 'win', delta: null,
        players: [{ build: tracker.buildOf(0) }, { build: tracker.buildOf(1) }] }])
      expect(JSON.stringify(read.body)).not.toMatch(/a_account|device|ABCDE|history-casual-first/)
      expect((await authority.read(`/players/${first}/history?queue=ranked`)).body).toEqual({ matches: [] })

      const ranked = { ...submission('history-ranked-next', 2000), queue: 'ranked' as const }
      expect(await authority.record(ranked)).toEqual({ status: 'rated' })
      expect(await authority.record(ranked)).toEqual({ status: 'rated' })
      expect(store.history(first, { limit: 10 })).toHaveLength(2)
      const row = store.top({ period: 'all', region: null, since: 0 }, 10).find((r) => r.device === first)!
      const publicHistory = await authority.read(`/profiles/${row.publicId}/history?queue=casual`)
      expect(publicHistory.body).toEqual(read.body)
      expect(store.history(first, { queue: 'ranked', limit: 10 })[0]).toMatchObject({ outcome: 'win', delta: 20, rating: 1020 })
      expect((await authority.read(`/players/${first}/history?limit=11`)).status).toBe(400)
      expect((await authority.read(`/players/${first}/history?queue=offline`)).status).toBe(400)
    } finally { authority.close!() }
  })

  it('rejects malformed new fields and private identities in public responses', () => {
    const original = { ...submission('strict-history-record', 1000), queue: 'ranked' as const }
    for (const match of [
      { ...original.match, abandoned: 'true' },
      { ...original.match, combatPairs: [{ players: [0, 0], ticks: 20 }] },
      { ...original.match, combatPairs: [{ players: [0, 1], ticks: 121 }] },
      { ...original.match, seats: original.match.seats.map((s) => ({ ...s, combatTicks: 121 })) },
      { ...original.match, seats: original.match.seats.map((s) => ({ ...s, build: { slots: [], levels: [], masteries: {} } })) },
      { ...original.match, seats: original.match.seats.map((s) => ({ ...s, forfeited: true })) },
    ]) expect(validRatingSubmission({ ...original, match })).toBe(false)
    const entry = { id: crypto.randomUUID(), queue: 'casual', at: 1000, region: 'eu', ticks: 120, rounds: 1,
      teamMode: 'ffa', gameMode: 'rounds', self: 0, outcome: 'loss', delta: null, rating: null,
      players: [{ player: 0, name: 'Ash', kills: 0, deaths: 1, won: false }] }
    expect(validMatchHistory([entry])).toBe(true)
    expect(validMatchHistory([{ ...entry, players: [{ ...entry.players[0], device: first }] }])).toBe(false)
    expect(validMatchHistory([{ ...entry, outcome: 'win' }])).toBe(false)
    expect(validMatchHistory([entry, entry])).toBe(false)
  })
})
