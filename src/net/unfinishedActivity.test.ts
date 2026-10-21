/**
 * Partial combat from unfinished ranked games (docs/PLAYER-PROFILES.md): what a human
 * actually played in aborted games, unrated games, bot-controlled intervals and departures
 * adds to the profile's combat totals, and nothing else. Wins, Elo, match counts, history
 * and rewards must stay exactly as they were without it; retries never fold it twice.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { openLeaderboard } from '../../server/leaderboard-store.mjs'
import { removeDir, tempDir } from '../../server/test-dir.mjs'
import { createMatch, DEFAULT_SETTINGS } from '../sim'
import type { PlayerId, PlayerSlot, SimEvent } from '../sim/types'
import { mergeRecordedDetail, type RecordedProfileDetail } from '../game/stats'
import { ServerMatchTracker, unfinishedActivity, type FinishedMatch } from './leaderboard'
import { localRatingAuthority, validRatingSubmission, type RatingSubmission } from './ratingAuthority'

const slots: PlayerSlot[] = [
  { id: 0, name: 'Alpha', kind: 'human', team: 0, color: 0xff6600 },
  { id: 1, name: 'Bravo', kind: 'human', team: 1, color: 0x0088ff },
  { id: 2, name: 'Bot', kind: 'bot', team: 2, color: 0x88cc00 },
]
const A = 'dev-aaaaaaaa'
const B = 'dev-bbbbbbbb'

function tracked(devices: Record<PlayerId, string> = { 0: A, 1: B }, opts: { partial?: boolean } = {}) {
  const settings = { ...DEFAULT_SETTINGS }
  const state = createMatch(settings, slots, 42)
  const done: FinishedMatch[] = []
  const aborted: FinishedMatch[] = []
  const tracker = new ServerMatchTracker((m) => { done.push(m) }, undefined, { ...opts, onAbort: async (m) => { aborted.push(m) } })
  tracker.start({ slots, settings, devices })
  const pawn = (owner: PlayerId) => state.pawns.find((p) => p.owner === owner)!.id
  return {
    tracker, done, aborted,
    at(tick: number, events: SimEvent[] = []) {
      state.tick = tick
      state.phase = 'fight'
      tracker.observe(state, events)
    },
    hit: (from: PlayerId, to: PlayerId, amount: number): SimEvent => ({ type: 'damage', target: pawn(to), source: from, amount, x: 0, y: 0, kb: 0, cause: 'fireball' }),
    kill: (victim: PlayerId, killer: PlayerId): SimEvent => ({ type: 'death', pawn: pawn(victim), owner: victim, killer, cause: 'fireball' }),
    win: (players: PlayerId[]): SimEvent => ({ type: 'roundWin', team: players[0], players }),
    finish(winners: PlayerId[]) {
      tracker.finish({ winners, slots, scores: state.scores, rounds: 1, ticks: state.tick })
      return done.at(-1)!
    },
  }
}

/** Alpha plays, a replacement bot holds the seat (and draws first blood), Alpha returns. */
function interruptedMatch(): FinishedMatch {
  const f = tracked()
  f.at(0)
  f.at(60, [f.hit(0, 2, 10)])
  f.tracker.control(0, 'bot')
  f.tracker.control(0, 'bot')
  f.at(120, [f.hit(0, 2, 100), f.kill(2, 0)])
  f.tracker.control(0, 'human')
  f.tracker.control(0, 'human')
  f.at(180, [f.hit(0, 1, 7)])
  f.at(240, [f.kill(1, 0), f.win([0])])
  return f.finish([0])
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) removeDir(dir) })

describe('server tracker: human-controlled pieces only', () => {
  it('counts the intervals a human played and never the replacement bot, across a takeover and return', () => {
    const m = interruptedMatch()
    const alpha = m.seats.find((s) => s.player === 0)!
    // Complete-match detail stays exactly as before: an interrupted seat has none.
    expect(alpha).not.toHaveProperty('stats')
    // 10 + 7 by the human; the bot's 100 damage, kill and first blood are excluded.
    expect(alpha.partialStats).toMatchObject({ damageDealt: 17, killsByCause: { fireball: 1 }, firstBlood: false })
    // Repeated control notices did not open a second piece: 60 + 60 + 60 human ticks.
    expect(alpha.controlTicks).toBe(180)
    const bravo = m.seats.find((s) => s.player === 1)!
    expect(bravo.stats).toMatchObject({ damageTaken: 7 })
    expect(bravo).not.toHaveProperty('partialStats')
  })

  it('credits first blood only when the human, not the bot holding the seat, drew it', () => {
    const f = tracked()
    f.at(0)
    f.tracker.control(0, 'bot')
    f.tracker.control(0, 'human')
    f.at(60, [f.kill(2, 0)])
    expect(f.finish([0]).seats[0].partialStats).toMatchObject({ firstBlood: true, killsByCause: { fireball: 1 } })
  })

  it('hands an aborted match its activity exactly once, with no outcome, then starts the next match clean', async () => {
    const f = tracked()
    f.at(0)
    f.at(600, [f.hit(1, 0, 5)])
    f.tracker.abort()
    f.tracker.abort() // room teardown aborts again
    f.finish([1]) // nothing to finish any more
    await settle()
    expect(f.done).toHaveLength(0)
    expect(f.aborted).toHaveLength(1)
    const m = f.aborted[0]
    expect(m).toMatchObject({ aborted: true, ranked: [], ticks: 600 })
    expect(m.seats.every((s) => s.won === false && !('stats' in s) && s.forfeited === undefined)).toBe(true)
    expect(m.seats.find((s) => s.player === 1)?.partialStats).toMatchObject({ damageDealt: 5 })
    expect(m.seats.find((s) => s.player === 1)?.controlTicks).toBe(600)

    // A new start while a match is still running flushes that match first, once.
    f.tracker.start({ slots, settings: DEFAULT_SETTINGS, devices: { 0: A, 1: B } })
    f.at(0)
    f.at(300, [f.hit(0, 1, 9)])
    f.tracker.start({ slots, settings: DEFAULT_SETTINGS, devices: { 0: A, 1: B } })
    await settle()
    expect(f.aborted).toHaveLength(2)
    f.at(0)
    f.at(300, [f.win([0])])
    const next = f.finish([0])
    // The flushed match's damage does not leak into the next one.
    expect(next.seats[0].stats?.damageDealt).toBe(0)
    f.tracker.abort() // after a finish: no second report
    await settle()
    expect(f.aborted).toHaveLength(2)
  })

  it('skips matches nobody fought in and rooms that do not record partial activity', async () => {
    const empty = tracked()
    empty.tracker.abort()
    const off = tracked(undefined, { partial: false })
    off.at(0)
    off.at(600, [off.hit(0, 1, 5)])
    off.tracker.control(0, 'bot')
    const m = off.finish([1])
    expect(m.seats[0]).not.toHaveProperty('partialStats')
    await settle()
    expect(empty.aborted).toHaveLength(0)
  })
})

describe('authority: activity joins the totals, never the results', () => {
  const submission = (match: FinishedMatch, key: string, queue: RatingSubmission['queue'] = 'ranked', minSeconds = 1): RatingSubmission =>
    ({ key, region: 'eu', room: 'ABCDE', at: 50_000, minSeconds, match, queue })
  const strip = (m: FinishedMatch): FinishedMatch => ({ ...m, seats: m.seats.map(({ partialStats: _p, controlTicks: _c, ...s }) => s) })
  const history = (store: ReturnType<typeof openLeaderboard>, device: string) => store.history(device, { limit: 10 }).map(({ id: _id, ...h }) => h)

  it('keeps wins, Elo, match counts, history and complete detail identical to a match without it', async () => {
    const m = interruptedMatch()
    expect(validRatingSubmission(submission(m, 'with-partial-0001'))).toBe(true)
    const withPartial = openLeaderboard(':memory:')
    const without = openLeaderboard(':memory:')
    expect(await localRatingAuthority(withPartial, { minSeconds: 1 }).record(submission(m, 'with-partial-0001'))).toEqual({ status: 'rated' })
    expect(await localRatingAuthority(without, { minSeconds: 1 }).record(submission(strip(m), 'with-partial-0001'))).toEqual({ status: 'rated' })
    expect(withPartial.players([A, B])).toEqual(without.players([A, B]))
    expect(withPartial.recent(A, 10)).toEqual(without.recent(A, 10))
    expect(history(withPartial, A)).toEqual(history(without, A))
    expect(withPartial.details(B)).toEqual(without.details(B))
    expect(withPartial.details(A)).toBeNull()
    // Only Alpha's human part is new, and only as activity.
    expect(withPartial.activity(A)?.detail).toMatchObject({ matches: 1, seconds: 3, damage: 17, totals: { killsByCause: { fireball: 1 } } })
    expect(withPartial.activity(B)).toBeNull()
    expect(without.activity(A)).toBeNull()

    // A retried delivery (same key and payload) folds nothing again.
    const before = withPartial.activity(A)
    expect(await localRatingAuthority(withPartial, { minSeconds: 1 }).record(submission(m, 'with-partial-0001'))).toEqual({ status: 'rated' })
    expect(withPartial.activity(A)).toEqual(before)
    const profile = (await localRatingAuthority(withPartial, { minSeconds: 1 }).read(`/players/${A}`)).body as { matches: number; wins: number; activity: RecordedProfileDetail; coverage: { detailedMatches: number } }
    expect(profile).toMatchObject({ matches: 1, wins: 1, coverage: { detailedMatches: 0 }, activity: { matches: 1, damage: 17 } })
  })

  it('folds an aborted game once, through reopen, with no player row, loss, history or Elo', async () => {
    const f = tracked()
    f.at(0)
    f.at(3600, [f.hit(1, 0, 5), f.hit(0, 1, 4)])
    f.tracker.abort()
    await settle()
    const request = submission(f.aborted[0], 'aborted-match-0001')
    const file = `${(() => { const d = tempDir('brawlock-activity-'); dirs.push(d); return d })()}/leaderboard.sqlite`
    let store = openLeaderboard(file)
    let authority = localRatingAuthority(store, { minSeconds: 1 })
    expect(await authority.record(request)).toEqual({ status: 'unrated', reason: 'The match ended without a result.' })
    expect(store.players([A, B]).size).toBe(0)
    expect(store.history(A, { limit: 10 })).toEqual([])
    expect(store.activity(A)?.detail).toMatchObject({ matches: 1, seconds: 60, damage: 4 })
    expect(store.activity(B)?.detail).toMatchObject({ matches: 1, seconds: 60, damage: 5 })
    authority.close!()
    store = openLeaderboard(file)
    authority = localRatingAuthority(store, { minSeconds: 1 })
    const kept = store.activity(A)
    expect(await authority.record(structuredClone(request))).toEqual({ status: 'unrated', reason: 'The match ended without a result.' })
    expect(store.activity(A)).toEqual(kept)
    const changed = structuredClone(request)
    changed.match.seats[0].partialStats!.damageDealt++
    await expect(authority.record(changed)).rejects.toThrow('idempotency key conflicts')
    expect(store.activity(A)).toEqual(kept)
    authority.close!()
  })

  it('counts unrated complete ranked seats, but never casual games or a device in two seats', async () => {
    const m = interruptedMatch()
    const store = openLeaderboard(':memory:')
    const authority = localRatingAuthority(store, { minSeconds: 1 })
    // Too short for a ranked result: no Elo, but both humans' played combat still counts.
    expect((await authority.record(submission(m, 'unrated-ranked-0001', 'ranked', 3600))).status).toBe('unrated')
    expect(store.players([A, B]).size).toBe(0)
    expect(store.activity(A)?.detail).toMatchObject({ matches: 1, damage: 17, seconds: 3 })
    expect(store.activity(B)?.detail).toMatchObject({ matches: 1, seconds: 4 })
    expect((await authority.record(submission(m, 'casual-match-00001', 'casual'))).status).toBe('unrated')
    expect(store.activity(A)?.detail.matches).toBe(1)
    const shared = { ...m, seats: m.seats.map((s) => ({ ...s, device: A })), roster: m.roster?.map((p) => (p.device ? { ...p, device: A } : p)) }
    expect(unfinishedActivity(shared, new Set())).toEqual([])
    store.close()
  })

  it('rejects activity that could pose as a result or overlap complete detail', () => {
    const m = interruptedMatch()
    const seat0 = m.seats.find((s) => s.player === 0)!
    const aborted: FinishedMatch = { ...m, aborted: true, ranked: [], roster: undefined, combatPairs: undefined, seats: m.seats.map((s) => ({ ...s, won: false })) }
    delete aborted.roster
    delete aborted.combatPairs
    expect(validRatingSubmission(submission(aborted, 'aborted-valid-0001'))).toBe(true)
    expect(validRatingSubmission(submission(aborted, 'aborted-casual-001', 'casual'))).toBe(false)
    expect(validRatingSubmission(submission({ ...aborted, seats: aborted.seats.map((s, i) => (i === 0 ? { ...s, won: true } : s)) }, 'aborted-winner-001'))).toBe(false)
    expect(validRatingSubmission(submission({ ...aborted, ranked: m.ranked }, 'aborted-ranked-001'))).toBe(false)
    const seats = (patch: Partial<typeof seat0>) => ({ ...m, seats: m.seats.map((s) => (s.player === 0 ? { ...s, ...patch } : s)) })
    expect(validRatingSubmission(submission(seats({ stats: seat0.partialStats }), 'overlap-detail-001'))).toBe(false)
    expect(validRatingSubmission(submission(seats({ controlTicks: m.ticks + 1 }), 'control-ticks-0001'))).toBe(false)
    expect(validRatingSubmission(submission(seats({ partialStats: undefined }), 'orphan-ticks-00001'))).toBe(false)
  })
})

describe('profile display: one set of totals', () => {
  it('adds activity counters and keeps the better personal bests without inventing coverage', () => {
    const detail: RecordedProfileDetail = { matches: 2, seconds: 600, damage: 100, totals: { ...emptyTotalsFor(), casts: 10, hits: 5, killsByCause: { fireball: 2 } },
      spells: { fireball: [10, 5] }, hallOfFame: { mostKills: { value: 2, date: 1, matchId: '1' } } }
    const activity: RecordedProfileDetail = { matches: 1, seconds: 60, damage: 30, totals: { ...emptyTotalsFor(), casts: 4, hits: 3, killsByCause: { fireball: 3, lava: 1 } },
      spells: { fireball: [4, 3] }, hallOfFame: { mostKills: { value: 4, date: 2, matchId: 'partial-1' } } }
    const merged = mergeRecordedDetail(detail, activity)!
    expect(merged).toMatchObject({ matches: 3, seconds: 660, damage: 130, spells: { fireball: [14, 8] },
      totals: { casts: 14, hits: 8, killsByCause: { fireball: 5, lava: 1 } }, hallOfFame: { mostKills: { value: 4, matchId: 'partial-1' } } })
    expect(detail.matches).toBe(2) // inputs untouched
    expect(mergeRecordedDetail(null, activity)).toEqual(activity)
    expect(mergeRecordedDetail(null, null)).toBeNull()
  })
})

function emptyTotalsFor(): RecordedProfileDetail['totals'] {
  return { walked: 0, pushed: 0, teleported: 0, damageTaken: 0, knockbacksDealt: 0, knockbacksTaken: 0, selfKills: 0, lastHitKills: 0,
    firstBloods: 0, casts: 0, hits: 0, scourgeHits: 0, teleportSaves: 0, shieldReflects: 0, pillarsDestroyed: 0, aliveSec: 0,
    lavaSec: 0, lavaDamage: 0, roundsSurvived: 0, goldEarned: 0, goldSpent: 0, killsByCause: {}, deathsByCause: {} }
}
