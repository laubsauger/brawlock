import { describe, expect, it } from 'vitest'
import { createBot } from '../../bots'
import { DEFAULT_SETTINGS, createMatch, step } from '../../sim'
import { ticks } from '../../sim/config'
import type { Moment, MomentKind, MomentTrait } from '../moments'
import { MomentsEngine } from '../moments'
import { ReplayPlayer } from './player'
import { ReplayRecorder, replayHash } from './recorder'
import { REEL_MOMENT_MAX, ReelPlayer, planReelMoment, selectReel } from './reel'
import { TICK_HZ } from '../../sim/types'

/**
 * The reel shows three different moments, the player's own first, in match order
 * (docs/moonshot/specs/results-reel.md), and never shows anything the recording does not.
 */
let nextId = 0
const m = (score: number, from: number, opts: { actor?: number; victims?: number[]; kind?: MomentKind; traits?: MomentTrait[]; round?: number; count?: number } = {}): Moment => ({
  id: nextId++, kind: opts.kind ?? 'knockout', traits: opts.traits ?? [], round: opts.round ?? 1, tick: from + 15, end: from + 60, from, to: from + 75,
  actors: [opts.actor ?? 1], victims: opts.victims ?? [2], cause: 'fireball', count: opts.count ?? 1, score,
  camera: { subject: 102, other: 101, x: 0, y: 0, dirX: 1, dirY: 0 }, final: true,
})

describe('reel selection', () => {
  it('picks by weighted score with the local player first, never overlapping, in match order', () => {
    const a = m(1.4, 0, { actor: 3, victims: [4] })
    const b = m(1.3, 1000, { actor: 0 }) // local: 1.95
    const c = m(2.0, 30) // overlaps a
    const d = m(1.1, 2000, { actor: 5, victims: [6] })
    const reel = selectReel([a, b, c, d], 0, { excludeDecider: false })
    expect(reel.map((x) => x.id)).toEqual([c.id, b.id, d.id])
  })

  it('a third moment by one player only when nothing else qualifies; nothing under the minimum score', () => {
    const own = [m(3, 0), m(2.9, 1000), m(2.8, 2000)]
    const other = m(1.05, 3000, { actor: 7, victims: [8] })
    expect(selectReel([...own, other], -1, { excludeDecider: false }).map((x) => x.id)).toEqual([own[0].id, own[1].id, other.id])
    expect(selectReel(own, -1, { excludeDecider: false })).toHaveLength(3)
    expect(selectReel([m(0.9, 0), m(0.5, 1000)], -1, { excludeDecider: false })).toEqual([])
  })

  it('leaves the match decider out only after its Final Blow was watched to the end', () => {
    const decider = m(5, 5000, { traits: ['matchDecider', 'roundDecider'] })
    const rest = [m(1.2, 0, { actor: 3 }), m(1.1, 1000, { actor: 4 })]
    expect(selectReel([decider, ...rest], -1, { excludeDecider: false }).map((x) => x.id)).toContain(decider.id)
    expect(selectReel([decider, ...rest], -1, { excludeDecider: true }).map((x) => x.id)).not.toContain(decider.id)
  })
})

describe('reel plans', () => {
  it('every kind shows its instant, inside its window, within the match-time cap', () => {
    const decider = { ...m(1.5, 0, { traits: ['roundDecider'] }), tick: 500, end: 560 }
    const kinds: Moment[] = [
      { ...m(1.5, 400), tick: 415, end: 470 },
      { ...m(1.8, 300, { kind: 'multiKnockout', count: 3 }), tick: 330, end: 300 + ticks(9) },
      { ...m(1.2, 400, { kind: 'denied' }), tick: 440, end: 440 },
      { ...m(2, 300, { kind: 'clutch', count: 2 }), tick: 600, end: 600, to: 630 },
      { ...m(0.8, 400, { kind: 'closeCall' }), tick: 415, end: 415 },
    ]
    for (const k of kinds) {
      const shot = planReelMoment(k, () => decider, false)
      const segs = shot.plan.segments
      expect(segs.length, k.kind).toBeGreaterThan(0)
      for (const s of segs) expect(s.to, k.kind).toBeGreaterThan(s.from)
      for (let i = 1; i < segs.length; i++) expect(segs[i].from, k.kind).toBeGreaterThanOrEqual(segs[i - 1].to)
      const span = segs.reduce((n, s) => n + (s.to - s.from), 0)
      expect(span / TICK_HZ, k.kind).toBeLessThanOrEqual(REEL_MOMENT_MAX + 0.01)
      expect(segs.some((s) => s.from <= shot.plan.hit && shot.plan.hit <= s.to), k.kind).toBe(true)
    }
    const reduced = planReelMoment(kinds[0], () => null, true)
    expect(reduced.plan.segments.every((s) => s.speed === 1)).toBe(true)
  })
})

/** a seeded duel recorded as the match recorder records it, with its moments */
function recordDuel(seed: number) {
  const slots = (['hard', 'brutal'] as const).map((difficulty, id) => ({ id, name: `b${id}`, color: 0, team: id, kind: 'bot' as const, difficulty }))
  const s = createMatch({ ...DEFAULT_SETTINGS, winScore: 2, shopSeconds: 3, arenaCap: 15, shrinkSeconds: 7 }, slots, seed)
  const bots = slots.map((slot) => createBot(slot.id, slot.difficulty, seed * 31 + slot.id))
  const rec = new ReplayRecorder()
  const engine = new MomentsEngine()
  rec.begin({ localPlayer: 0, slots, settings: s.settings, seed })
  const hashes = new Map<number, number>()
  for (let i = 0; i < 30_000 && s.phase !== 'gameOver'; i++) {
    const inputs = bots.flatMap((b) => {
      const cmds = b.think(s)
      return cmds.length ? [{ player: b.player, tick: s.tick, cmds }] : []
    })
    rec.step(s, inputs)
    step(s, inputs)
    rec.observe(s, s.events)
    engine.update(s.events, s)
    hashes.set(s.tick, replayHash(s))
  }
  return { data: rec.finish('reel', 'reel-net', [])!, keyframes: rec.roundKeyframes, moments: engine.all(), hashes }
}

describe('reel player on a recorded duel', () => {
  const duel = recordDuel(51)

  it('seeking from a fight-start keyframe lands on the state forward play reaches', () => {
    expect(duel.keyframes.length).toBeGreaterThan(1)
    const [tick] = duel.keyframes[duel.keyframes.length - 1]
    const target = tick + ticks(2)
    const plain = new ReplayPlayer(duel.data, 'reel-net')
    plain.seek(target)
    const keyed = new ReplayPlayer(duel.data, 'reel-net')
    for (const [t, st] of duel.keyframes) keyed.addKeyframe(t, st)
    keyed.seek(target)
    expect(replayHash(keyed.state)).toBe(replayHash(plain.state))
    expect(replayHash(keyed.state)).toBe(duel.hashes.get(target))
  })

  it('prepares in budgeted slices to each moment, then steps through it; a corrupted hash stops it', () => {
    const reel = new ReelPlayer(duel.data, 'reel-net', duel.keyframes)
    const moment = duel.moments.find((x) => x.kind === 'knockout')!
    let slices = 0
    while (!reel.prepare(moment.from, 2)) slices++
    expect(slices).toBeLessThan(1000)
    expect(reel.curr!.tick).toBe(moment.from)
    const steps = reel.advance(moment.to)
    expect(steps.at(-1)!.tick).toBe(moment.to)
    expect(replayHash(reel.curr!)).toBe(duel.hashes.get(moment.to))
    expect(reel.ok).toBe(true)

    const bad = { ...duel.data, hashes: duel.data.hashes.map(([t, h]) => [t, h + 1] as [number, number]) }
    const broken = new ReelPlayer(bad, 'reel-net', [])
    broken.prepare(moment.to, 1000)
    expect(broken.ok).toBe(false)
  })
})
