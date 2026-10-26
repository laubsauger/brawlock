import { afterEach, describe, expect, it } from 'vitest'
import { openLeaderboard } from '../../server/leaderboard-store.mjs'
import { openTestDatabase, removeDir, tempDir } from '../../server/test-dir.mjs'
import type { ResultRow, PlayerRow, StoredMatchHistory } from './leaderboard'

const dirs: string[] = []
const stores: ReturnType<typeof openLeaderboard>[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) removeDir(dir)
})

const board = { period: 'all' as const, region: null, since: 0 }
const device = 'private-account-alpha'
const other = 'private-account-bravo'
function history(queue: 'ranked' | 'casual' | 'custom' = 'casual', at = 1000): StoredMatchHistory {
  return {
    queue, at, region: 'eu', room: 'ABCDE', ticks: 15_000, rounds: 5, teamMode: 'ffa' as const, gameMode: 'rounds' as const,
    players: [
      { player: 0, device, name: 'Ash', color: 0xff0000, kind: 'human' as const, team: 0, score: 2,
        roundsPlayed: 5, roundsWon: 2, kills: 4, deaths: 3, won: false, forfeited: true,
        build: { slots: [null, null, null, null, null, null, 'fireball', null, null, null, null, null], levels: [0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0], masteries: { range: 2, lifesteal: 1, duration: 0 } } },
      { player: 1, device: other, name: 'Thorn', color: 0x00ff00, kind: 'human' as const, team: 1,
        kills: 3, deaths: 2, won: true },
      { player: 2, name: 'Ember', color: 0x0000ff, kind: 'bot' as const, team: 2, kills: 1, deaths: 5, won: false },
    ],
  }
}
/** an Elo change the server computed: the store keeps and returns it as given (the math: leaderboard.test.ts) */
const LOSS = { delta: -20, rating: 980 }
function open(file = ':memory:') {
  const store = openLeaderboard(file)
  stores.push(store)
  return store
}
function rankedRows() {
  const result: ResultRow = { device, name: 'Ash', at: 1000, region: 'eu', won: false, roundsPlayed: 5, roundsWon: 2,
    kills: 4, deaths: 3, ...LOSS, forfeited: true }
  const player: PlayerRow = { device, name: 'Ash', tag: 'abcde', rating: LOSS.rating, matches: 1, wins: 0,
    roundsPlayed: 5, roundsWon: 2, kills: 4, deaths: 3, firstAt: 1000, lastAt: 1000 }
  return [{ at: 1000, region: 'eu', room: 'ABCDE', ticks: 15_000, rounds: 5, humans: 2, bots: 1 }, [result], [player]] as const
}

describe('authoritative match history storage', () => {
  it('lists only explicitly public games across regions, newest first, bounded and queue filtered', () => {
    const store = open()
    const write = (key: string, input: StoredMatchHistory) => store.applyReceipt(key, key, () => ({ rating: { status: 'unrated' }, history: input }))
    write('legacy-unknown', history('casual', 5000))
    write('private-game', { ...history('custom', 6000), public: false })
    write('public-eu', { ...history('casual', 1000), public: true })
    write('public-us', { ...history('ranked', 2000), region: 'us', public: true })
    write('public-custom', { ...history('custom', 3000), public: true })
    const recent = store.recentMatches({ limit: 10 })
    expect(recent.map(m => [m.region, m.queue, m.at])).toEqual([['eu', 'custom', 3000], ['us', 'ranked', 2000], ['eu', 'casual', 1000]])
    expect(store.recentMatches({ limit: 1 })).toEqual(recent.slice(0, 1))
    expect(store.recentMatches({ queue: 'casual', limit: 10 })).toEqual([recent[2]])
    expect(store.history(device, { limit: 10 })).toHaveLength(5)
    expect(JSON.stringify(recent)).not.toMatch(/private-|ABCDE|device|receipt|fingerprint|"self"|"outcome"/)
    expect(() => store.recentMatches({ limit: 11 })).toThrow()
    // Replaying a receipt must not duplicate a public feed entry.
    write('public-eu', { ...history('casual', 1000), public: true })
    expect(store.recentMatches({ limit: 10 })).toEqual(recent)
  })

  it('keeps casual-only players and their builds without creating ranked totals or exposing private identities', () => {
    const store = open()
    const input = history()
    expect(store.applyReceipt('private-internal-receipt', 'fingerprint', () => ({ rating: { status: 'unrated' }, history: input }))).toEqual({ status: 'unrated' })
    expect(store.top(board, 100)).toEqual([])
    expect(store.players([device, other]).size).toBe(0)
    expect(store.recent(device, 10)).toEqual([])
    const rows = store.history(device, { limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ at: 1000, region: 'eu', queue: 'casual', ticks: 15_000, rounds: 5,
      self: 0, outcome: 'forfeit', delta: null, rating: null, players: [{ build: input.players[0].build }, {}, {}] })
    expect(rows[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(JSON.stringify(rows)).not.toMatch(/private-|ABCDE|device|receipt|fingerprint/)
    expect(store.history(other, { limit: 10 })[0]).toMatchObject({ id: rows[0].id, self: 1, outcome: 'win' })
  })

  it('filters queues, orders by completion and insertion, deduplicates receipts, and persists through reopen', () => {
    const dir = tempDir('brawlock-match-history-')
    dirs.push(dir)
    const file = `${dir}/board.sqlite`
    let store = open(file)
    for (const [index, queue] of (['ranked', 'casual', 'custom', 'casual'] as const).entries()) {
      const input = history(queue, index < 2 ? 1000 : 2000)
      const deltas = queue === 'ranked' ? { [device]: LOSS } : undefined
      store.applyReceipt(`history-receipt-${index}`, `fingerprint-${index}`, () => ({ rating: { status: 'unrated' }, history: { ...input, deltas } }))
    }
    expect(store.history(device, { limit: 2 }).map((r) => r.queue)).toEqual(['casual', 'custom'])
    expect(store.history(device, { queue: 'casual', limit: 10 }).map((r) => r.at)).toEqual([2000, 1000])
    expect(store.history(device, { queue: 'ranked', limit: 10 })[0]).toMatchObject(LOSS)
    const before = store.history(device, { limit: 10 })
    store.close()
    stores.splice(stores.indexOf(store), 1)
    store = open(file)
    expect(store.history(device, { limit: 10 })).toEqual(before)
    let calculated = false
    expect(store.applyReceipt('history-receipt-0', 'fingerprint-0', () => { calculated = true; throw new Error('must not recalculate') })).toEqual({ status: 'unrated' })
    expect(calculated).toBe(false)
    expect(store.history(device, { limit: 10 })).toEqual(before)
    expect(() => store.applyReceipt('history-receipt-0', 'changed', () => ({ rating: { status: 'unrated' } }))).toThrow(/conflicts/)
  })

  it('commits ranked results, forfeit flags, history and receipt atomically', () => {
    const store = open()
    const [match, results, players] = rankedRows()
    const commit = [match, [...results], [...players]] as Parameters<typeof store.commit>
    const invalid = { ...history('ranked'), queue: 'invalid' as 'ranked' }
    expect(() => store.applyReceipt('atomic-receipt', 'fingerprint', () => ({ rating: { status: 'rated' }, commit, history: invalid }))).toThrow()
    expect(store.receipt('atomic-receipt', 'fingerprint')).toBeNull()
    expect(store.history(device, { limit: 10 })).toEqual([])
    expect(store.recent(device, 10)).toEqual([])
    expect(store.top(board, 100)).toEqual([])
    store.applyReceipt('atomic-receipt', 'fingerprint', () => ({ rating: { status: 'rated' }, commit,
      history: { ...history('ranked'), deltas: { [device]: LOSS } } }))
    expect(store.recent(device, 10)[0]).toMatchObject({ forfeited: true, delta: LOSS.delta })
    expect(store.history(device, { limit: 10 })[0]).toMatchObject({ outcome: 'forfeit', ...LOSS })
    expect(store.players([device]).get(device)).toMatchObject({ matches: 1, rating: LOSS.rating })
  })

  it('rolls back partial history rows if a human association cannot be inserted', () => {
    const store = open()
    const input = history()
    input.players[1].player = undefined as unknown as number
    expect(() => store.applyReceipt('invalid-association', 'fingerprint', () => ({ rating: { status: 'unrated' }, history: input }))).toThrow()
    expect(store.history(device, { limit: 10 })).toEqual([])
    expect(store.receipt('invalid-association', 'fingerprint')).toBeNull()
  })

  it('excludes every ambiguous duplicate-device association while retaining the roster for unique humans', () => {
    const store = open()
    const input = history()
    input.players.push({ ...input.players[1], player: 3, device })
    store.applyReceipt('duplicate-identity', 'fingerprint', () => ({ rating: { status: 'unrated' }, history: input }))
    expect(store.history(device, { limit: 10 })).toEqual([])
    expect(store.history(other, { limit: 10 })[0].players).toHaveLength(4)
    expect(store.history(other, { limit: 10 })[0].self).toBe(1)
  })

  it('leaves legacy table schemas, rows, receipts and old writes unchanged', () => {
    const dir = tempDir('brawlock-history-legacy-')
    dirs.push(dir)
    const file = `${dir}/board.sqlite`
    const original = openTestDatabase(file)
    original.exec(`CREATE TABLE matches (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, region TEXT NOT NULL, room TEXT NOT NULL, ticks INTEGER NOT NULL, rounds INTEGER NOT NULL, humans INTEGER NOT NULL, bots INTEGER NOT NULL);
      CREATE TABLE results (match_id INTEGER NOT NULL REFERENCES matches(id), device TEXT NOT NULL, name TEXT NOT NULL, at INTEGER NOT NULL, region TEXT NOT NULL, won INTEGER NOT NULL, rounds_played INTEGER NOT NULL, rounds_won INTEGER NOT NULL, kills INTEGER NOT NULL, deaths INTEGER NOT NULL, delta REAL NOT NULL, rating REAL NOT NULL, PRIMARY KEY(match_id, device));
      CREATE TABLE players (device TEXT PRIMARY KEY, name TEXT NOT NULL, tag TEXT NOT NULL, rating REAL NOT NULL, matches INTEGER NOT NULL, wins INTEGER NOT NULL, rounds_played INTEGER NOT NULL, rounds_won INTEGER NOT NULL, kills INTEGER NOT NULL, deaths INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL);
      CREATE TABLE rating_receipts (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, verdict TEXT NOT NULL);
      INSERT INTO matches VALUES(1, 1, 'eu', 'ABCDE', 9000, 1, 2, 0);
      INSERT INTO players VALUES('private-account-alpha', 'Ash', 'abcde', 1010, 1, 1, 1, 1, 2, 0, 1, 1);
      INSERT INTO results VALUES(1, 'private-account-alpha', 'Ash', 1, 'eu', 1, 1, 1, 2, 0, 10, 1010);
      INSERT INTO rating_receipts VALUES('legacy-key', 'unchanged', '{"status":"rated"}');`)
    const snapshot = () => ['matches', 'results', 'players', 'rating_receipts'].map((name) => ({ schema: original.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name), rows: original.prepare(`SELECT * FROM ${name}`).all() }))
    const before = snapshot()
    const store = open(file)
    expect(store.recent(device, 10)[0]).not.toHaveProperty('forfeited')
    expect(store.history(device, { limit: 10 })).toEqual([])
    expect(store.receipt('legacy-key', 'unchanged')).toEqual({ status: 'rated' })
    expect(snapshot()).toEqual(before)
    const [match, results, players] = rankedRows()
    store.commit(match, results.map(({ forfeited: _forfeited, ...result }) => result), [...players])
    expect(store.recent(device, 10)).toHaveLength(2)
    expect(store.history(device, { limit: 10 })).toEqual([])
    original.close()
  })

  it('sums each identity\'s games in the period for the operator board, without bots', () => {
    const store = open()
    store.applyReceipt('old', 'f0', () => ({ rating: { status: 'unrated' }, history: history('casual', 100) }))
    store.applyReceipt('a', 'f1', () => ({ rating: { status: 'unrated' }, history: history('casual', 86_400_000 + 1000) }))
    const renamed = history('custom', 86_400_000 + 2000)
    renamed.players[0] = { ...renamed.players[0], name: 'Ashen', won: true, forfeited: false }
    store.applyReceipt('b', 'f2', () => ({ rating: { status: 'unrated' }, history: renamed }))
    expect(store.historySince()).toBe(100)
    const rows = store.playerActivity(86_400_000, 86_400_000 + 5000)
    // the bot seat never becomes a player; the game before the period is left out
    expect(rows.map((r) => r.device).sort()).toEqual([device, other])
    expect(rows.find((r) => r.device === device)).toEqual({ device, name: 'Ashen', matches: 2, wins: 1, forfeits: 1,
      seconds: 500, kills: 8, deaths: 6, queues: { ranked: 0, casual: 1, custom: 1 }, days: 1, firstAt: 86_401_000, lastAt: 86_402_000 })
    expect(store.playerActivity(0, 50)).toEqual([])
  })

  it('stores only whitelisted equipment fields even for internal callers', () => {
    const store = open()
    const input = history()
    const build = input.players[0].build!
    Object.assign(build, { device: 'private-identity' })
    Object.assign(build.masteries, { profileId: 'private-profile' })
    store.applyReceipt('clean-build-receipt', 'fingerprint', () => ({ rating: { status: 'unrated' }, history: input }))
    const record = store.history(device, { limit: 10 })[0]
    expect(record.players[0].build).toMatchObject({ slots: build.slots, levels: build.levels, masteries: { range: 2, duration: 0, lifesteal: 1 } })
    expect(JSON.stringify(record)).not.toMatch(/private-identity|private-profile|profileId|device/)
  })
})
