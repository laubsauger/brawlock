import { describe, expect, test } from 'vitest'
import { ARENA_SPAWN_INSET, DEFAULT_SETTINGS, PAWN_RADIUS } from './config'
import { createMatch, isLocationSafeAtLayer, step } from './index'
import { slots } from './testkit'
import type { MatchSettings, SimState } from './types'

/** Safe ground under the pawn and everywhere within 2x its radius: nobody spawns into lava. */
function onSafeGround(s: SimState): void {
  const margin = 2 * PAWN_RADIUS
  for (const p of s.pawns) {
    if (!p.alive) continue
    expect(isLocationSafeAtLayer(s.arena.layer, p.x, p.y), `pawn ${p.owner} at ${p.x.toFixed(0)},${p.y.toFixed(0)} layer ${s.arena.layer}`).toBe(true)
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 2 * Math.PI
      const x = p.x + margin * Math.cos(a)
      const y = p.y + margin * Math.sin(a)
      expect(isLocationSafeAtLayer(s.arena.layer, x, y), `pawn ${p.owner}: lava within ${margin} (${s.phase})`).toBe(true)
    }
  }
}

function noOverlap(s: SimState): void {
  const alive = s.pawns.filter((p) => p.alive)
  for (let i = 0; i < alive.length; i++)
    for (let j = i + 1; j < alive.length; j++)
      expect(Math.hypot(alive[i].x - alive[j].x, alive[i].y - alive[j].y)).toBeGreaterThan(2 * PAWN_RADIUS)
}

const modes: [string, Partial<MatchSettings>, (n: number) => number[] | undefined][] = [
  ['ffa', { teamMode: 'ffa' }, () => undefined],
  ['teams of 2', { teamMode: 'teams' }, (n) => Array.from({ length: n }, (_, i) => Math.floor(i / 2))],
]

describe('every spawn lands on safe ground, 2x the collision radius from the edge', () => {
  for (const [name, settings, teams] of modes) {
    for (let n = 2; n <= 10; n++) {
      test(`${n} players, ${name}: shop and fight spawns`, () => {
        const s = createMatch({ ...DEFAULT_SETTINGS, ...settings, shopSeconds: 1 }, slots(n, teams(n)), n)
        expect(s.phase).toBe('shop')
        onSafeGround(s)
        noOverlap(s)
        while (s.phase !== 'fight') step(s, [])
        onSafeGround(s)
        noOverlap(s)
        // fight spawns are the original formula exactly: (13 + players) * 100 - 600
        for (const p of s.pawns) expect(Math.hypot(p.x, p.y)).toBeCloseTo((13 + n) * 100 - ARENA_SPAWN_INSET, 9)
      })
    }
  }

  test('deathmatch spawns and respawns are safe too', () => {
    const s = createMatch({ ...DEFAULT_SETTINGS, gameMode: 'deathmatch', shopSeconds: 1 }, slots(10), 3)
    onSafeGround(s)
    while (s.phase !== 'fight') step(s, [])
    onSafeGround(s)
  })

  test('the shop overflow the original had: 8 players used to spawn 200 u into the lava', () => {
    // original formula at 8 players: (13 + 8) * 100 - 600 = 1500 > shop platform radius 1300
    const s = createMatch({ ...DEFAULT_SETTINGS }, slots(8), 1)
    expect((13 + 8) * 100 - ARENA_SPAWN_INSET).toBeGreaterThan(1300)
    for (const p of s.pawns) expect(Math.hypot(p.x, p.y)).toBeCloseTo(1000, 9) // capped 300 inside the edge
    expect(s.pawns.every((p) => p.lavaTicks === 0)).toBe(true)
    step(s, [])
    expect(s.pawns.every((p) => p.lavaTicks === 0)).toBe(true)
  })
})
