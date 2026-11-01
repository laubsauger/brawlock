import { describe, expect, it } from 'vitest'
import { ticks } from '../sim/config'
import { fight, pawn, place } from '../sim/testkit'
import type { SimEvent, SimState } from '../sim/types'
import { FinishZoomTracker } from './finishZoom'

/**
 * The finish zoom punches in on a hit that will end the round (docs/moonshot/specs/final-blow.md):
 * the last opponent sliding into lava it cannot get out of, or killed outright. It is for the side
 * that lands it and for onlookers, never for a player whose own warlock is the one in trouble.
 */
const hit = (s: SimState, victim: number, source: number, kb = 900): SimEvent => {
  const p = pawn(s, victim)
  return { type: 'damage', target: p.id, amount: 60, source, x: p.x, y: p.y, kb, cause: 'fireball' }
}
/** victim near the edge, sliding outward fast enough to die in the lava; or at the centre, standing */
const lethalSlide = (s: SimState, victim: number) => {
  const p = pawn(s, victim)
  const edge = 100 * (s.arena.layer - 1)
  place(p, edge - 40, 0)
  p.vx = 1500
  p.hp = 120
}
const harmless = (s: SimState, victim: number) => place(pawn(s, victim), 0, 0)

describe('finish zoom', () => {
  it('fires on a lethal slide of the last opponent, and on a kill, for the side that lands it', () => {
    const s = fight(2)
    lethalSlide(s, 1)
    expect(new FinishZoomTracker().update([hit(s, 1, 0)], s, 0)).toMatchObject([{ victim: pawn(s, 1).id, kind: 'round' }])
    const k = fight(2)
    pawn(k, 1).alive = false
    expect(new FinishZoomTracker().update([hit(k, 1, 0)], k, 0)).toHaveLength(1)
  })

  it('not on a harmless hit, nor while another opponent stands, nor on your own warlock or a teammate', () => {
    const s = fight(2)
    harmless(s, 1)
    expect(new FinishZoomTracker().update([hit(s, 1, 0)], s, 0)).toEqual([])
    const three = fight(3)
    lethalSlide(three, 1)
    expect(new FinishZoomTracker().update([hit(three, 1, 0)], three, 0)).toEqual([])
    const mine = fight(2)
    lethalSlide(mine, 0)
    expect(new FinishZoomTracker().update([hit(mine, 0, 1)], mine, 0)).toEqual([])
    // 2v1: my teammate is the last of ours, I am out; still not a zoom on my own side's warlock while one of us stands
    const teams = fight(3, [0, 0, 1])
    pawn(teams, 0).alive = false
    lethalSlide(teams, 1)
    expect(new FinishZoomTracker().update([hit(teams, 1, 2)], teams, 0)).toEqual([])
  })

  it('spectators and eliminated players get any deciding hit', () => {
    const s = fight(3)
    pawn(s, 2).alive = false
    lethalSlide(s, 1)
    expect(new FinishZoomTracker().update([hit(s, 1, 0)], s, 2)).toHaveLength(1)
    expect(new FinishZoomTracker().update([hit(s, 1, 0)], s, -1)).toHaveLength(1)
  })

  it('is a match zoom when this round decides the match', () => {
    const s = fight(2, undefined, { winScore: 1 })
    lethalSlide(s, 1)
    expect(new FinishZoomTracker().update([hit(s, 1, 0)], s, 0)[0].kind).toBe('match')
  })

  it('a victim zooms once per 2 s, twice a round at most, and not with the setting off', () => {
    const s = fight(2)
    lethalSlide(s, 1)
    const z = new FinishZoomTracker()
    const at = (dt: number) => {
      s.tick += dt
      return z.update([hit(s, 1, 0)], s, 0).length
    }
    expect([at(1), at(ticks(1)), at(ticks(1.5)), at(ticks(2.5))]).toEqual([1, 0, 1, 0])
    const off = new FinishZoomTracker()
    off.enabled = false
    expect(off.update([hit(s, 1, 0)], s, 0)).toEqual([])
  })
})
