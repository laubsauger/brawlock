import { describe, expect, it } from 'vitest'
import type { MatchSettings, PlayerSlot, PlayerScore, SimEvent, SimState } from '../sim/types'
import { ticks } from '../sim/config'
import { _resetProfileCache, getProfile, setPreferredColor, type KV } from './profile'
import {
  ELO_START,
  MatchTracker,
  eloUpdate,
  getCareer,
  getEncounters,
  getLocalLeaderboard,
  getMatchHistory,
  pairOutcome,
  profileIdOf,
  recordMatch,
  updateProfileNames,
  emptyTotals,
  addRecordedMatch,
  recordedProfileStats,
  recordUnfinishedMatch,
} from './stats'

function memKV(init: Record<string, string> = {}): KV & { data: Record<string, string> } {
  const data = { ...init }
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v
    },
  }
}

const settings: MatchSettings = {
  teamMode: 'ffa',
  gameMode: 'rounds',
  winScore: 3,
  startGold: 30,
  roundGold: 10,
  killGold: 0,
  winGold: 0,
  lavaDps: 100,
  kbMultiplier: 1,
  dmgMultiplier: 1,
  friction: 0.96,
  shopSeconds: 30,
  botsReplaceLeavers: true,
  spectatorBets: true,
  bounties: true,
}

const ME = 'me-0000000001'
const ALICE = 'alice-00000001'
const BOB = 'bob-0000000001'

function slot(id: number, name: string, profileId: string): PlayerSlot {
  return { id, name, color: 0x100000 * (id + 1), team: id, kind: 'human', profileId }
}

function score(id: number, s: number, kills: number, deaths: number): PlayerScore {
  return {
    id,
    gold: 0,
    score: s,
    kills,
    deaths,
    damageThisRound: 0,
    spent: 0,
    masteries: { duration: 0, range: 0, lifesteal: 0 },
    connected: true,
  }
}

/** a state with one pawn per player; pawn entity id = 100 + player */
function state(tick: number, players: number[]): SimState {
  return {
    tick,
    pawns: players.map((p) => ({ id: 100 + p, owner: p })),
  } as unknown as SimState
}

/**
 * One match as the local player (id 0) saw it: `kills` are [killer, victim] deaths,
 * `hits` are [from, to, amount] damage events, all fed through the tracker.
 */
function playMatch(
  slots: PlayerSlot[],
  winners: number[],
  scores: PlayerScore[],
  kills: [number, number][],
  hits: [number, number, number][],
  date: number,
) {
  const ids = slots.map((s) => s.id)
  const t = new MatchTracker({ localPlayer: 0, slots, settings })
  t.observe(state(1, ids), [])
  let tick = 2
  for (const [from, to, amount] of hits) {
    const ev: SimEvent[] = [{ type: 'damage', target: 100 + to, amount, source: from, x: 0, y: 0, kb: 0 }]
    t.observe(state(tick++, ids), ev)
  }
  for (const [killer, victim] of kills) {
    t.observe(state(tick++, ids), [{ type: 'death', pawn: 100 + victim, owner: victim, killer }])
  }
  // lava death and self damage must not count against anyone
  t.observe(state(tick++, ids), [
    { type: 'death', pawn: 100, owner: 0, killer: null },
    { type: 'damage', target: 100, amount: 100, source: 0, x: 0, y: 0, kb: 0 },
  ])
  return t.finish({ winners, slots, scores, rounds: 3, ticks: ticks(90) }, date)
}

describe('retained rival details', () => {
  const record = (date: number, player = 1, name = 'Alice') => playMatch(
    [slot(0, 'You', ME), slot(player, name, ALICE)], [player],
    [score(0, 0, 0, 1), score(player, 3, 1, 0)], [[player, 0]], [[player, 0, date === 2000 ? 70 : 80]], date,
  )

  it('uses stable identity across names/seats and keeps missing detailed coverage separate', () => {
    const first = record(2000)
    Object.assign(first.participants[1].stats!, { goldEarned: 9, goldSpent: 4, walked: 192, spells: { fireball: [5, 2], teleport: [3, 0] } })
    const second = record(3000, 2, 'Renamed Alice')
    Object.assign(second.participants[1].stats!, { goldEarned: 11, goldSpent: 7, walked: 384, spells: { fireball: [4, 1], teleport: [7, 0] } })
    const legacy = record(1000)
    delete legacy.participants[1].stats
    const other = record(4000)
    other.participants[1].profileId = BOB // The same name must not merge identities.
    const records = [other, second, legacy, first]
    const before = JSON.stringify(records)
    const result = recordedProfileStats(records, ALICE)
    expect(result.coverage).toEqual({ detailedMatches: 2, totalMatches: 3, firstDetailedAt: 2000, lastDetailedAt: 3000 })
    expect(result.detail).toMatchObject({ matches: 2, seconds: 180, damage: 150, totals: { goldEarned: 20, goldSpent: 11, walked: 576, casts: 9, hits: 3 }, spells: { fireball: [9, 3], teleport: [10, 0] } })
    expect(result.detail!.hallOfFame.mostDamage).toEqual({ value: 80, date: 3000, matchId: second.id })
    expect(JSON.stringify(records)).toBe(before)
  })

  it('does not fabricate zero-valued detail for a legacy-only or unknown rival', () => {
    const legacy = record(1000)
    delete legacy.participants[1].stats
    expect(recordedProfileStats([legacy], ALICE)).toEqual({ coverage: { detailedMatches: 0, totalMatches: 1, firstDetailedAt: null, lastDetailedAt: null }, detail: null })
    expect(recordedProfileStats([legacy], '')).toEqual({ coverage: { detailedMatches: 0, totalMatches: 0, firstDetailedAt: null, lastDetailedAt: null }, detail: null })
  })

  it('refuses ambiguous duplicated participant identity and gives each accumulator fresh maps', () => {
    const ambiguous = record(1000)
    ambiguous.participants[0].profileId = ALICE
    expect(recordedProfileStats([ambiguous], ALICE).detail).toBeNull()
    const a = emptyTotals(), b = emptyTotals()
    a.killsByCause.lava = 2
    expect(b.killsByCause).toEqual({})
    expect(b.goldSpent).toBe(0)
  })

  it('keeps the earlier personal best when equally strong matches arrive out of order', () => {
    const newer = record(4000), earlier = record(3000)
    const detail = recordedProfileStats([newer], ALICE).detail!
    addRecordedMatch(detail, earlier.participants[1].stats!, earlier.durationSec, earlier.date, earlier.id)
    expect(detail.matches).toBe(2)
    expect(detail.damage).toBe(160)
    expect(detail.hallOfFame.mostDamage).toEqual({ value: 80, date: 3000, matchId: earlier.id })
  })

  it('omits ambiguous difficulty-grouped bots instead of attributing one bot’s stats to the group', () => {
    const grouped = record(1000)
    for (const participant of grouped.participants) Object.assign(participant, { kind: 'bot', profileId: 'bot:brutal' })
    expect(recordedProfileStats([grouped], 'bot:brutal')).toEqual({ coverage: { detailedMatches: 0, totalMatches: 0, firstDetailedAt: null, lastDetailedAt: null }, detail: null })
  })
})

describe('elo', () => {
  it('is the classic zero-sum update in a 1v1', () => {
    const [a, b] = eloUpdate([1500, 1500], () => 1)
    expect(a).toBeCloseTo(1516)
    expect(b).toBeCloseTo(1484)
  })

  /** Why: beating a stronger player must be worth more than beating a weaker one. */
  it('rewards upsets more than expected wins', () => {
    const [underdog] = eloUpdate([1400, 1600], () => 1)
    const [favorite] = eloUpdate([1600, 1400], () => 1)
    expect(underdog - 1400).toBeGreaterThan(favorite - 1600)
  })

  it('skips teammate pairs', () => {
    expect(eloUpdate([1500, 1500], () => null)).toEqual([1500, 1500])
  })
})

describe('local stats', () => {
  it('records the final winner over a tied scoring-round opponent without adding a score point', () => {
    const kv = memKV()
    const slots = [slot(0, 'Me', ME), slot(1, 'Alice', ALICE), slot(2, 'Bob', BOB)]
    const tracker = new MatchTracker({ localPlayer: 0, slots, settings })
    const record = tracker.finish({
      winners: [1], slots,
      scores: [score(0, 2, 8, 3), score(1, 2, 2, 4), score(2, 1, 9, 4)],
      rounds: 6, ticks: ticks(240),
    }, 1000)
    expect(record.outcome).toBe('loss')
    expect(record.winners).toEqual([1])
    expect(record.participants.map((p) => [p.player, p.score, p.won])).toEqual([[0, 2, false], [1, 2, true], [2, 1, false]])
    const [me, alice, bob] = record.participants
    expect(pairOutcome(record, alice, me)).toBe(1)
    expect(pairOutcome(record, me, bob)).toBe(1)
    recordMatch(record, ME, kv)
    const loaded = getMatchHistory(10, kv)[0]
    expect(loaded.outcome).toBe('loss')
    expect(loaded.participants.map((p) => p.score)).toEqual([2, 2, 1])
    expect(getEncounters(kv).find((p) => p.profileId === ALICE)).toMatchObject({ losses: 1, wins: 0 })
  })

  it.each([
    { status: 'rated' },
    { status: 'unrated', reason: 'Not enough human players' },
    { status: 'unavailable', reason: 'Rating service unavailable' },
  ] as const)('round-trips the confirmed $status outcome from result through tracker and storage', (rating) => {
    const kv = memKV()
    const slots = [slot(0, 'Me', ME), slot(1, 'Alice', ALICE)]
    const tracker = new MatchTracker({ localPlayer: 0, slots, settings })
    const result = { winners: [0], slots, scores: [score(0, 3, 1, 0), score(1, 0, 0, 1)], rounds: 3, rating: { ...rating } }
    const record = tracker.finish(result, 1000)
    expect(record.rating).toEqual(rating)
    expect(record.rating).not.toBe(result.rating)
    recordMatch(record, ME, kv)
    const loaded = getMatchHistory(10, kv)[0]
    expect(loaded.rating).toEqual(rating)
    expect(loaded.outcome).toBe('win')
    expect(loaded.participants.map((p) => p.profileId)).toEqual([ME, ALICE])
  })

  it('preserves legacy records without inventing a rating outcome during load or subsequent saves', () => {
    const kv = memKV()
    const slots = [slot(0, 'Me', ME), slot(1, 'Alice', ALICE)]
    const legacy = playMatch(slots, [0], [score(0, 3, 1, 0), score(1, 0, 0, 1)], [[0, 1]], [], 1000)
    expect(Object.hasOwn(legacy, 'rating')).toBe(false)
    recordMatch(legacy, ME, kv)
    expect(Object.hasOwn(getMatchHistory(10, kv)[0], 'rating')).toBe(false)
    const next = playMatch(slots, [1], [score(0, 0, 0, 1), score(1, 3, 1, 0)], [[1, 0]], [], 2000)
    next.rating = { status: 'rated' }
    recordMatch(next, ME, kv)
    const records = getMatchHistory(10, kv)
    expect(records[0].rating).toEqual({ status: 'rated' })
    expect(Object.hasOwn(records[1], 'rating')).toBe(false)
    const saved = JSON.parse(kv.data['brawlock.stats.v1'])
    expect(Object.hasOwn(saved.history[1], 'rating')).toBe(false)
  })

  it('loads only valid rating statuses and string reasons without altering the rest of history', () => {
    const slots = [slot(0, 'Me', ME), slot(1, 'Alice', ALICE)]
    const record = playMatch(slots, [0], [score(0, 3, 1, 0), score(1, 0, 0, 1)], [[0, 1]], [], 1000)
    const ratings = [
      { status: 'rated', reason: 'Confirmed', privatePayload: 7 },
      { status: 'unrated', reason: 15 },
      { status: 'unavailable', reason: '' },
      { status: 'pending', reason: 'Unknown status' },
      { reason: 'No status' },
      'rated',
      null,
    ]
    const kv = memKV({ 'brawlock.stats.v1': JSON.stringify({ v: 2, history: ratings.map((rating) => ({ ...record, rating })) }) })
    const loaded = getMatchHistory(10, kv)
    expect(loaded).toHaveLength(ratings.length)
    expect(loaded.slice(0, 3).map((r) => r.rating)).toEqual([
      { status: 'rated', reason: 'Confirmed' }, { status: 'unrated' }, { status: 'unavailable', reason: '' },
    ])
    expect(loaded.slice(3).every((r) => !Object.hasOwn(r, 'rating'))).toBe(true)
    expect(loaded.every((r) => r.id === record.id && r.outcome === 'win')).toBe(true)
  })

  it('the device leaderboard lists people only: bots of a difficulty share one identity', () => {
    const kv = memKV()
    const me = slot(0, 'Me', ME)
    const bot = (id: number): PlayerSlot => ({ id, name: `Bot ${id}`, color: 0x00ff00, team: id, kind: 'bot', difficulty: 'brutal' })
    recordMatch(playMatch([me, bot(1), bot(2)], [0], [score(0, 3, 2, 0), score(1, 0, 0, 1), score(2, 0, 0, 1)], [[0, 1], [0, 2]], [], 1000), ME, kv)
    expect(getLocalLeaderboard(ME, kv).map((r) => r.kind)).toEqual(['human'])
  })

  it('keeps names as labels: renames preserve totals, equal names remain distinct, and history stays historical', () => {
    const kv = memKV()
    const me = slot(0, 'Same name', ME)
    const a = slot(1, 'Same name', ALICE)
    recordMatch(playMatch([me, a], [0], [score(0, 3, 1, 0), score(1, 0, 0, 1)], [[0, 1]], [], 1000), ME, kv)
    const before = getLocalLeaderboard(ME, kv)
    expect(before).toHaveLength(2)
    updateProfileNames([{ profileId: ME, name: 'New self' }, { profileId: ALICE, name: 'New opponent' }], kv)
    const renamed = getLocalLeaderboard(ME, kv)
    for (const row of renamed) {
      const old = before.find((r) => r.profileId === row.profileId)!
      expect({ ...row, name: old.name }).toEqual(old)
    }
    expect(renamed.find((r) => r.self)?.name).toBe('New self')
    expect(getEncounters(kv)).toMatchObject([{ profileId: ALICE, lastName: 'New opponent', games: 1 }])
    expect(getMatchHistory(10, kv)[0].participants.map((p) => p.name)).toEqual(['Same name', 'Same name'])
    recordMatch(playMatch([{ ...me, name: 'New self' }, { ...a, name: 'New opponent' }], [1], [score(0, 0, 0, 1), score(1, 3, 1, 0)], [[1, 0]], [], 2000), ME, kv)
    expect(getCareer(kv)).toMatchObject({ profileId: ME, games: 2, wins: 1, losses: 1 })
    expect(getLocalLeaderboard(ME, kv)).toHaveLength(2)
    expect(getEncounters(kv)).toMatchObject([{ profileId: ALICE, games: 2, lastName: 'New opponent' }])
  })

  it('does not invent persistent human identities from missing IDs or legacy anonymous names', () => {
    const kv = memKV()
    const me = slot(0, 'Me', ME)
    const unknown = { ...slot(1, 'Someone', ALICE), profileId: undefined }
    expect(profileIdOf(unknown)).toBe('')
    const first = playMatch([me, unknown], [0], [score(0, 3, 1, 0), score(1, 0, 0, 1)], [[0, 1]], [], 1000)
    recordMatch(first, ME, kv)
    const legacy = playMatch([me, slot(1, 'Someone', 'anon:Someone')], [1], [score(0, 0, 0, 1), score(1, 3, 1, 0)], [[1, 0]], [], 2000)
    recordMatch(legacy, ME, kv)
    expect(getMatchHistory(10, kv)).toHaveLength(2)
    expect(getMatchHistory(10, kv)[0].participants[1].name).toBe('Someone')
    expect(getEncounters(kv)).toEqual([])
    expect(getLocalLeaderboard(ME, kv).map((r) => r.profileId)).toEqual([ME])
    expect(getLocalLeaderboard(ME, kv)[0].rating).toBe(ELO_START)
  })

  /**
   * Why: the head-to-head record is the feature. Three matches against Alice
   * (2 won, 1 lost, one of them an FFA with Bob) must add up exactly, including
   * kills on / deaths to each opponent taken from the event stream.
   */
  it('aggregates three matches into correct career, encounters and ratings', () => {
    const kv = memKV()
    const me = slot(0, 'Me', ME)
    const alice = slot(1, 'Alice', ALICE)
    const bob = slot(2, 'Bob', BOB)

    // 1: 1v1, I win 3-1, I killed Alice 3 times, she killed me once
    recordMatch(
      playMatch([me, alice], [0], [score(0, 3, 3, 1), score(1, 1, 1, 3)], [[0, 1], [0, 1], [0, 1], [1, 0]], [[0, 1, 200], [1, 0, 50]], 1000),
      ME,
      kv,
    )
    // 2: 1v1, Alice wins 3-2 (renamed herself)
    const alice2 = { ...alice, name: 'Alice2' }
    recordMatch(
      playMatch([me, alice2], [1], [score(0, 2, 2, 3), score(1, 3, 3, 2)], [[1, 0], [1, 0], [0, 1]], [[1, 0, 300]], 2000),
      ME,
      kv,
    )
    // 3: FFA with Bob, I win; Bob killed Alice
    recordMatch(
      playMatch([me, alice2, bob], [0], [score(0, 3, 1, 0), score(1, 1, 0, 2), score(2, 0, 1, 1)], [[0, 2], [2, 1]], [[0, 2, 70]], 3000),
      ME,
      kv,
    )

    const enc = Object.fromEntries(getEncounters(kv).map((e) => [e.profileId, e]))
    expect(enc[ALICE]).toMatchObject({ games: 3, wins: 2, losses: 1, draws: 0, killsOn: 4, deathsTo: 3, lastName: 'Alice2' })
    expect(enc[ALICE].damageDealt).toBe(200)
    expect(enc[ALICE].damageTaken).toBe(350)
    expect(enc[BOB]).toMatchObject({ games: 1, wins: 1, losses: 0, killsOn: 1, deathsTo: 0, damageDealt: 70 })
    expect(getEncounters(kv)[0].lastSeen).toBe(3000) // most recent first
    expect(enc[ME]).toBeUndefined() // never an encounter with yourself

    const career = getCareer(kv)!
    expect(career).toMatchObject({ profileId: ME, games: 3, wins: 2, losses: 1, kills: 6, deaths: 4, rounds: 9 })
    expect(career.seconds).toBe(270)
    expect(career.bestWinStreak).toBe(1)
    expect(career.winStreak).toBe(1)
    expect(career.vsHumans).toEqual({ games: 3, wins: 2 })

    const hist = getMatchHistory(10, kv)
    expect(hist.map((h) => h.date)).toEqual([3000, 2000, 1000])
    expect(hist[1].outcome).toBe('loss')
    expect(getMatchHistory(1, kv)).toHaveLength(1)

    const board = getLocalLeaderboard(ME, kv)
    expect(board.map((r) => r.profileId)).toContain(BOB)
    for (let i = 1; i < board.length; i++) expect(board[i - 1].rating).toBeGreaterThanOrEqual(board[i].rating)
    const mine = board.find((r) => r.self)!
    expect(mine.profileId).toBe(ME)
    expect(mine.rating).toBeGreaterThan(ELO_START)
    expect(board.find((r) => r.profileId === ALICE)).toMatchObject({ games: 3, wins: 1, losses: 2 })
  })

  it('records a spectated match in history without touching career or encounters', () => {
    const kv = memKV()
    const a = slot(1, 'A', ALICE)
    const b = slot(2, 'B', BOB)
    const t = new MatchTracker({ localPlayer: -1, slots: [a, b], settings })
    recordMatch(t.finish({ winners: [1], slots: [a, b], scores: [score(1, 3, 0, 0), score(2, 0, 0, 0)], rounds: 3 }), ME, kv)
    expect(getMatchHistory(5, kv)[0].outcome).toBe('spectator')
    expect(getCareer(kv)).toBeNull()
    expect(getEncounters(kv)).toEqual([])
    expect(getLocalLeaderboard(ME, kv)).toHaveLength(2)
  })

  /** Why: leaving or losing a match mid-way must not erase the fighting done, nor count as a game and lower the win rate. */
  it('adds an unfinished match’s combat to career totals without a game, win, loss, rating, encounter or history', () => {
    const kv = memKV()
    const me = slot(0, 'Me', ME)
    const alice = slot(1, 'Alice', ALICE)
    recordMatch(playMatch([me, alice], [0], [score(0, 3, 1, 0), score(1, 0, 0, 1)], [[0, 1]], [[0, 1, 40]], 1000), ME, kv)
    const before = getCareer(kv)!
    const board = getLocalLeaderboard(ME, kv)
    const encounters = getEncounters(kv)
    const t = new MatchTracker({ localPlayer: 0, slots: [me, alice], settings })
    expect(t.unfinishedPart()).toBeNull() // nothing observed yet
    t.observe(state(1, [0, 1]), [])
    t.observe(state(2, [0, 1]), [{ type: 'damage', target: 101, amount: 25, source: 0, x: 0, y: 0, kb: 0 }])
    t.observe(state(3, [0, 1]), [{ type: 'death', pawn: 101, owner: 1, killer: 0, cause: 'fireball' }])
    t.observe(state(4, [0, 1]), [{ type: 'death', pawn: 100, owner: 0, killer: 1, cause: 'lava' }])
    const part = t.unfinishedPart()!
    recordUnfinishedMatch({ ...part, date: 2000 }, ME, kv)
    const after = getCareer(kv)!
    expect(after).toMatchObject({ games: before.games, wins: before.wins, losses: before.losses, rounds: before.rounds,
      winStreak: before.winStreak, vsHumans: before.vsHumans, vsBots: before.vsBots,
      kills: before.kills + 1, deaths: before.deaths + 1, damage: before.damage + 25, lastPlayed: 2000 })
    expect(after.totals.killsByCause.fireball).toBe((before.totals.killsByCause.fireball ?? 0) + 1)
    expect(after.totals.deathsByCause.lava).toBe((before.totals.deathsByCause.lava ?? 0) + 1)
    expect(getMatchHistory(5, kv)).toHaveLength(1)
    expect(getLocalLeaderboard(ME, kv)).toEqual(board)
    expect(getEncounters(kv)).toEqual(encounters)
    const spectator = new MatchTracker({ localPlayer: -1, slots: [me, alice], settings })
    spectator.observe(state(1, [0, 1]), [{ type: 'death', pawn: 101, owner: 1, killer: 0 }])
    expect(spectator.unfinishedPart()).toBeNull()
  })

  /** Why: a broken localStorage (manual edits, old versions, quota, private mode) must never crash the game. */
  it('survives corrupted or unavailable storage', () => {
    const me = slot(0, 'Me', ME)
    const alice = slot(1, 'Alice', ALICE)
    const rec = () =>
      playMatch([me, alice], [0], [score(0, 3, 1, 0), score(1, 0, 0, 1)], [[0, 1]], [], 5000)

    for (const raw of ['{not json', 'null', '[]', '{"v":99}', '{"v":1,"history":"x","career":7,"encounters":[1],"ratings":null}']) {
      const kv = memKV({ 'brawlock.stats.v1': raw })
      expect(getCareer(kv)).toBeNull()
      expect(getEncounters(kv)).toEqual([])
      expect(getMatchHistory(5, kv)).toEqual([])
      recordMatch(rec(), ME, kv)
      expect(getCareer(kv)?.games).toBe(1)
    }

    // field-level garbage is coerced, not propagated as NaN
    const kv = memKV({
      'brawlock.stats.v1': JSON.stringify({
        v: 1,
        history: [{ nope: true }],
        career: { games: 'many', wins: null },
        encounters: { [ALICE]: { games: 'x', wins: 2 } },
        ratings: { [ALICE]: { rating: 'high' } },
      }),
    })
    recordMatch(rec(), ME, kv)
    expect(getCareer(kv)).toMatchObject({ games: 1, wins: 1 })
    expect(getEncounters(kv)[0]).toMatchObject({ games: 1, wins: 3 })
    expect(Number.isFinite(getLocalLeaderboard(ME, kv)[0].rating)).toBe(true)
    expect(getMatchHistory(5, kv)).toHaveLength(1)

    // storage that throws on every call
    const broken: KV = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(() => recordMatch(rec(), ME, broken)).not.toThrow()
    expect(getCareer(broken)).toBeNull()
    expect(getCareer(null)).toBeNull()
  })
})

describe('profile', () => {
  it('keeps one id per browser and replaces a corrupt one', () => {
    _resetProfileCache()
    const kv = memKV({ 'brawlock.profile.v1': '{garbage' })
    const a = getProfile(kv)
    expect(a.id.length).toBeGreaterThanOrEqual(8)
    _resetProfileCache()
    expect(getProfile(kv).id).toBe(a.id) // persisted, not regenerated
    setPreferredColor(0x123456, kv)
    _resetProfileCache()
    expect(getProfile(kv).color).toBe(0x123456)
    _resetProfileCache()
    expect(getProfile(null).id).toBeTruthy() // no storage at all still works
    _resetProfileCache()
  })
})
