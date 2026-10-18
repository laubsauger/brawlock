import { describe, expect, it } from 'vitest'
import type { MatchSettings, PlayerSlot, PlayerScore, SimEvent, SimState } from '../sim/types'
import { _resetProfileCache, getProfile, setPreferredColor, type KV } from './profile'
import {
  ELO_START,
  MatchTracker,
  eloUpdate,
  getCareer,
  getEncounters,
  getLocalLeaderboard,
  getMatchHistory,
  profileIdOf,
  recordMatch,
  updateProfileNames,
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
  return t.finish({ winners, slots, scores, rounds: 3, ticks: 60 * 90 }, date)
}

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
