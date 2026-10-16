import { describe, expect, it } from 'vitest'
import { LivePool } from './livePool'

interface Rec {
  born: number
  life: number
  kind: string
}

const mk = () => new LivePool<Rec>(24, () => ({ born: -10, life: 0, kind: '' }), (a, b) => a.born < b.born)

function add(p: LivePool<Rec>, born: number, life: number, kind: string): Rec {
  const r = p.acquire()
  r.born = born
  r.life = life
  r.kind = kind
  return r
}

describe('LivePool', () => {
  // Why: the Lightning beam handler adds the main bolt and then three fray arcs in the same
  // event. After earlier effects expired, compaction must not leave aliased slots behind, or
  // the arcs overwrite the main bolt and a missed Lightning shows no bolt at all (P0 playtest).
  it('a record added after a sweep survives the records added right after it', () => {
    const p = mk()
    // two short arcs and a longer bolt from an earlier cast
    add(p, 0, 0.1, 'arc')
    add(p, 0, 0.1, 'arc')
    add(p, 0, 0.5, 'bolt')
    p.sweep((r) => 0.2 - r.born <= r.life) // the arcs expire, the bolt lives on
    p.sweep((r) => 0.6 - r.born <= r.life) // then the bolt expires too
    // the miss: main bolt, then three fray arcs in the same event
    const main = add(p, 0.7, 0.55, 'main')
    for (let i = 0; i < 3; i++) add(p, 0.7, 0.2, 'fray')
    expect(main.kind).toBe('main')
    const live = p.items.slice(0, p.n)
    expect(live.filter((r) => r.kind === 'main')).toHaveLength(1)
    expect(live.filter((r) => r.kind === 'fray')).toHaveLength(3)
    expect(new Set(live).size).toBe(live.length)
  })

  it('every slot holds a distinct object after any sequence of sweeps', () => {
    const p = mk()
    let t = 0
    for (let step = 0; step < 200; step++) {
      t += 0.05
      for (let k = 0; k < (step % 5) + 1; k++) add(p, t, 0.1 + (k % 3) * 0.2, 'x')
      p.sweep((r) => t - r.born <= r.life)
      expect(new Set(p.items).size).toBe(p.items.length)
    }
  })

  it('replaces the oldest live record when full instead of growing', () => {
    const p = new LivePool<Rec>(3, () => ({ born: -10, life: 0, kind: '' }), (a, b) => a.born < b.born)
    add(p, 1, 9, 'a')
    add(p, 2, 9, 'b')
    add(p, 3, 9, 'c')
    const d = add(p, 4, 9, 'd')
    expect(p.n).toBe(3)
    expect(p.items.map((r) => r.kind).sort()).toEqual(['b', 'c', 'd'])
    expect(d.born).toBe(4)
  })
})
