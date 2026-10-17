import { describe, expect, it } from 'vitest'
import { splitSides } from './TopBar'

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
