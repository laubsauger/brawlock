import { describe, expect, test } from 'vitest'
import { DEFAULT_SETTINGS } from './config'
import { createMatch, hashState, step } from './index'
import { SPELLS } from './spells/data'
import { IMPLEMENTED_SPELLS } from './spells'
import { grant, slots } from './testkit'
import type { InputCommand, PlayerInput, SimState } from './types'

const COLUMNS = [1, 2, 3, 4, 5, 6].map((c) => Object.values(SPELLS).filter((d) => d.kind === 'spell' && d.column === c).map((d) => d.id))

/** cheap deterministic integer hash for the input script */
function h(a: number, b: number): number {
  let x = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be59b, 0xc2b2ae35)
  x ^= x >>> 13
  x = Math.imul(x, 0x27d4eb2f)
  return (x ^ (x >>> 16)) >>> 0
}

/** Every player owns one spell per column (rotating through all 24) and both active items. */
function loadout(s: SimState, variant: number): void {
  for (const sl of s.slots) {
    COLUMNS.forEach((ids, c) => grant(s, sl.id, ids[(sl.id + variant + c) % ids.length], 1 + ((sl.id + c) % 7)))
    grant(s, sl.id, 'redirector')
    grant(s, sl.id, 'pact')
  }
}

function script(seed: number, tick: number, s: SimState): PlayerInput[] {
  const out: PlayerInput[] = []
  for (const sl of s.slots) {
    const r = h(seed + sl.id, tick)
    const roll = r % 100
    const x = ((r >>> 7) % 2400) - 1200
    const y = ((r >>> 19) % 2400) - 1200
    const cmds: InputCommand[] = []
    if (roll < 8) cmds.push({ kind: 'move', x, y })
    else if (roll < 14) cmds.push({ kind: 'cast', slot: (r >>> 3) % 12, x, y })
    else if (roll === 14) cmds.push({ kind: 'stop' })
    if (cmds.length) out.push({ player: sl.id, tick, cmds })
  }
  return out
}

function run(seed: number, variant: number, ticks: number): SimState {
  const s = createMatch({ ...DEFAULT_SETTINGS, shopSeconds: 2, winScore: 99 }, slots(4), seed)
  loadout(s, variant)
  for (let t = 0; t < ticks; t++) step(s, script(seed, t, s))
  return s
}

function assertFinite(v: unknown, path: string): void {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`non-finite ${v} at ${path}`)
  } else if (Array.isArray(v)) v.forEach((x, i) => assertFinite(x, `${path}[${i}]`))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) assertFinite(x, `${path}.${k}`)
}

describe('all spells: determinism and robustness', () => {
  test('every spell and item has sim behavior', () => {
    for (const id of Object.keys(SPELLS)) expect(IMPLEMENTED_SPELLS.has(id)).toBe(true)
  })

  for (const variant of [0, 1, 2, 3, 4, 5]) {
    test(`4-player brawl with loadout ${variant}: identical hashes on replay, no NaN`, () => {
      const a = run(1000 + variant, variant, 8000)
      const b = run(1000 + variant, variant, 8000)
      expect(hashState(a)).toBe(hashState(b))
      assertFinite(a, 'state')
      // the script really fought: rounds started and warlocks died
      expect(a.round).toBeGreaterThanOrEqual(1)
      expect(a.scores.some((sc) => sc.deaths > 0)).toBe(true)
    })
  }
})
