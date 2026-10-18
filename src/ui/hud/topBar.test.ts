import { describe, expect, it } from 'vitest'
import { splitSides, roundLabel, roundGoal, finalBrawlInfo } from './TopBar'
import { createMatch, DEFAULT_SETTINGS } from '../../sim'

const p = (id: number, team = id) => ({ id, team })
const ids = (xs: { id: number }[]) => xs.map((x) => x.id)

describe('top row: pills split around the clock', () => {
  it('puts you on the left, nearest the clock, and balances the rest (FFA)', () => {
    const { left, right } = splitSides([p(0), p(1), p(2), p(3), p(4)], 2, false)
    expect(left[left.length - 1].id).toBe(2)
    expect(left.length + right.length).toBe(5)
    expect(Math.abs(left.length - right.length)).toBeLessThanOrEqual(1)
  })

  it('keeps the order stable by slot, so pills never jump when scores change', () => {
    const a = splitSides([p(0), p(1), p(2), p(3)], 0, false)
    const b = splitSides([p(0), p(1), p(2), p(3)], 0, false)
    expect(ids(a.right)).toEqual(ids(b.right))
  })

  it('puts your team on the left with you innermost, the other team on the right (Teams)', () => {
    const players = [p(0, 0), p(1, 1), p(2, 0), p(3, 1), p(4, 0)]
    const { left, right } = splitSides(players, 2, true)
    expect(left.every((x) => x.team === 0)).toBe(true)
    expect(left[left.length - 1].id).toBe(2)
    expect(right.every((x) => x.team === 1)).toBe(true)
  })

  it('spreads a third team to the left so the row stays balanced', () => {
    const players = [p(0, 0), p(1, 1), p(2, 2), p(3, 0), p(4, 1), p(5, 2)]
    const { left, right } = splitSides(players, 0, true)
    expect(new Set(right.map((x) => x.team))).toEqual(new Set([1]))
    expect(new Set(left.map((x) => x.team))).toEqual(new Set([0, 2]))
    expect(left[left.length - 1].id).toBe(0)
  })
})


describe('ranked round presentation', () => {
  const state = () => createMatch({ ...DEFAULT_SETTINGS, rankedRounds: 5 }, [
    { id: 0, name: 'Ash', kind: 'human', team: 0, color: 0xff0000 },
    { id: 1, name: 'Thorn', kind: 'human', team: 1, color: 0x00ff00 },
    { id: 2, name: 'Moss', kind: 'human', team: 2, color: 0x0000ff },
  ], 42)

  it('shows the upcoming scheduled round in shop and the active round in combat', () => {
    const s = state()
    s.round = 3; s.phase = 'shop'
    expect(roundLabel(s)).toBe('Round 4/5')
    s.phase = 'fight'
    expect(roundLabel(s)).toBe('Round 3/5')
    expect(roundGoal(s)).toBe('5 scheduled rounds')
    expect(finalBrawlInfo(s, 0)).toBeNull()
  })

  it('labels final shop and fight identically, lists only contenders, and identifies watchers', () => {
    const s = state()
    s.rankedFinal = { contenders: [0, 2] }
    s.round = 5; s.phase = 'shop'
    expect(roundLabel(s)).toBe('Final brawl')
    expect(roundGoal(s)).toBe('Match decider')
    expect(finalBrawlInfo(s, 0)).toEqual({ names: 'Ash · Moss', watching: false })
    expect(finalBrawlInfo(s, 1)).toEqual({ names: 'Ash · Moss', watching: true })
    s.round = 6; s.phase = 'fight'
    expect(roundLabel(s)).toBe('Final brawl')
    s.slots[2].name = 'Renamed Moss'
    expect(finalBrawlInfo(s, 1)?.names).toBe('Ash · Renamed Moss')
  })

  it('preserves custom score races without a ranked schedule', () => {
    const s = state()
    s.settings.rankedRounds = 0; s.settings.winScore = 7
    s.round = 3; s.phase = 'fight'
    expect(roundLabel(s)).toBe('Round 3')
    expect(roundGoal(s)).toBe('first to 7')
  })
})
