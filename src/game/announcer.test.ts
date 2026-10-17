import { describe, expect, it } from 'vitest'
import type { SimEvent } from '../sim/types'
import { MULTI_WINDOW } from '../render/overlay/killStamps'
import { ANNOUNCER_TEXT, Announcer, STALE_AFTER, type Announcement } from './announcer'

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

  it('multi-kill goes before streak, streak before first blood, when they queue together', () => {
    const a = new Announcer()
    a.lineLength = () => 0.3
    // two earlier kills (first blood + a spaced one), then two at once: Double + Killing Spree
    a.update([death(10, ME)], 1, ME)
    a.update([death(11, ME)], 1 + MULTI_WINDOW + 1, ME)
    const t = 1 + 2 * (MULTI_WINDOW + 1)
    const first = a.update([death(12, ME), death(13, ME)], t, ME)
    const second = a.next(t + 0.5)
    expect(first?.line).toBe('double_kill')
    expect(second?.line).toBe('killing_spree')
    // and First Blood waits behind a multi-kill earned in the same tick
    const b = new Announcer()
    b.lineLength = () => 0.3
    expect(b.update([death(10, ME), death(11, ME)], 1, ME)?.line).toBe('double_kill')
    expect(b.next(1.5)?.line).toBe('first_blood')
  })

  it('the banner text is the voice line, word for word', () => {
    const a = quick()
    const [first] = run(a, [[1, [death(FOE, ME)]]])
    expect(first.text).toBe(ANNOUNCER_TEXT.first_blood)
    expect(first.text).toBe('First Blood!')
  })
})
