/**
 * Casual leaderboard (M4.3): the server-side tracker, eligibility, per-round Elo, and the
 * SQLite store surviving a restart.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { MatchResult } from '../game/store'
import type { MatchSettings, PlayerId, PlayerSlot, SimEvent, SimState } from '../sim/types'
import { createMatch, DEFAULT_SETTINGS, ticks } from '../sim'
import { openLeaderboard } from '../../server/leaderboard-store.mjs'
import { removeDir, tempDir } from '../../server/test-dir.mjs'
import { LB_K, LB_RATING_START, RECORD_HZ, ServerMatchTracker, deviceTag, ineligible, rateMatch, settleMatch, type FinishedMatch, type PlayerRow, type PublicBoardRow } from './leaderboard'
import { localRatingAuthority, validRatingSubmission, type RatingSubmission } from './ratingAuthority'
import { remoteRatingAuthority } from '../../server/rating-client.mjs'

const slot = (id: PlayerId, kind: 'human' | 'bot', team = id): PlayerSlot => ({ id, name: kind === 'bot' ? `Bot ${id}` : `P${id}`, color: 0, team, kind })
const death = (owner: PlayerId, killer: PlayerId | null, cause = 'fireball'): SimEvent => ({ type: 'death', pawn: 100 + owner, owner, killer, cause }) as SimEvent
const roundWin = (players: PlayerId[], team = players[0] ?? -1): SimEvent => ({ type: 'roundWin', team, players })

/** Scripted match: per round, the order of deaths (with killers) and the winners. */
function play(slots: PlayerSlot[], devices: Record<PlayerId, string>, rounds: { deaths: [PlayerId, PlayerId | null][]; winners: PlayerId[] }[], opts: { ticks?: number; settings?: Partial<MatchSettings>; takeover?: { player: PlayerId; afterRound: number } } = {}): FinishedMatch {
  let out: FinishedMatch | null = null
  const t = new ServerMatchTracker((m) => { out = m })
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
  const result: MatchResult = { winners: rounds.at(-1)?.winners ?? [], slots, scores: [], rounds: rounds.length, ticks: opts.ticks ?? ticks(200) }
  t.finish(result)
  return out!
}

describe('leaderboard: what counts', () => {
  it('keeps all five scoring rounds, then rates only the human finalists and their final death order', () => {
    const slots = [0, 1, 2, 3].map((id) => slot(id, 'human'))
    const devices = Object.fromEntries(slots.map((s) => [s.id, `dev-player-${s.id}`]))
    const settings = { ...DEFAULT_SETTINGS, rankedRounds: 5 as const }
    const state = createMatch(settings, slots, 42)
    let finished: FinishedMatch | null = null
    const tracker = new ServerMatchTracker((match) => { finished = match })
    tracker.start({ slots, settings, devices })
    for (const [index, winner] of [0, 1, 0, 1, 2].entries()) {
      state.round = index + 1
      // The fifth round selects the final roster before the recorder sees its events.
      if (state.round === 5) state.rankedFinal = { contenders: [0, 1] }
      for (const pawn of state.pawns) pawn.alive = pawn.owner === winner
      tracker.observe(state, [...slots.filter((s) => s.id !== winner).map((s) => death(s.id, winner)), roundWin([winner])])
    }
    state.round = 6
    state.rankedFinal = { contenders: [0, 1], winners: [1] }
    for (const pawn of state.pawns) pawn.alive = pawn.owner === 1
    tracker.observe(state, [death(0, 1), roundWin([1])])
    tracker.finish({ winners: [1], slots, scores: [], rounds: 6, ticks: ticks(240) })
    const match = finished as unknown as FinishedMatch
    expect(match.ranked).toHaveLength(6)
    expect(match.ranked[4].groups.flat().sort()).toEqual([0, 1, 2, 3])
    expect(match.ranked[5].groups).toEqual([[1], [0]])
    expect(match.seats.map((s) => [s.player, s.roundsPlayed, s.roundsWon, s.won])).toEqual([
      [0, 6, 2, false], [1, 6, 3, true], [2, 5, 1, false], [3, 5, 0, false],
    ])
    const withoutFinal = rateMatch({ ...match, ranked: match.ranked.slice(0, 5) }, new Map())
    const withFinal = rateMatch(match, new Map())
    // the match result orders them: the final's winner, then by round wins
    const d = (id: number) => withFinal.get(devices[id])!
    expect(d(1)).toBeGreaterThan(d(0))
    expect(d(0)).toBeGreaterThan(d(2))
    expect(d(2)).toBeGreaterThan(d(3))
    // benched seats are not rated in the extra final
    for (const id of [2, 3]) expect(withFinal.get(devices[id])).toBe(withoutFinal.get(devices[id]))
    const settled = settleMatch(match, new Map(), 1000, 'eu')
    if ('skipped' in settled) throw new Error(settled.skipped)
    expect(settled.results.find((s) => s.device === devices[2])).toMatchObject({ roundsPlayed: 5, roundsWon: 1, won: false })
  })

  it('does not turn a benched seat into a rated final participant through cleanup death events', () => {
    const slots = [0, 1, 2, 3].map((id) => slot(id, 'human'))
    const settings = { ...DEFAULT_SETTINGS, rankedRounds: 5 as const }
    const state = createMatch(settings, slots, 42)
    state.round = 6
    state.rankedFinal = { contenders: [0, 1, 2] }
    state.pawns.forEach((p) => { p.alive = p.owner === 2 })
    let finished: FinishedMatch | null = null
    const tracker = new ServerMatchTracker((match) => { finished = match })
    tracker.start({ slots, settings, devices: { 0: 'dev-aaaaaaaa', 1: 'dev-bbbbbbbb', 2: 'dev-cccccccc', 3: 'dev-dddddddd' } })
    tracker.observe(state, [death(3, null, 'disconnect'), death(1, 2), death(0, 2), roundWin([2])])
    tracker.finish({ winners: [2], slots, scores: [], rounds: 6, ticks: ticks(240) })
    const match = finished as unknown as FinishedMatch
    expect(match.ranked).toEqual([{ groups: [[2], [0], [1]], team: { 0: 0, 1: 1, 2: 2 } }])
    expect(match.seats[3]).toMatchObject({ roundsPlayed: 0, roundsWon: 0, kills: 0, deaths: 0 })
  })

  it('a live rename updates the display label without changing the device or resetting counters', () => {
    let finished: FinishedMatch | null = null
    const tracker = new ServerMatchTracker((m) => { finished = m })
    const slots = [slot(0, 'human'), slot(1, 'human')]
    const state = (names = slots) => ({ tick: 0, slots: names, pawns: [{ owner: 0, alive: true }, { owner: 1, alive: false }] }) as unknown as SimState
    tracker.start({ slots, settings: DEFAULT_SETTINGS, devices: { 0: 'dev-aaaaaaaa', 1: 'dev-bbbbbbbb' } })
    tracker.observe(state(), [death(1, 0), roundWin([0])])
    const renamed = slots.map((s) => s.id === 0 ? { ...s, name: 'Renamed' } : s)
    tracker.observe(state(renamed), [death(1, 0), roundWin([0])])
    tracker.finish({ winners: [0], slots: renamed, scores: [], rounds: 2, ticks: ticks(200) })
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
    expect(ineligible(play(two, { 0: 'dev-aaaaaaaa', 1: 'dev-bbbbbbbb' }, r, { ticks: ticks(90) }))).toMatch(/shorter/)
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

  it.each([false, true])('awards a final match win only if the human controls their seat at finish (rejoined: %s)', (rejoined) => {
    const slots = [slot(0, 'human'), slot(1, 'human')]
    const settings = { ...DEFAULT_SETTINGS, rankedRounds: 5 as const }
    const state = createMatch(settings, slots, 42)
    let finished: FinishedMatch | null = null
    const tracker = new ServerMatchTracker((match) => { finished = match })
    tracker.start({ slots, settings, devices: { 0: 'dev-aaaaaaaa', 1: 'dev-bbbbbbbb' } })
    state.round = 1
    state.pawns[1].alive = false
    tracker.observe(state, [death(1, 0), roundWin([0])])
    tracker.control(0, 'bot')
    if (rejoined) tracker.control(0, 'human')
    state.round = 6
    state.rankedFinal = { contenders: [0, 1], winners: [0] }
    tracker.observe(state, [death(1, 0), roundWin([0])])
    tracker.finish({ winners: [0], slots, scores: [], rounds: 6, ticks: ticks(240) })
    const match = finished as unknown as FinishedMatch
    expect(match.seats[0]).toMatchObject({ won: rejoined, roundsPlayed: rejoined ? 2 : 1, roundsWon: rejoined ? 2 : 1 })
    const settled = settleMatch(match, new Map(), 1000, 'eu')
    if ('skipped' in settled) throw new Error(settled.skipped)
    expect(settled.results.find((r) => r.device === 'dev-aaaaaaaa')?.won).toBe(rejoined)
    expect(settled.players.find((p) => p.device === 'dev-aaaaaaaa')?.wins).toBe(rejoined ? 1 : 0)
  })

  it('a human joining a bot seat counts only their later rounds and actions', () => {
    let finished: FinishedMatch | null = null
    const tracker = new ServerMatchTracker((m) => { finished = m })
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
    tracker.finish({ winners: [1], slots, scores: [], rounds: 2, ticks: ticks(200) })
    const result = finished as unknown as FinishedMatch
    expect(result.seats).toHaveLength(2)
    expect(result.seats.find((s) => s.player === 1)).toMatchObject({ player: 1, device: 'dev-bbbbbbbb', name: 'P1', roundsPlayed: 1, roundsWon: 1, kills: 1, deaths: 0, won: true })
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

  /** Why: the 1v1 case is classic zero-sum Elo per match on the BOT_ELO scale (start 1000). */
  it('1v1: the match winner takes K/2 from an equal opponent, zero-sum', () => {
    const m = pair([{ deaths: [[1, 0]], winners: [0] }])
    const d = rateMatch(m, new Map())
    expect(d.get('dev-aaaaaaaa')).toBeCloseTo(LB_K / 2, 6)
    expect(d.get('dev-bbbbbbbb')).toBeCloseTo(-LB_K / 2, 6)
    // one game per match: more rounds won in the same match do not stack
    const two = rateMatch(pair([{ deaths: [[1, 0]], winners: [0] }, { deaths: [[1, 0]], winners: [0] }]), new Map())
    expect(two.get('dev-aaaaaaaa')!).toBeCloseTo(LB_K / 2, 6)
    expect(two.get('dev-aaaaaaaa')! + two.get('dev-bbbbbbbb')!).toBeCloseTo(0, 6)
    // a favourite gains less for the same win
    expect(rateMatch(m, new Map([['dev-aaaaaaaa', 1400]])).get('dev-aaaaaaaa')!).toBeLessThan(LB_K / 4)
  })

  /**
   * Why (2026-10-19 report): the match winner lost rating to a player with no round win.
   * Rounds were rated one by one by survival, and in the rounds bots won the winner had been
   * knocked out before the other human. The match result must decide.
   */
  it('the match winner gains even when the loser outlived them in the rounds bots won', () => {
    const tracked = (finalWinner: PlayerId) => {
      const slots = [slot(0, 'human'), slot(1, 'human'), slot(2, 'bot')]
      let finished: FinishedMatch | null = null
      const tracker = new ServerMatchTracker((m) => { finished = m })
      tracker.start({ slots, settings: DEFAULT_SETTINGS, devices: { 0: 'dev-aaaaaaaa', 1: 'dev-bbbbbbbb' } })
      const state = createMatch(DEFAULT_SETTINGS, slots, 1)
      // 0 wins two rounds; in three rounds the bot wins and 0 dies before 1
      const rounds: [PlayerId[], PlayerId][] = [[[1, 2], 0], [[1, 2], 0], [[0, 1], 2], [[0, 1], 2], [[0, 1], 2]]
      for (const [dead, winner] of rounds) {
        for (const p of state.pawns) p.alive = p.owner === winner
        tracker.observe(state, [...dead.map((id) => death(id, winner)), roundWin([winner])])
      }
      tracker.finish({ winners: [finalWinner], slots, scores: [], rounds: 5, ticks: ticks(900) })
      return finished as unknown as FinishedMatch
    }
    const d = rateMatch(tracked(0), new Map())
    expect(d.get('dev-aaaaaaaa')!).toBeGreaterThan(0)
    expect(d.get('dev-bbbbbbbb')!).toBeLessThan(0)
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
    expect(settleMatch({ ...m, ticks: RECORD_HZ }, new Map(), 0, 'x')).toEqual({ skipped: 'shorter than 120 s' })
  })
})

describe('leaderboard: departed humans', () => {
  function tracked(devices = { 0: 'dev-aaaaaaaa', 1: 'dev-bbbbbbbb' }, teamMode: MatchSettings['teamMode'] = 'ffa') {
    const slots = [slot(0, 'human'), slot(1, 'human'), slot(2, 'bot')]
    const settings = { ...DEFAULT_SETTINGS, teamMode }
    const state = createMatch(settings, slots, 42)
    let finished: FinishedMatch | null = null
    const tracker = new ServerMatchTracker((m) => { finished = m })
    tracker.start({ slots, settings, devices })
    const observe = (tick: number, phase: SimState['phase'] = state.phase, events: SimEvent[] = []) => {
      state.tick = tick
      state.phase = phase
      tracker.observe(state, events)
    }
    const finish = (winners: PlayerId[], abandoned = false) => {
      tracker.finish({ winners, slots, scores: state.scores, rounds: state.round, ticks: state.tick, ...(abandoned ? { abandoned: true } : {}) })
      return finished as unknown as FinishedMatch
    }
    return { tracker, state, observe, finish }
  }

  it('counts only human-controlled combat time, including a dead human watching, and makes the departure a loss', () => {
    const f = tracked()
    f.observe(0, 'shop')
    f.observe(ticks(100), 'shop')
    f.observe(ticks(100), 'fight')
    f.state.pawns[0].alive = false
    f.observe(ticks(160), 'fight')
    f.tracker.control(0, 'bot')
    f.observe(ticks(200), 'fight')
    const match = f.finish([0])
    expect(match.seats[0]).toMatchObject({ combatTicks: 60 * RECORD_HZ, forfeited: true, won: false, roundsPlayed: 0 })
    expect(match.combatPairs).toEqual([{ players: [0, 1], ticks: 60 * RECORD_HZ }])
    expect(match.ranked).toEqual([])
    expect(ineligible(match)).toBeNull()
    const result = settleMatch(match, new Map(), 1000, 'eu')
    if ('skipped' in result) throw new Error(result.skipped)
    expect(result.results.find((r) => r.device === 'dev-aaaaaaaa')).toMatchObject({ forfeited: true, won: false, delta: -20, roundsPlayed: 0 })
    expect(result.players.find((p) => p.device === 'dev-aaaaaaaa')).toMatchObject({ matches: 1, wins: 0, rating: 980 })
  })

  it('keeps the last human build and full bot roster while excluding bot upgrades; a sub-minute departure still forfeits', () => {
    const f = tracked()
    f.observe(0, 'fight')
    const pawn = f.state.pawns[0]
    const index = pawn.slots.indexOf('fireball')
    pawn.levels[index] = 2
    f.observe(ticks(60) - 1)
    f.tracker.control(0, 'bot')
    pawn.levels[index] = 5
    f.observe(ticks(160))
    const match = f.finish([0])
    expect(match.seats[0].combatTicks).toBeLessThan(60 * RECORD_HZ)
    expect(match.seats[0].combatTicks).toBeGreaterThan(59 * RECORD_HZ)
    expect(match.seats[0].forfeited).toBe(true)
    expect(match.seats[0].build?.levels[index]).toBe(2)
    expect(match.seats[0]).not.toHaveProperty('stats')
    expect(match.roster).toHaveLength(3)
    expect(match.roster?.find((p) => p.player === 0)).toMatchObject({ device: 'dev-aaaaaaaa', kind: 'human', build: { levels: match.seats[0].build!.levels }, won: false })
    expect(match.roster?.find((p) => p.player === 2)).toMatchObject({ kind: 'bot', name: 'Bot 2' })
  })

  it('rejoining before completion clears absence, resumes human time and records the human build again', () => {
    const f = tracked()
    f.observe(0, 'fight')
    f.observe(ticks(60))
    f.tracker.control(0, 'bot')
    f.observe(ticks(120))
    f.tracker.control(0, 'human')
    f.observe(ticks(121), 'fight', [roundWin([0])])
    const match = f.finish([0])
    expect(match.seats[0]).toMatchObject({ combatTicks: 61 * RECORD_HZ, won: true, roundsPlayed: 1 })
    expect(match.seats[0]).not.toHaveProperty('forfeited')
    expect(rateMatch(match, new Map()).get('dev-aaaaaaaa')).toBeGreaterThan(0)
  })

  it('settles an empty first round after two shared minutes as losses for both, with no fabricated round or winner', () => {
    const short = tracked()
    short.observe(0, 'fight')
    short.observe(ticks(60))
    short.tracker.control(0, 'bot')
    short.tracker.control(1, 'bot')
    // Everyone left after one minute: the match does not count, so neither departure does.
    expect(ineligible(short.finish([], true))).toBe('shorter than 120 s')

    const f = tracked()
    f.observe(0, 'fight')
    f.observe(ticks(120))
    f.tracker.control(0, 'bot')
    f.tracker.control(1, 'bot')
    const match = f.finish([], true)
    expect(match).toMatchObject({ abandoned: true, ranked: [], ticks: 120 * RECORD_HZ })
    expect(match.seats.map((s) => [s.forfeited, s.won, s.roundsPlayed])).toEqual([[true, false, 0], [true, false, 0]])
    expect(ineligible(match)).toBeNull()
    expect([...rateMatch(match, new Map()).values()]).toEqual([-20, -20])
    const result = settleMatch(match, new Map(), 1000, 'eu')
    if ('skipped' in result) throw new Error(result.skipped)
    expect(result.players.map((p) => [p.matches, p.wins, p.roundsPlayed, p.rating])).toEqual([[1, 0, 0, 980], [1, 0, 0, 980]])
  })

  it('never lets a forfeiter keep positive Elo through earlier round wins', () => {
    const m = play([slot(0, 'human'), slot(1, 'human')], { 0: 'dev-aaaaaaaa', 1: 'dev-bbbbbbbb' }, [
      { deaths: [[1, 0]], winners: [0] }, { deaths: [[1, 0]], winners: [0] },
    ])
    m.seats[0].forfeited = true
    m.seats[0].won = false
    m.seats[1].won = false
    expect(rateMatch(m, new Map()).get('dev-aaaaaaaa')).toBe(-20)
    expect(rateMatch(m, new Map()).get('dev-bbbbbbbb')).toBe(20)
  })

  /** Why: the one-minute threshold let a losing player escape by leaving early (or in the first shop). */
  it('makes any departure from a counted match a loss, even one during the first shop before any fight', () => {
    const f = tracked()
    f.observe(0, 'shop')
    f.observe(ticks(1), 'shop')
    f.tracker.control(0, 'bot')
    f.observe(ticks(10), 'fight')
    f.observe(ticks(150), 'fight', [roundWin([1])])
    const match = f.finish([1])
    expect(match.seats[0]).toMatchObject({ forfeited: true, combatTicks: 0, roundsPlayed: 0 })
    // They shared the shop, so the leaver is rated against the human who stayed.
    expect(match.combatPairs).toEqual([{ players: [0, 1], ticks: 0 }])
    expect(ineligible(match)).toBeNull()
    expect([...rateMatch(match, new Map()).entries()]).toEqual([['dev-aaaaaaaa', -20], ['dev-bbbbbbbb', 20]])
  })

  /** Why: bots playing on in an empty room (a reconnect window) must not make a match count. */
  it('ends an abandoned match’s played time when its last human left', () => {
    const f = tracked()
    f.observe(0, 'fight')
    f.observe(ticks(110))
    f.tracker.control(0, 'bot')
    f.tracker.control(1, 'bot')
    f.observe(ticks(130)) // nobody returns; bots keep playing past two minutes
    const match = f.finish([], true)
    expect(match.ticks).toBe(110 * RECORD_HZ)
    expect(ineligible(match)).toBe('shorter than 120 s')
    // One human still playing keeps the whole match.
    const kept = tracked()
    kept.observe(0, 'fight')
    kept.observe(ticks(10))
    kept.tracker.control(0, 'bot')
    kept.observe(ticks(130), 'fight', [roundWin([1])])
    expect(kept.finish([1]).ticks).toBe(130 * RECORD_HZ)
  })

  it('requires two unique human opponents who shared the match, never solo, duplicate or sequential bot games', () => {
    const early = tracked()
    early.observe(0, 'fight'); early.observe(ticks(60) - 1)
    early.tracker.control(0, 'bot'); early.tracker.control(1, 'bot')
    expect(ineligible(early.finish([], true))).toMatch(/shorter/)

    const sequential = tracked()
    sequential.tracker.control(1, 'bot')
    sequential.observe(0, 'fight'); sequential.observe(ticks(60))
    sequential.tracker.control(0, 'bot'); sequential.tracker.control(1, 'human')
    sequential.observe(ticks(120))
    sequential.tracker.control(1, 'bot')
    expect(ineligible(sequential.finish([], true))).toBe('no round between humans')

    const duplicate = tracked({ 0: 'dev-aaaaaaaa', 1: 'dev-aaaaaaaa' })
    duplicate.observe(0, 'fight'); duplicate.observe(ticks(60))
    duplicate.tracker.control(0, 'bot'); duplicate.tracker.control(1, 'bot')
    expect(ineligible(duplicate.finish([], true))).toBe('fewer than 2 humans')

    const teammates = tracked(undefined, 'teams')
    teammates.state.slots[1].team = teammates.state.slots[0].team
    teammates.observe(0, 'fight'); teammates.observe(ticks(60))
    teammates.tracker.control(0, 'bot'); teammates.tracker.control(1, 'bot')
    expect(ineligible(teammates.finish([], true))).toMatch(/shorter/)
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

describe('one global authority and additive idempotency receipts', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) removeDir(dir) })
  const submission = (key = 'global-match-0001', region = 'eu'): RatingSubmission => ({
    key, region, room: 'ABCDE', at: 100_000, minSeconds: 1,
    match: play([slot(0, 'human'), slot(1, 'human')], { 0: 'dev-aaaaaaaa', 1: 'dev-cccccccc' }, [
      { deaths: [[1, 0]], winners: [0] },
    ]),
  })

  it('reports rolling seven-day net Elo from counted results across regions, not an inferred rating baseline', async () => {
    const day = 24 * 3600 * 1000
    let now = 100 * day
    const since = now - 7 * day
    const store = openLeaderboard(':memory:')
    const authority = localRatingAuthority(store, { minSeconds: 1, clock: () => now })
    try {
      // A preserved legacy player without historical result rows has no known recent movement.
      const legacy: PlayerRow = { device: 'dev-legacy00', name: 'Legacy', tag: deviceTag('dev-legacy00'), rating: 1450, matches: 1, wins: 1, roundsPlayed: 1, roundsWon: 1, kills: 0, deaths: 0, firstAt: 1, lastAt: 1 }
      store.commit({ at: 1, region: 'us-west', room: 'ABCDE', ticks: 12000, rounds: 1, humans: 2, bots: 0 }, [], [legacy])
      for (const [index, at, region] of [[0, since - 1, 'us-west'], [1, since, 'eu'], [2, now - day, 'us-west'], [3, now, 'eu'], [4, now + 1, 'eu']] as const) {
        const request = { ...submission(`rolling-match-${index}`, region), at }
        if (index === 2) {
          request.match = play([slot(0, 'human'), slot(1, 'human')], { 0: 'dev-aaaaaaaa', 1: 'dev-cccccccc' }, [{ deaths: [[0, 1]], winners: [1] }])
        }
        expect(await authority.record(request)).toEqual({ status: 'rated' })
      }
      const expected = () => Math.round(store.recent('dev-aaaaaaaa', 100)
        .filter((r) => r.at >= now - 7 * day && r.at <= now).reduce((sum, r) => sum + r.delta, 0))
      const board = async () => (await authority.read('/leaderboard?period=all&device=dev-aaaaaaaa&region=eu')).body as { entries: PublicBoardRow[]; you: PublicBoardRow }
      const first = await board()
      expect(first.you.ratingChange7d).toBe(expected())
      expect(first.you.ratingChange7d).not.toBe(first.you.gain)
      expect(first.entries.find((r) => r.tag === deviceTag('dev-cccccccc'))?.ratingChange7d).toBe(-expected())
      expect(first.entries.find((r) => r.name === 'Legacy')).toMatchObject({ rating: 1450, ratingChange7d: 0 })
      expect((await authority.read('/players/dev-aaaaaaaa')).body).toMatchObject({ ratingChange7d: expected() })
      expect(await authority.read('/leaderboard?period=all&device=dev-aaaaaaaa&region=us-west')).toEqual(await authority.read('/leaderboard?period=all&device=dev-aaaaaaaa&region=eu'))
      expect(JSON.stringify(first)).not.toContain('dev-')

      // Bot-only opposition never supplies an eligible result or contributes to this sum.
      const solo = submission('rolling-solo-bot')
      solo.at = now
      solo.match = play([slot(0, 'human'), slot(1, 'bot')], { 0: 'dev-aaaaaaaa' }, [{ deaths: [[1, 0]], winners: [0] }])
      expect(await authority.record(solo)).toEqual({ status: 'unrated', reason: 'fewer than 2 humans' })
      expect((await board()).you).toEqual(first.you)

      // Advancing one millisecond drops the old boundary result and admits the new one.
      now += 1
      expect((await board()).you.ratingChange7d).toBe(expected())
      now += 8 * day
      expect((await board()).entries.every((r) => r.ratingChange7d === 0)).toBe(true)
      expect((await authority.read('/leaderboard?period=week')).body).toMatchObject({ entries: [], you: null })
    } finally { authority.close!() }
  })

  it('preserves old rows, rates both regions on the same scale, and deduplicates concurrent retries through a restart', async () => {
    const dir = tempDir('brawlock-global-receipts-')
    dirs.push(dir)
    const file = `${dir}/leaderboard.sqlite`
    let store = openLeaderboard(file)
    const legacy = play([slot(0, 'human'), slot(1, 'human')], { 0: 'dev-aaaaaaaa', 1: 'dev-bbbbbbbb' }, [{ deaths: [[1, 0]], winners: [0] }])
    const settled = settleMatch(legacy, new Map(), 90_000, 'us-west', 1)
    if ('skipped' in settled) throw new Error(settled.skipped)
    // Existing writers do not supply receipts; their data remains untouched.
    store.commit({ at: 90_000, region: 'us-west', room: 'ABCDE', ticks: legacy.ticks, rounds: 1, humans: 2, bots: 0 }, settled.results, settled.players)
    const original = store.players(['dev-aaaaaaaa']).get('dev-aaaaaaaa')!
    store.close()
    store = openLeaderboard(file)
    let authority = localRatingAuthority(store, { minSeconds: 1, clock: () => 100_000 })
    const request = submission()
    expect(await Promise.all([authority.record(request), authority.record(request)])).toEqual([{ status: 'rated' }, { status: 'rated' }])
    expect(store.players(['dev-aaaaaaaa']).get('dev-aaaaaaaa')).toMatchObject({ matches: 2, firstAt: original.firstAt })
    expect(store.recent('dev-aaaaaaaa', 10).map((r) => r.region)).toEqual(['eu', 'us-west'])
    const before = store.top({ period: 'all', region: null, since: 0 }, 10)
    authority.close!()
    store = openLeaderboard(file)
    authority = localRatingAuthority(store, { minSeconds: 1, clock: () => 100_000 })
    expect(await authority.record(request)).toEqual({ status: 'rated' })
    expect(store.top({ period: 'all', region: null, since: 0 }, 10)).toEqual(before)
    const all = await authority.read('/leaderboard?period=all&region=eu')
    const west = await authority.read('/leaderboard?period=all&region=us-west')
    expect(west).toEqual(all)
    expect((all.body as { entries: unknown[] }).entries).toHaveLength(3)
    expect(JSON.stringify(all)).not.toContain('dev-')
    await authority.rename('dev-aaaaaaaa', 'Renamed globally')
    expect((await authority.read('/players/dev-aaaaaaaa')).body).toMatchObject({ name: 'Renamed globally', matches: 2 })
    const delayed = submission('global-delayed-0001')
    delayed.at = 80_000
    delayed.match.seats[0].name = 'Old label'
    expect(await authority.record(delayed)).toEqual({ status: 'rated' })
    expect(store.players(['dev-aaaaaaaa']).get('dev-aaaaaaaa')).toMatchObject({ name: 'Renamed globally', matches: 3, firstAt: 80_000, lastAt: 100_000 })
    authority.close!()
  })

  it('rejects a reused key with changed contents and atomically rolls back a failed receipt-plus-match commit', async () => {
    const store = openLeaderboard(':memory:')
    const authority = localRatingAuthority(store, { minSeconds: 1 })
    const request = submission()
    const settled = settleMatch(request.match, new Map(), request.at, request.region, 1)
    if ('skipped' in settled) throw new Error(settled.skipped)
    const meta = { at: request.at, region: request.region, room: request.room, ticks: request.match.ticks, rounds: 1, humans: 2, bots: 0 }
    expect(() => store.commitReceipt(request.key, 'failed-fingerprint', { status: 'rated' }, meta, [...settled.results, settled.results[0]], settled.players)).toThrow()
    expect(store.receipt(request.key, 'failed-fingerprint')).toBeNull()
    expect(store.top({ period: 'all', region: null, since: 0 }, 10)).toEqual([])
    expect(await authority.record(request)).toEqual({ status: 'rated' })
    const before = store.recent('dev-aaaaaaaa', 10)
    await expect(authority.record({ ...request, match: { ...request.match, ticks: request.match.ticks + 1 } })).rejects.toThrow(/conflicts/)
    expect(store.recent('dev-aaaaaaaa', 10)).toEqual(before)
    authority.close!()
  })

  it('keeps the authority minimum authoritative and remembers an unrated verdict', async () => {
    const store = openLeaderboard(':memory:')
    const authority = localRatingAuthority(store, { minSeconds: 120 })
    const request = submission()
    request.match.ticks = 90 * RECORD_HZ
    expect(await authority.record(request)).toEqual({ status: 'unrated', reason: 'shorter than 120 s' })
    expect(await authority.record(request)).toEqual({ status: 'unrated', reason: 'shorter than 120 s' })
    expect(store.top({ period: 'all', region: null, since: 0 }, 10)).toEqual([])
    authority.close!()
  })

  it('bounds and validates finished simulation records before storage', () => {
    const request = submission()
    expect(validRatingSubmission(request)).toBe(true)
    expect(validRatingSubmission({ ...request, extra: true })).toBe(false)
    expect(validRatingSubmission({ ...request, minSeconds: -1 })).toBe(false)
    expect(validRatingSubmission({ ...request, match: { ...request.match, seats: Array(11).fill(request.match.seats[0]) } })).toBe(false)
    expect(validRatingSubmission({ ...request, match: { ...request.match, ranked: [{ groups: [[0], [0]], team: { 0: 0 } }] } })).toBe(false)
    expect(validRatingSubmission({ ...request, match: { ...request.match, ranked: [{ groups: [[9]], team: { 9: 0 } }] } })).toBe(false)
    expect(validRatingSubmission({ ...request, match: { ...request.match, seats: [{ ...request.match.seats[0], kills: Infinity }] } })).toBe(false)
  })

  it('refuses plaintext authority URLs and missing server credentials', () => {
    const opts = { url: 'http://127.0.0.1:5350', token: crypto.randomUUID(), file: ':memory:', log: () => {} }
    expect(() => remoteRatingAuthority(opts)).toThrow(/HTTPS/)
    expect(() => remoteRatingAuthority({ ...opts, url: 'https://authority.invalid', token: '' })).toThrow(/token/)
    expect(() => remoteRatingAuthority({ ...opts, url: 'https://authority.invalid/not-an-origin' })).toThrow(/origin/)
  })
})
