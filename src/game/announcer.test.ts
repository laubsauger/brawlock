import { describe, expect, it } from 'vitest'
import { TICK_HZ, type PawnState, type SimEvent } from '../sim/types'
import { DEFAULT_SETTINGS, TEAM_DRAW, createMatch, step } from '../sim'
import { createBot } from '../bots'
import { MULTI_WINDOW } from '../render/overlay/killStamps'
import { ANNOUNCER_TEXT, Announcer, COUNTDOWN_SECONDS, DEFEAT_LINES, DENIED_COOLDOWN, HILL_CAPTURE_LINES, MATCH_WIN_LINES, ROUND_WIN_LINES, STALE_AFTER, defeatLine, matchWinLine, roundCall, roundWinLine, type Announcement, type AnnouncerView } from './announcer'

const ME = 0
const FOE = 1
const OTHER = 2

/** A death of `victim`'s pawn credited to `killer` (null = lava with no hitter). */
const death = (victim: number, killer: number | null): SimEvent => ({ type: 'death', pawn: 100 + victim, owner: victim, killer })

/** An announcer whose lines are short, so the queue never holds the ladder back. */
function quick(): Announcer {
  const a = new Announcer()
  a.lineLength = () => 0.1
  return a
}

/** Feed events at times; collect every line started (draining the queue in between). */
function run(a: Announcer, timeline: [number, SimEvent[]][], local = ME): Announcement[] {
  const out: Announcement[] = []
  let t = 0
  for (const [at, events] of timeline) {
    for (; t < at; t += 0.05) {
      const x = a.next(t)
      if (x) out.push(x)
    }
    const x = a.update(events, at, local)
    if (x) out.push(x)
    t = at
  }
  for (let k = 0; k < 60; k++, t += 0.05) {
    const x = a.next(t)
    if (x) out.push(x)
  }
  return out
}

describe('announcer: first blood', () => {
  it('fires once per match, for everyone, and again in the next match', () => {
    const a = quick()
    // the opponent draws first blood: still announced to us
    const lines = run(a, [
      [1, [death(ME, FOE)]],
      [8, [death(FOE, ME)]],
      [15, [death(OTHER, FOE)]],
    ])
    expect(lines.filter((l) => l.line === 'first_blood')).toHaveLength(1)
    expect(lines.find((l) => l.line === 'first_blood')!.player).toBe(FOE)
    expect(lines.find((l) => l.line === 'first_blood')!.victim).toBe(ME)
    // a new match restarts the sim clock: first blood is up for grabs again
    expect(run(a, [[2, [death(FOE, ME)]]]).map((l) => l.line)).toContain('first_blood')
  })
})

describe('announcer: multi-kills', () => {
  it('climbs the ladder for kills chained inside the kill-stamp window', () => {
    const a = quick()
    const kills: [number, SimEvent[]][] = []
    for (let k = 0; k < 8; k++) kills.push([1 + k * (MULTI_WINDOW - 0.5), [death(10 + k, ME)]])
    const multi = run(a, kills).filter((l) => l.kind === 'multi').map((l) => l.line)
    expect(multi).toEqual(['double_kill', 'triple_kill', 'multi_kill', 'mega_kill', 'ultra_kill', 'monster_kill', 'monster_kill'])
  })

  it('a gap longer than the window starts the chain over', () => {
    const a = quick()
    const lines = run(a, [
      [1, [death(10, ME)]],
      [1 + MULTI_WINDOW + 0.5, [death(11, ME)]],
    ])
    expect(lines.some((l) => l.kind === 'multi')).toBe(false)
  })

  it('two kills in one tick are a double kill', () => {
    expect(run(quick(), [[1, [death(10, ME), death(11, ME)]]]).some((l) => l.line === 'double_kill')).toBe(true)
  })

  it('is only announced for your own kills', () => {
    const lines = run(quick(), [
      [1, [death(10, FOE)]],
      [2, [death(11, FOE)]],
    ])
    expect(lines.some((l) => l.kind === 'multi')).toBe(false)
  })
})

describe('announcer: streaks', () => {
  /** n kills by `killer`, far enough apart that they are not a multi-kill */
  const kills = (killer: number, n: number, from: number): [number, SimEvent[]][] =>
    Array.from({ length: n }, (_, k) => [from + k * (MULTI_WINDOW + 1), [death(20 + k, killer)]] as [number, SimEvent[]])

  it('3 Killing Spree, 5 Rampage, 7 Unstoppable, 10 Godlike, across rounds', () => {
    const a = quick()
    // round changes in between do not end a streak
    const tl = kills(ME, 10, 1)
    tl.splice(4, 0, [tl[3][0] + 0.5, [{ type: 'phase', phase: 'shop', round: 2 }]])
    const streak = run(a, tl).filter((l) => l.kind === 'streak').map((l) => l.line)
    expect(streak).toEqual(['killing_spree', 'rampage', 'unstoppable', 'godlike'])
    expect(a.streakOf(ME)).toBe(10)
  })

  it('dying resets the streak, even to lava with nobody credited', () => {
    const a = quick()
    const tl = [...kills(ME, 2, 1), [12, [death(ME, null)]] as [number, SimEvent[]], ...kills(ME, 4, 20)]
    const streak = run(a, tl).filter((l) => l.kind === 'streak').map((l) => l.line)
    // 2 + 4 kills with a death between: one Killing Spree (at the 3rd after the reset), no Rampage
    expect(streak).toEqual(['killing_spree'])
    expect(a.streakOf(ME)).toBe(4)
  })

  it('your small streaks are yours; Rampage and up are announced to everyone', () => {
    const lines = run(quick(), kills(FOE, 5, 1))
    expect(lines.filter((l) => l.kind === 'streak').map((l) => l.line)).toEqual(['rampage'])
  })
})

describe('announcer: no credit, no line', () => {
  it('deaths without a killer, and self-kills, announce nothing (not even first blood)', () => {
    const lines = run(quick(), [
      [1, [death(ME, null)]],
      [2, [death(FOE, FOE)]],
      [3, [death(OTHER, null), death(ME, ME)]],
    ])
    expect(lines).toEqual([])
  })
})

describe('announcer: one line at a time', () => {
  it('never overlaps two lines and drops lines that would play stale', () => {
    const a = new Announcer()
    a.lineLength = () => 1.0
    // First Blood, Double, Triple + Killing Spree, all within 0.4 s
    const started: { at: number; a: Announcement }[] = []
    const feed = (t: number, ev: SimEvent[]) => {
      const x = a.update(ev, t, ME)
      if (x) started.push({ at: t, a: x })
    }
    feed(1, [death(10, ME)])
    feed(1.2, [death(11, ME)])
    feed(1.4, [death(12, ME)])
    for (let t = 1.45; t < 8; t += 0.05) {
      const x = a.next(t)
      if (x) started.push({ at: t, a: x })
    }
    // each line starts only after the previous one's whole length
    for (let k = 1; k < started.length; k++) expect(started[k].at - started[k - 1].at).toBeGreaterThanOrEqual(1.0)
    // nothing ever plays later than STALE_AFTER after it was earned
    for (const s of started) expect(s.at - s.a.at).toBeLessThanOrEqual(STALE_AFTER + 1e-9)
    // First Blood plays at once; Double (0.95 s old when First Blood ends) still makes it;
    // Triple and Killing Spree (1.9 s old by the time Double ends) are dropped, not played late
    expect(started.map((s) => s.a.line)).toEqual(['first_blood', 'double_kill'])
  })

  it('a burst says its best line only: multi-kill over streak, multi-kill over first blood', () => {
    const a = new Announcer()
    a.lineLength = () => 0.3
    // two earlier kills (first blood + a spaced one), then two at once: Double + Killing Spree
    a.update([death(10, ME)], 1, ME)
    a.update([death(11, ME)], 1 + MULTI_WINDOW + 1, ME)
    const t = 1 + 2 * (MULTI_WINDOW + 1)
    const first = a.update([death(12, ME), death(13, ME)], t, ME)
    const second = a.next(t + 0.5)
    expect(first?.line).toBe('double_kill')
    // the Killing Spree earned in the same tick is not said after it: back-to-back calls are spam
    expect(second).toBeNull()
    const b = new Announcer()
    b.lineLength = () => 0.3
    expect(b.update([death(10, ME), death(11, ME)], 1, ME)?.line).toBe('double_kill')
    expect(b.next(1.5)).toBeNull()
    // a kill earned while a line plays still gets its turn
    expect(b.update([death(12, ME)], 1.2, ME)).toBeNull()
    expect(b.next(1.5)?.line).toBe('triple_kill')
  })

  it('the banner text is the voice line, word for word', () => {
    const a = quick()
    const [first] = run(a, [[1, [death(FOE, ME)]]])
    expect(first.text).toBe(ANNOUNCER_TEXT.first_blood)
    expect(first.text).toBe('First Blood!')
  })
})

// ---------------------------------------------------------------------------
// pack 2: round flow, round / match end, the arena, occasional lines
// ---------------------------------------------------------------------------

const ALLY = 3

function pawnOf(owner: number, over: Partial<PawnState> = {}): PawnState {
  return { id: 100 + owner, owner, x: 0, y: 0, vx: 0, vy: 0, walkVx: 0, walkVy: 0, hp: 1000, maxHp: 1000, alive: true, lavaTicks: 0, ...over } as PawnState
}

/** A small FFA view: players 0..n-1, everyone alive, mid-fight on a big arena. */
function view(n = 2, over: Partial<AnnouncerView> = {}): AnnouncerView {
  const ids = Array.from({ length: n }, (_, i) => i)
  return {
    phase: 'fight',
    phaseTicksLeft: -1,
    round: 1,
    settings: { ...DEFAULT_SETTINGS },
    slots: ids.map((id) => ({ id, name: `P${id}`, color: 0, team: id, kind: 'human' as const })),
    scores: ids.map((id) => ({ id, gold: 0, score: 0, kills: 0, deaths: 0, damageThisRound: 0, spent: 0, masteries: { duration: 0, range: 0, lifesteal: 0 }, connected: true })),
    pawns: ids.map((id) => pawnOf(id)),
    arena: { layer: 15, nextShrinkTick: -1, theme: 0 },
    ...over,
  }
}

const fightStart: SimEvent = { type: 'phase', phase: 'fight', round: 1 }

/** Every line started over a timeline of (time, events, state), draining between steps. */
function play(a: Announcer, steps: [number, SimEvent[], AnnouncerView?][], local: number | null = ME): Announcement[] {
  const out: Announcement[] = []
  let t = 0
  for (const [at, events, state] of steps) {
    for (; t < at - 1e-9; t += 0.05) {
      const x = a.next(t)
      if (x) out.push(x)
    }
    const x = a.update(events, at, local, state)
    if (x) out.push(x)
    t = at
  }
  for (let k = 0; k < 80; k++, t += 0.05) {
    const x = a.next(t)
    if (x) out.push(x)
  }
  return out
}

const lines = (xs: Announcement[]) => xs.map((x) => x.line)

describe('announcer: round flow on the real sim', () => {
  it('calls the round at the 3-2-1 and Fight! on the very tick the fight starts', () => {
    const settings = { ...DEFAULT_SETTINGS, winScore: 3, shopSeconds: 6 }
    const slots = [0, 1].map((id) => ({ id, name: `B${id}`, color: 0, team: id, kind: 'bot' as const, difficulty: 'brutal' as const }))
    const state = createMatch(settings, slots, 4)
    const bots = slots.map((s) => createBot(s.id, 'brutal', 40 + s.id))
    const a = new Announcer()
    const started: { tick: number; line: string; kind: string }[] = []
    const fights: number[] = []
    const countdowns: number[] = []
    for (let i = 0; i < 60 * 900 && state.phase !== 'gameOver'; i++) {
      step(state, bots.map((b) => ({ player: b.player, tick: state.tick, cmds: b.think(state) })))
      if (state.events.some((e) => e.type === 'phase' && e.phase === 'fight')) fights.push(state.tick)
      if (state.phase === 'shop' && state.phaseTicksLeft === COUNTDOWN_SECONDS * TICK_HZ) countdowns.push(state.tick)
      const x = a.update(state.events, state.tick / TICK_HZ, 0, state)
      if (x) started.push({ tick: state.tick, line: x.line, kind: x.kind })
    }
    expect(state.phase).toBe('gameOver')
    const flow = started.filter((s) => s.kind === 'flow')
    // every fight start: Fight! on that exact tick
    expect(fights.length).toBeGreaterThanOrEqual(3)
    for (const f of fights) expect(flow.find((s) => s.tick === f)?.line, `tick ${f}`).toBe('fight')
    // every countdown: the round call on the tick the 3 shows, Round One first
    expect(countdowns).toHaveLength(fights.length)
    const calls = countdowns.map((c) => flow.find((s) => s.tick === c)?.line)
    expect(calls[0]).toBe('round_one')
    for (const c of calls) expect(['round_one', 'round_two', 'round_three', 'round_four', 'round_five', 'match_point', 'final_round']).toContain(c)
    // the match ends with the local player's verdict, and every round with a winner or a draw
    expect([...MATCH_WIN_LINES, ...DEFEAT_LINES]).toContain(flow.at(-1)!.line)
  }, 20_000)
})

describe('announcer: final round vs match point', () => {
  const scored = (scores: number[], over: Partial<AnnouncerView> = {}) => {
    const v = view(scores.length, over)
    v.scores!.forEach((s, i) => (s.score = scores[i]))
    return v
  }

  it('Final Round when everyone is one win away, Match Point when only some are', () => {
    expect(roundCall(scored([4, 4], { round: 8 }))).toBe('final_round')
    expect(roundCall(scored([4, 2], { round: 6 }))).toBe('match_point')
    expect(roundCall(scored([4, 4, 1], { round: 9 }))).toBe('match_point')
    expect(roundCall(scored([3, 3], { round: 6 }))).toBe('round_seven')
  })

  it('teams count as one: a team at match point is the whole team', () => {
    const v = scored([4, 4, 2, 2], { round: 6 })
    v.settings = { ...DEFAULT_SETTINGS, teamMode: 'teams' }
    v.slots!.forEach((s) => (s.team = s.id < 2 ? 0 : 1))
    expect(roundCall(v)).toBe('match_point')
    v.scores!.forEach((s) => (s.score = 4))
    expect(roundCall(v)).toBe('final_round')
  })

  it('ranked follows its schedule: match point when a win would clinch, the last round and the final are final', () => {
    // Why: ranked ends after five scheduled rounds or an early clinch, not at winScore, so the
    // winScore rule called the decisive rounds wrong (a 3-0 lead before round 4 is match point).
    const ranked = (scores: number[], round: number, over: Partial<AnnouncerView> = {}) => {
      const v = scored(scores, { round, ...over })
      v.settings = { ...DEFAULT_SETTINGS, rankedRounds: 5 }
      return v
    }
    expect(roundCall(ranked([0, 0, 0], 0))).toBe('round_one')
    expect(roundCall(ranked([3, 0, 0], 3))).toBe('match_point')
    expect(roundCall(ranked([2, 2, 0], 3))).toBe('round_four')
    expect(roundCall(ranked([2, 1, 1], 4))).toBe('final_round')
    expect(roundCall(ranked([2, 2, 1], 5, { rankedFinal: { contenders: [0, 1] } }))).toBe('final_round')
  })

  it('above round nine only Fight! (no Round N), deathmatch has no match point', () => {
    expect(roundCall(scored([2, 2], { round: 9 }))).toBeNull()
    const dm = scored([4, 0], { round: 0 })
    dm.settings = { ...DEFAULT_SETTINGS, gameMode: 'deathmatch' }
    expect(roundCall(dm)).toBe('round_one')
  })
})

describe('announcer: round and match end', () => {
  const won = (players: number[], team = players[0] ?? TEAM_DRAW): SimEvent => ({ type: 'roundWin', team, players })

  it('a round-win call for the winner only; Draw! for everyone when nobody is left', () => {
    expect(lines(play(quick(), [[1, [won([ME])], view()]]))).toEqual([roundWinLine(view(), ME)])
    expect(lines(play(quick(), [[1, [won([FOE])], view()]]))).toEqual([])
    for (const local of [ME, FOE, -1]) expect(lines(play(quick(), [[1, [won([], TEAM_DRAW)], view()]], local))).toEqual(['draw'])
  })

  it('round wins rotate through every call, so back-to-back wins sound different', () => {
    const winAt = (score: number) => {
      const v = view(2, { settings: { ...DEFAULT_SETTINGS, winScore: 99 } })
      v.scores!.find((sc) => sc.id === ME)!.score = score
      return v
    }
    // the sim adds the point before the event: the first win arrives with score 1
    const heard = ROUND_WIN_LINES.map((_, i) => lines(play(quick(), [[1, [won([ME])], winAt(i + 1)]]))[0])
    expect(new Set(heard).size).toBe(ROUND_WIN_LINES.length)
    // the HUD banner shows the same words as the voice
    expect(heard[0]).toBe(roundWinLine(winAt(1), ME))
    // "Victory!" stays the match's: a round win must not sound like the game is over
    for (const line of ROUND_WIN_LINES) expect(ANNOUNCER_TEXT[line]).not.toMatch(/victor/i)
    expect(ROUND_WIN_LINES.some((line) => (MATCH_WIN_LINES as readonly string[]).includes(line))).toBe(false)
    // nor like the next countdown: "Round Won!" was heard as "Round One!"
    for (const line of ROUND_WIN_LINES) expect(ANNOUNCER_TEXT[line]).not.toMatch(/^round\b/i)
  })

  it('Victory! / Defeat! for players, by team in team modes; spectators hear neither', () => {
    const over = (winners: number[]): SimEvent => ({ type: 'gameOver', winners })
    expect(lines(play(quick(), [[1, [over([ME])]]], ME))).toEqual(['victory'])
    expect(lines(play(quick(), [[1, [over([ME])], view(2, { round: 3 })]], ME))).toEqual(['victorious'])
    expect(lines(play(quick(), [[1, [over([ME])]]], FOE))).toEqual([defeatLine({}, FOE)])
    expect(DEFEAT_LINES).toContain(lines(play(quick(), [[1, [over([ME])], view(2, { round: 4 })]], FOE))[0])
    expect(MATCH_WIN_LINES).toContain(lines(play(quick(), [[1, [over([FOE, ALLY])]]], ALLY))[0])
    expect(lines(play(quick(), [[1, [over([ME])]]], -1))).toEqual([])
    expect(lines(play(quick(), [[1, [over([ME])]]], null))).toEqual([])
  })

  it('defeats vary by match length, and never sound like a win', () => {
    const heard = DEFEAT_LINES.map((_, round) => defeatLine({ round }, FOE))
    expect(new Set(heard).size).toBe(DEFEAT_LINES.length)
    for (const line of DEFEAT_LINES) expect([...MATCH_WIN_LINES, ...ROUND_WIN_LINES] as readonly string[]).not.toContain(line)
  })

  it('the deciding round has no round-win call: its Victory / Defeat follows instead', () => {
    const decided = view(2, { settings: { ...DEFAULT_SETTINGS, winScore: 1 } })
    decided.scores!.find((sc) => sc.id === ME)!.score = 1
    const over: SimEvent = { type: 'gameOver', winners: [ME] }
    expect(lines(play(quick(), [[1, [won([ME])], decided], [4, [over], decided]]))).toEqual([matchWinLine(decided, ME)])
  })

  it('no aside trails a kill line: Hurry Up! earned under a Double Kill is dropped', () => {
    const a = new Announcer()
    a.lineLength = () => 1.0
    const shrink = (layer: number): SimEvent => ({ type: 'arenaShrink', layer })
    // the first shrink goes out on its own, the 9-tile one lands under a multi-kill
    const out = play(a, [[1, [shrink(14)], view(3)], [3, [death(FOE, ME), death(OTHER, ME), shrink(4)], view(3)]])
    expect(lines(out)).toEqual(['arena_shrinks', 'double_kill'])
  })

  it('round end: the last kill keeps its best line, then the round win; asides die with the round', () => {
    const a = new Announcer()
    a.lineLength = () => 1.0
    // the round's last kill: First Blood + Double Kill + a shrink, then the round win in the same tick
    const out = play(a, [[1, [death(FOE, ME), death(OTHER, ME), { type: 'arenaShrink', layer: 14 }, won([ME])], view(3)]])
    expect(lines(out)).toEqual(['double_kill', roundWinLine(view(3), ME)])
    expect(out[1].at).toBe(1) // earned at once, started after the kill line
  })
})

describe('announcer: the arena', () => {
  it('The Arena Shrinks! once per match: repeating it every round got tiresome', () => {
    const shrink: SimEvent = { type: 'arenaShrink', layer: 14 }
    const out = play(quick(), [
      [1, [fightStart], view()],
      [11, [shrink], view()],
      [21, [shrink], view()],
      [40, [fightStart], view()],
      [50, [shrink], view()],
    ], -1)
    expect(lines(out).filter((l) => l === 'arena_shrinks')).toHaveLength(1)
  })

  it('Hurry Up! when a shrink leaves the last few tiles, once per round', () => {
    const shrink = (layer: number): SimEvent => ({ type: 'arenaShrink', layer })
    const out = play(quick(), [
      [1, [fightStart], view()],
      [11, [shrink(6)], view()], // the match's first shrink: The Arena Shrinks!
      [21, [shrink(5)], view()], // 13 tiles left: not yet
      [31, [shrink(4)], view()], // 9 tiles: hurry
      [41, [shrink(3)], view()], // already called this round
      [60, [fightStart], view()],
      [70, [shrink(4)], view()], // a new round may hurry again
    ], -1)
    expect(lines(out).filter((l) => l === 'arena_shrinks' || l === 'hurry_up')).toEqual(['arena_shrinks', 'hurry_up', 'hurry_up'])
  })

  it('a new match calls the first shrink again', () => {
    const shrink: SimEvent = { type: 'arenaShrink', layer: 14 }
    const a = quick()
    play(a, [[1, [fightStart], view()], [11, [shrink], view()]], -1)
    a.reset()
    const out = play(a, [[1, [fightStart], view()], [11, [shrink], view()]], -1)
    expect(lines(out).filter((l) => l === 'arena_shrinks')).toHaveLength(1)
  })
})

describe('announcer: occasional lines', () => {
  /** n kills by `killer` of fresh victims, spaced past the multi-kill window */
  const streak = (killer: number, n: number, from: number, victim0 = 50): [number, SimEvent[], AnnouncerView?][] =>
    Array.from({ length: n }, (_, k) => [from + k * (MULTI_WINDOW + 1), [death(victim0 + k, killer)], view()] as [number, SimEvent[], AnnouncerView])

  it('Shutdown! only when the kill ends a streak of 3+, heard by everyone, credited to the killer', () => {
    const tl = [...streak(FOE, 3, 1), [20, [death(FOE, ME)], view()] as [number, SimEvent[], AnnouncerView]]
    for (const local of [ME, OTHER, -1]) {
      const sd = play(quick(), tl, local).filter((x) => x.line === 'shutdown')
      expect(sd).toHaveLength(1)
      expect(sd[0].player).toBe(ME)
      expect(sd[0].count).toBe(3)
    }
    const short = [...streak(FOE, 2, 1), [20, [death(FOE, ME)], view()] as [number, SimEvent[], AnnouncerView]]
    expect(lines(play(quick(), short))).not.toContain('shutdown')
  })

  it('Revenge! when you kill the player who killed you last, once', () => {
    const out = play(quick(), [
      [1, [death(ME, FOE)], view(3)],
      [5, [death(ME, OTHER)], view(3)], // OTHER is now the last killer
      [10, [death(FOE, ME)], view(3)], // not revenge: FOE is not the last killer
      [15, [death(OTHER, ME)], view(3)], // revenge
      [20, [death(OTHER, ME)], view(3)], // already avenged
    ])
    const rv = out.filter((x) => x.line === 'revenge')
    expect(rv).toHaveLength(1)
    expect(rv[0].at).toBe(15)
    // only the avenger hears it
    expect(lines(play(quick(), [[1, [death(ME, FOE)], view(3)], [5, [death(FOE, ME)], view(3)]], OTHER))).not.toContain('revenge')
  })

  it('Denied! for a threatening lava escape, not for an ordinary blink or healthy lava hop', () => {
    const inLava = view(2, { pawns: [pawnOf(ME, { x: 5000, lavaTicks: 8, hp: 90 }), pawnOf(FOE)] })
    const onGround = view(2, { pawns: [pawnOf(ME, { x: 200 }), pawnOf(FOE)] })
    const tp = (toX: number): SimEvent => ({ type: 'teleport', pawn: 100 + ME, fromX: 0, fromY: 0, toX, toY: 0 })
    expect(lines(play(quick(), [[1, [], inLava], [1.02, [tp(0)], onGround]]))).toEqual(['denied'])
    expect(lines(play(quick(), [[1, [], onGround], [1.02, [tp(0)], onGround]]))).toEqual([])
    const healthyLava = view(2, { pawns: [pawnOf(ME, { x: 5000, lavaTicks: 8 }), pawnOf(FOE)] })
    expect(lines(play(quick(), [[1, [], healthyLava], [1.02, [tp(0)], onGround]]))).toEqual([])
    // somebody else's save is not yours
    expect(lines(play(quick(), [[1, [], inLava], [1.02, [tp(0)], onGround]], FOE))).toEqual([])
    // a cooldown, not a per-round rule: a save soon after is silent, a later one varies the words
    const save = (at: number): [number, SimEvent[], AnnouncerView][] => [[at, [], inLava], [at + 0.02, [tp(0)], onGround]]
    const three = play(quick(), [...save(1), ...save(1 + DENIED_COOLDOWN / 2), ...save(2 + DENIED_COOLDOWN)])
    expect(lines(three)).toEqual(['denied', 'not_today'])
  })

  it('King of the Hill: a capture is called, a step off and back on is not, and losing it to another side is', () => {
    const hill = (team: number | null, prev: number | null, contested = false): SimEvent => ({ type: 'hill', team, contested, prev })
    const out = lines(play(quick(), [
      [1, [hill(ME, null)], view()],
      [2, [hill(null, ME, true)], view()], // contested: not called
      [3, [hill(ME, null)], view()], // back on, still ours: no new capture
      [5, [hill(FOE, null)], view()],
      [30, [hill(ME, FOE)], view()], // retaken after the cooldown: the other capture line
    ]))
    expect(out).toEqual([HILL_CAPTURE_LINES[0], 'hill_lost', HILL_CAPTURE_LINES[1]])
    // a spectator hears none of it
    expect(lines(play(quick(), [[1, [hill(ME, null)], view()]], -1))).toEqual([])
  })

  it('Close Call! once per round, after you are still standing a moment after the hit', () => {
    const hit: SimEvent = { type: 'damage', target: 100 + ME, amount: 300, source: FOE, x: 0, y: 0, kb: 400 }
    const low = view(2, { pawns: [pawnOf(ME, { hp: 60 }), pawnOf(FOE)] })
    const dead = view(2, { pawns: [pawnOf(ME, { hp: 0, alive: false }), pawnOf(FOE)] })
    const out = play(quick(), [
      [1, [fightStart], view()],
      [2, [hit], low],
      [2.5, [], low],
      [3.1, [], low], // confirmed
      [5, [hit], low],
      [6.5, [], low], // second close call this round: no
    ])
    expect(out.filter((x) => x.line === 'close_call').map((x) => x.at)).toEqual([3.1])
    // hit and then burned before the moment passed: no close call
    expect(lines(play(quick(), [[1, [fightStart], view()], [2, [hit], low], [2.5, [], dead], [3.2, [], dead]]))).not.toContain('close_call')
    // a hit that leaves more than 8%: no close call
    const fine = view(2, { pawns: [pawnOf(ME, { hp: 200 }), pawnOf(FOE)] })
    expect(lines(play(quick(), [[2, [hit], fine], [3.2, [], fine]]))).not.toContain('close_call')
  })

  it('Ace! when your team kills a whole enemy team of 2+ in one round', () => {
    const teams = (deadIds: number[]) => {
      const v = view(4, { settings: { ...DEFAULT_SETTINGS, teamMode: 'teams' } })
      // ME (0) and ALLY (3) against FOE (1) and OTHER (2)
      v.slots!.forEach((s) => (s.team = s.id === ME || s.id === ALLY ? 0 : 1))
      v.pawns!.forEach((p) => (p.alive = !deadIds.includes(p.owner)))
      return v
    }
    const out = play(quick(), [
      [1, [fightStart], teams([])],
      [5, [death(FOE, ME)], teams([FOE])],
      [9, [death(OTHER, ALLY)], teams([FOE, OTHER])],
    ])
    expect(lines(out)).toContain('ace')
    // one of them burned with nobody credited: not a wipe by your team
    const burned = play(quick(), [
      [1, [fightStart], teams([])],
      [5, [death(FOE, ME)], teams([FOE])],
      [9, [death(OTHER, null)], teams([FOE, OTHER])],
    ])
    expect(lines(burned)).not.toContain('ace')
  })

  it('at most two occasional lines per round per player; a new round resets the cap', () => {
    // three streaking enemies, each shut down by us in one round, then a fourth next round
    const tl: [number, SimEvent[], AnnouncerView?][] = [
      [0.5, [fightStart], view(8)],
      ...streak(1, 3, 1, 10),
      ...streak(2, 3, 20, 20),
      ...streak(3, 3, 40, 30),
      [60, [death(1, ME)], view(8)],
      [64, [death(2, ME)], view(8)],
      [68, [death(3, ME)], view(8)],
      ...streak(4, 3, 70, 40),
      [90, [fightStart], view(8)],
      [92, [death(4, ME)], view(8)],
    ]
    const sd = play(quick(), tl).filter((x) => x.line === 'shutdown')
    expect(sd.map((x) => x.at)).toEqual([60, 64, 92])
  })
})

describe('announcer: one line at a time, pack 2', () => {
  it('a busy round never overlaps lines; only round flow may play late', () => {
    const a = new Announcer()
    a.lineLength = () => 1.0
    const started: { at: number; a: Announcement }[] = []
    const feed = (t: number, ev: SimEvent[], v?: AnnouncerView) => {
      const x = a.update(ev, t, ME, v)
      if (x) started.push({ at: t, a: x })
    }
    const v = view(4)
    feed(1, [fightStart], v)
    feed(1.1, [death(1, ME)], v)
    feed(1.3, [death(2, ME), { type: 'arenaShrink', layer: 14 }], v)
    feed(1.4, [death(3, ME), { type: 'roundWin', team: ME, players: [ME] }], v)
    for (let t = 1.45; t < 12; t += 0.05) {
      const x = a.next(t)
      if (x) started.push({ at: t, a: x })
    }
    for (let k = 1; k < started.length; k++) expect(started[k].at - started[k - 1].at).toBeGreaterThanOrEqual(1.0)
    for (const s of started) if (s.a.kind !== 'flow') expect(s.at - s.a.at).toBeLessThanOrEqual(STALE_AFTER + 1e-9)
    // the round-flow lines all made it, however long the kill lines held them back
    expect(started.map((s) => s.a.line)).toEqual(expect.arrayContaining(['fight', roundWinLine(v, ME)]))
  })
})
