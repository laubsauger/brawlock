/**
 * Casual leaderboard (M4.3): the server-side tracker, eligibility, per-round Elo, and the
 * SQLite store surviving a restart.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { MatchResult } from '../game/store'
import type { MatchSettings, PlayerId, PlayerSlot, SimEvent, SimState } from '../sim/types'
import { DEFAULT_SETTINGS } from '../sim'
import { openLeaderboard } from '../../server/leaderboard-store.mjs'
import { removeDir, tempDir } from '../../server/test-dir.mjs'
import { LB_K, LB_RATING_START, ServerMatchTracker, deviceTag, ineligible, rateMatch, settleMatch, type FinishedMatch, type PlayerRow } from './leaderboard'

const slot = (id: PlayerId, kind: 'human' | 'bot', team = id): PlayerSlot => ({ id, name: kind === 'bot' ? `Bot ${id}` : `P${id}`, color: 0, team, kind })
const death = (owner: PlayerId, killer: PlayerId | null, cause = 'fireball'): SimEvent => ({ type: 'death', pawn: 100 + owner, owner, killer, cause }) as SimEvent
const roundWin = (players: PlayerId[], team = players[0] ?? -1): SimEvent => ({ type: 'roundWin', team, players })

/** Scripted match: per round, the order of deaths (with killers) and the winners. */
function play(slots: PlayerSlot[], devices: Record<PlayerId, string>, rounds: { deaths: [PlayerId, PlayerId | null][]; winners: PlayerId[] }[], opts: { ticks?: number; settings?: Partial<MatchSettings>; takeover?: { player: PlayerId; afterRound: number } } = {}): FinishedMatch {
  let out: FinishedMatch | null = null
  const t = new ServerMatchTracker((m) => (out = m))
  const settings = { ...DEFAULT_SETTINGS, ...opts.settings }
  t.start({ slots, settings, devices })
  if (opts.takeover?.afterRound === -1) t.control(opts.takeover.player, 'bot')
  const state = (alive: Set<PlayerId>) => ({ tick: 0, slots, pawns: slots.map((s) => ({ owner: s.id, alive: alive.has(s.id) })) }) as unknown as SimState
  rounds.forEach((r, i) => {
    const alive = new Set(slots.map((s) => s.id))
    for (const [victim, killer] of r.deaths) {
      alive.delete(victim)
      t.observe(state(alive), [death(victim, killer)])
    }
    t.observe(state(alive), [roundWin(r.winners)])
    if (opts.takeover && opts.takeover.afterRound === i) t.control(opts.takeover.player, 'bot')
  })
  const result: MatchResult = { winners: rounds.at(-1)?.winners ?? [], slots, scores: [], rounds: rounds.length, ticks: opts.ticks ?? 200 * 60 }
  t.finish(result)
  return out!
}

describe('leaderboard: what counts', () => {
  it('a live rename updates the display label without changing the device or resetting counters', () => {
    let finished: FinishedMatch | null = null
    const tracker = new ServerMatchTracker((m) => (finished = m))
    const slots = [slot(0, 'human'), slot(1, 'human')]
    const state = (names = slots) => ({ tick: 0, slots: names, pawns: [{ owner: 0, alive: true }, { owner: 1, alive: false }] }) as unknown as SimState
    tracker.start({ slots, settings: DEFAULT_SETTINGS, devices: { 0: 'dev-aaaaaaaa', 1: 'dev-bbbbbbbb' } })
    tracker.observe(state(), [death(1, 0), roundWin([0])])
    const renamed = slots.map((s) => s.id === 0 ? { ...s, name: 'Renamed' } : s)
    tracker.observe(state(renamed), [death(1, 0), roundWin([0])])
    tracker.finish({ winners: [0], slots: renamed, scores: [], rounds: 2, ticks: 12000 })
    expect((finished as unknown as FinishedMatch).seats.find((s) => s.player === 0)).toMatchObject({ device: 'dev-aaaaaaaa', name: 'Renamed', kills: 2, roundsPlayed: 2, roundsWon: 2 })
  })

  /** Why: a room owner must not pad stats with bots: no kills of bots, no deaths to bots, no rating from bot rounds. */
  it('bots never count: kills, deaths and rankings are between humans only', () => {
    const slots = [slot(0, 'human'), slot(1, 'human'), slot(2, 'bot'), slot(3, 'bot')]
    const m = play(slots, { 0: 'dev-aaaaaaaa', 1: 'dev-bbbbbbbb' }, [
      // the owner (0) farms the bots: two bot kills, wins the round; 1 dies to a bot
      { deaths: [[2, 0], [1, 3], [3, 0]], winners: [0] },
      // 1 kills 0, a bot kills 1, the bot wins
      { deaths: [[0, 1], [1, 2]], winners: [2] },
    ])
    const a = m.seats.find((s) => s.player === 0)!
    const b = m.seats.find((s) => s.player === 1)!
    expect(a).toMatchObject({ kills: 0, deaths: 1, roundsWon: 1, roundsPlayed: 2 })
    expect(b).toMatchObject({ kills: 1, deaths: 0, roundsWon: 0, roundsPlayed: 2 })
    // round 2: 1 outlived 0, so 1 ranks above 0 although a bot won
    expect(m.ranked.map((r) => r.groups)).toEqual([[[0], [1]], [[1], [0]]])
    expect(ineligible(m)).toBeNull()
  })

  /** Why: one person with a second tab, a solo game with bots, or a quick throwaway match must not move the board. */
  it('ineligible: one human, one device in two seats, under 2 minutes, no round between humans', () => {
    const two = [slot(0, 'human'), slot(1, 'human'), slot(2, 'bot')]
    const r = [{ deaths: [[1, 0]] as [PlayerId, PlayerId | null][], winners: [0] }]
    expect(ineligible(play([slot(0, 'human'), slot(1, 'bot')], { 0: 'dev-aaaaaaaa' }, r))).toMatch(/fewer than 2/)
    expect(ineligible(play(two, { 0: 'dev-aaaaaaaa', 1: 'dev-aaaaaaaa' }, r))).toMatch(/fewer than 2/)
    expect(ineligible(play(two, { 0: 'dev-aaaaaaaa', 1: 'dev-bbbbbbbb' }, r, { ticks: 90 * 60 }))).toMatch(/shorter/)
    // the second human left at once and a bot played the seat: no round between humans
    expect(ineligible(play(two, { 0: 'dev-aaaaaaaa', 1: 'dev-bbbbbbbb' }, [{ deaths: [[2, 0], [1, 0]], winners: [0] }], { takeover: { player: 1, afterRound: -1 } }))).toMatch(/no round between humans/)
    expect(ineligible(play(two, { 0: 'dev-aaaaaaaa', 1: 'dev-bbbbbbbb' }, r))).toBeNull()
  })

  /** Why: a seat a bot took over stops counting for its player, so a bot never plays for someone's rating. */
  it('a seat a bot took over is out of the later rounds', () => {
    const slots = [slot(0, 'human'), slot(1, 'human'), slot(2, 'human')]
    const m = play(
      slots,
      { 0: 'dev-aaaaaaaa', 1: 'dev-bbbbbbbb', 2: 'dev-cccccccc' },
      [
        { deaths: [[2, 0], [1, 0]], winners: [0] },
        { deaths: [[0, 1], [2, 1]], winners: [1] },
      ],
      { takeover: { player: 1, afterRound: 0 } },
    )
    // round 2: seat 1 (now a bot) won, it is not ranked; 2 outlived 0
    expect(m.ranked[1].groups).toEqual([[2], [0]])
    expect(m.seats.find((s) => s.player === 1)).toMatchObject({ roundsPlayed: 1, roundsWon: 0, kills: 0 })
  })

  it('a human joining a bot seat counts only their later rounds and actions', () => {
    let finished: FinishedMatch | null = null
    const tracker = new ServerMatchTracker((m) => (finished = m))
    let slots = [slot(0, 'human'), slot(1, 'bot'), slot(2, 'bot')]
    const state = (alive: PlayerId[]) => ({ tick: 0, slots, pawns: slots.map((s) => ({ owner: s.id, alive: alive.includes(s.id) })) }) as unknown as SimState
    tracker.start({ slots, settings: DEFAULT_SETTINGS, devices: { 0: 'dev-aaaaaaaa' } })
    // Bot 1 wins and kills both opponents before the new player takes its seat.
    tracker.observe(state([1]), [death(0, 1), death(2, 1), roundWin([1])])
    slots = slots.map((s) => s.id === 1 ? slot(1, 'human') : s)
    tracker.join(slots[1], 'dev-bbbbbbbb')
    tracker.control(1, 'human')
    tracker.join(slots[2], 'dev-bot-nope')
    tracker.join(slot(2, 'human'))
    tracker.observe(state([1, 2]), [death(0, 1)])
    // Repeated registration must not reset the kill the human just earned.
    tracker.join(slots[1], 'dev-bbbbbbbb')
    tracker.observe(state([1]), [death(2, 1), roundWin([1])])
    tracker.finish({ winners: [1], slots, scores: [], rounds: 2, ticks: 200 * 60 })
    const result = finished as unknown as FinishedMatch
    expect(result.seats).toHaveLength(2)
    expect(result.seats.find((s) => s.player === 1)).toEqual({ player: 1, device: 'dev-bbbbbbbb', name: 'P1', roundsPlayed: 1, roundsWon: 1, kills: 1, deaths: 0, won: true })
    expect(result.seats.find((s) => s.player === 0)).toMatchObject({ roundsPlayed: 2, deaths: 1 })
    expect(result.ranked.map((r) => r.groups)).toEqual([[[0]], [[1], [0]]])
    expect(result.bots).toBe(2)
    expect(ineligible(result)).toBeNull()
  })
})

describe('leaderboard: rating', () => {
  const pair = (rounds: { deaths: [PlayerId, PlayerId | null][]; winners: PlayerId[] }[], settings?: Partial<MatchSettings>, team?: number[]) =>
    play(
      team ? team.map((t, i) => slot(i, 'human', t)) : [slot(0, 'human'), slot(1, 'human')],
      { 0: 'dev-aaaaaaaa', 1: 'dev-bbbbbbbb', 2: 'dev-cccccccc' },
      rounds,
      { settings },
    )

  /** Why: the 1v1 case is classic zero-sum Elo per round on the BOT_ELO scale (start 1000). */
  it('1v1: the round winner takes K/2 from an equal opponent, zero-sum', () => {
    const m = pair([{ deaths: [[1, 0]], winners: [0] }])
    const d = rateMatch(m, new Map())
    expect(d.get('dev-aaaaaaaa')).toBeCloseTo(LB_K / 2, 6)
    expect(d.get('dev-bbbbbbbb')).toBeCloseTo(-LB_K / 2, 6)
    // rounds chain: the second round starts from the first one's ratings
    const two = rateMatch(pair([{ deaths: [[1, 0]], winners: [0] }, { deaths: [[1, 0]], winners: [0] }]), new Map())
    expect(two.get('dev-aaaaaaaa')!).toBeGreaterThan(LB_K / 2)
    expect(two.get('dev-aaaaaaaa')!).toBeLessThan(LB_K)
    expect(two.get('dev-aaaaaaaa')! + two.get('dev-bbbbbbbb')!).toBeCloseTo(0, 6)
    // a favourite gains less for the same win
    expect(rateMatch(m, new Map([['dev-aaaaaaaa', 1400]])).get('dev-aaaaaaaa')!).toBeLessThan(LB_K / 4)
  })

  /** Why: in a free-for-all the winner gains most and the first to die loses most. */
  it('free-for-all: rank by survival, first death loses most', () => {
    const m = play([slot(0, 'human'), slot(1, 'human'), slot(2, 'human')], { 0: 'dev-aaaaaaaa', 1: 'dev-bbbbbbbb', 2: 'dev-cccccccc' }, [{ deaths: [[2, 1], [1, 0]], winners: [0] }])
    const d = rateMatch(m, new Map())
    expect(d.get('dev-aaaaaaaa')!).toBeGreaterThan(0)
    expect(d.get('dev-bbbbbbbb')!).toBeCloseTo(0, 6)
    expect(d.get('dev-cccccccc')!).toBeLessThan(0)
  })

  /** Why: teammates share the result; only opponents are rated against each other. */
  it('teams: teammates are not rated against each other', () => {
    const m = pair([{ deaths: [[1, 2], [2, 0]], winners: [0, 1] }], { teamMode: 'teams' }, [0, 0, 1])
    const d = rateMatch(m, new Map())
    expect(d.get('dev-aaaaaaaa')!).toBeCloseTo(d.get('dev-bbbbbbbb')!, 6)
    expect(d.get('dev-cccccccc')!).toBeCloseTo(-LB_K / 2, 6)
  })

  it('settle: rows carry totals, the public tag, the new rating', () => {
    const m = pair([{ deaths: [[1, 0]], winners: [0] }])
    const s = settleMatch(m, new Map(), 5000, 'us-west')
    if ('skipped' in s) throw new Error(s.skipped)
    const a = s.players.find((p) => p.device === 'dev-aaaaaaaa')!
    expect(a).toMatchObject({ matches: 1, wins: 1, roundsWon: 1, kills: 1, rating: LB_RATING_START + LB_K / 2, tag: deviceTag('dev-aaaaaaaa'), firstAt: 5000, lastAt: 5000 })
    expect(deviceTag('dev-aaaaaaaa')).toMatch(/^[0-9a-z]{5}$/)
    expect(deviceTag('dev-aaaaaaaa')).not.toBe(deviceTag('dev-bbbbbbbb'))
    const again = settleMatch(m, new Map(s.players.map((p) => [p.device, p])), 9000, 'us-west')
    if ('skipped' in again) throw new Error(again.skipped)
    expect(again.players.find((p) => p.device === 'dev-aaaaaaaa')).toMatchObject({ matches: 2, wins: 2, firstAt: 5000, lastAt: 9000 })
    expect(settleMatch({ ...m, ticks: 60 }, new Map(), 0, 'x')).toEqual({ skipped: 'shorter than 120 s' })
  })
})

describe('leaderboard store (node:sqlite)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) removeDir(d)
  })
  const row = (device: string, rating: number, at: number): PlayerRow => ({ device, name: device.slice(4), tag: deviceTag(device), rating, matches: 1, wins: 1, roundsPlayed: 3, roundsWon: 2, kills: 4, deaths: 1, firstAt: at, lastAt: at })
  const result = (device: string, delta: number, at: number, region = 'us-west') => ({ device, name: device.slice(4), at, region, won: delta > 0, roundsPlayed: 3, roundsWon: delta > 0 ? 2 : 1, kills: 2, deaths: 1, delta, rating: 1000 + delta })
  const match = (at: number, region = 'us-west') => ({ at, region, room: 'ABCDE', ticks: 9000, rounds: 3, humans: 2, bots: 0 })

  it('keeps one player row across renames and distinct devices that use the same name', () => {
    const store = openLeaderboard(':memory:')
    const devices = ['dev-aaaaaaaa', 'dev-bbbbbbbb']
    const slots = [slot(0, 'human'), slot(1, 'human')].map((s) => ({ ...s, name: 'Same name' }))
    const rounds = [{ deaths: [[1, 0]] as [PlayerId, PlayerId | null][], winners: [0] }]
    const first = settleMatch(play(slots, { 0: devices[0], 1: devices[1] }, rounds), new Map(), 1000, 'test')
    if ('skipped' in first) throw new Error(first.skipped)
    store.commit(match(1000, 'test'), first.results, first.players)
    const before = store.players(devices).get(devices[0])!
    expect(store.rename(devices[0], 'New name')).toBe(true)
    expect(store.players(devices).get(devices[0])).toEqual({ ...before, name: 'New name' })
    expect(store.rename(devices[0], 'New name')).toBe(false)
    expect(store.rename('dev-unknown1', 'Same name')).toBe(false)
    expect(store.players(['dev-unknown1']).size).toBe(0)
    expect(store.recent(devices[0], 10)[0].name).toBe('Same name')
    const renamed = slots.map((s) => s.id === 0 ? { ...s, name: 'New name' } : s)
    const second = settleMatch(play(renamed, { 0: devices[0], 1: devices[1] }, rounds), store.players(devices), 2000, 'test')
    if ('skipped' in second) throw new Error(second.skipped)
    store.commit(match(2000, 'test'), second.results, second.players)
    const query = { period: 'all' as const, region: null, since: 0 }
    expect(store.top(query, 10)).toHaveLength(2)
    expect(store.players(devices).get(devices[0])).toMatchObject({ name: 'New name', tag: deviceTag(devices[0]), matches: 2, kills: 2, firstAt: 1000, lastAt: 2000 })
    expect(store.players(devices).get(devices[1])).toMatchObject({ name: 'Same name', matches: 2 })
    expect(store.recent(devices[0], 10).map((r) => r.name)).toEqual(['New name', 'Same name'])
    expect(store.rank(query, devices[0])?.row.device).toBe(devices[0])
    store.close()
  })

  /** Why: pm2 reloads the server on every deploy; the board must survive that. */
  it('survives a restart; all-time by rating, week by gain, region filter, ranks', () => {
    const dir = tempDir('brawlock-lb-')
    dirs.push(dir)
    const file = `${dir}/data/leaderboard.sqlite`
    const day = 24 * 3600 * 1000
    const now = 100 * day
    let s = openLeaderboard(file)
    // old match: 'old' won big two weeks ago
    s.commit(match(now - 14 * day), [result('dev-old11111', 90, now - 14 * day), result('dev-new11111', -90, now - 14 * day)], [row('dev-old11111', 1090, now - 14 * day), row('dev-new11111', 910, now - 14 * day)])
    // this week: 'new' won a little
    s.commit(match(now - day), [result('dev-new11111', 15, now - day), result('dev-old11111', -15, now - day)], [{ ...row('dev-new11111', 925, now - day), matches: 2 }, { ...row('dev-old11111', 1075, now - day), matches: 2 }])
    // another region's result on this server (a migrated database)
    s.commit(match(now - day, 'eu'), [result('dev-eur11111', 30, now - day, 'eu'), result('dev-old11111', -30, now - day, 'eu')], [row('dev-eur11111', 1030, now - day), { ...row('dev-old11111', 1045, now - day), matches: 3 }])
    s.close()

    s = openLeaderboard(file)
    const all = { period: 'all' as const, region: null, since: 0 }
    expect(s.top(all, 10).map((r) => [r.name, Math.round(r.rating)])).toEqual([
      ['old11111', 1045],
      ['eur11111', 1030],
      ['new11111', 925],
    ])
    const week = { period: 'week' as const, region: 'us-west', since: now - 7 * day }
    expect(s.top(week, 10).map((r) => [r.name, r.gain, r.matches])).toEqual([
      ['new11111', 15, 1],
      ['old11111', -15, 1],
    ])
    expect(s.top({ ...all, region: 'eu' }, 10).map((r) => r.name)).toEqual(['old11111', 'eur11111'])
    expect(s.rank(all, 'dev-new11111')).toMatchObject({ rank: 3 })
    expect(s.rank(week, 'dev-eur11111')).toBeNull()
    // newest first: the two matches of the same moment by insertion, then the old one
    expect(s.recent('dev-old11111', 2).map((r) => r.delta)).toEqual([-30, -15])
    expect(s.recent('dev-old11111', 5)).toHaveLength(3)
    expect(s.players(['dev-old11111', 'dev-none1111']).size).toBe(1)
    s.close()
  })
})
