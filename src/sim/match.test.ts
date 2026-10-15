import { describe, expect, test } from 'vitest'
import { createMatch, step, cloneState, hashState } from './index'
import { DEFAULT_SETTINGS } from './config'
import { cmd, newMatch, pawn, run, runUntil, slots } from './testkit'
import type { InputCommand, Phase, PlayerInput, SimEvent, SimState } from './types'

const phases = (events: SimEvent[]): Phase[] => events.flatMap((e) => (e.type === 'phase' ? [e.phase] : []))

/** Player 1 walks off the platform every fight; player 0 holds the centre. */
function loserWalksIntoLava(s: SimState): PlayerInput[] {
  if (s.phase !== 'fight') return []
  return [cmd(0, { kind: 'move', x: 0, y: 0 }), cmd(1, { kind: 'move', x: -4000, y: 0 })]
}

describe('rounds mode (systems.md §7.2)', () => {
  test('shop -> fight -> roundEnd -> shop, with spawn layout, arena size, score and gold', () => {
    const s = newMatch()
    expect(s.phase).toBe('shop')
    expect(s.arena.layer).toBe(14)
    expect(s.phaseTicksLeft).toBe(30 * 60)
    // 1v1 spawn: radius (13 + 2) * 100 - 600 = 900, opposite sides, facing the centre
    expect(pawn(s, 0).x).toBeCloseTo(900, 9)
    expect(pawn(s, 1).x).toBeCloseTo(-900, 9)

    const shop = run(s, 30 * 60)
    expect(phases(shop)).toEqual(['fight'])
    expect(s.round).toBe(1)
    expect(s.arena.layer).toBe(15) // 13 + 2 players
    expect(pawn(s, 0).invulnerable).toBe(true)
    run(s, 120)
    expect(pawn(s, 0).invulnerable).toBe(false)

    const fight: SimEvent[] = []
    while (s.phase === 'fight') {
      step(s, loserWalksIntoLava(s))
      fight.push(...s.events)
    }
    expect(fight.find((e) => e.type === 'roundWin')).toEqual({ type: 'roundWin', team: 0, players: [0] })
    expect(s.phase).toBe('roundEnd')
    expect(s.scores.map((x) => x.score)).toEqual([1, 0])
    expect(s.scores[0].gold).toBe(30) // round gold arrives at round end

    const end = run(s, 120)
    expect(phases(end)).toEqual(['shop'])
    expect(s.scores.map((x) => x.gold)).toEqual([40, 40])
    expect(s.arena.layer).toBe(14)
    expect(pawn(s, 1).alive).toBe(true) // respawned for the shop phase
    expect(pawn(s, 1).hp).toBe(1000)
  })

  test('garbage lobby numbers fall back to defaults instead of stalling the phase timer', () => {
    const s = newMatch({ shopSeconds: NaN, lavaDps: -5, friction: Infinity })
    expect(s.settings.shopSeconds).toBe(30)
    expect(s.settings.lavaDps).toBe(100)
    expect(s.settings.friction).toBe(0.96)
    run(s, 30 * 60)
    expect(s.phase).toBe('fight')
  })

  test('the arena shrinks one layer every 10 s of fighting', () => {
    const s = newMatch({ shopSeconds: 0 })
    runUntil(s, (st) => st.phase === 'fight')
    const events = run(s, 600 * 3)
    const shrinks = events.filter((e) => e.type === 'arenaShrink')
    expect(shrinks).toEqual([
      { type: 'arenaShrink', layer: 14 },
      { type: 'arenaShrink', layer: 13 },
      { type: 'arenaShrink', layer: 12 },
    ])
  })

  test('idle players are eventually burned by the shrinking arena; the first to die loses', () => {
    const s = newMatch({ shopSeconds: 0 })
    runUntil(s, (st) => st.phase === 'fight')
    const events = runUntil(s, (st) => st.phase === 'roundEnd')
    // both stand at radius 900 and fall in together at layer 10; deaths after the round is
    // decided are cancelled (combat ends at once), so exactly one dies
    expect(events.filter((e) => e.type === 'death')).toHaveLength(1)
    expect(events.find((e) => e.type === 'roundWin')).toBeDefined()
  })

  test('a bot-free headless match runs to gameOver with the default rules (first to 11)', () => {
    const s = createMatch(DEFAULT_SETTINGS, slots(2), 7)
    const all: SimEvent[] = []
    for (let i = 0; i < 200000 && s.phase !== 'gameOver'; i++) {
      step(s, loserWalksIntoLava(s))
      all.push(...s.events.filter((e) => e.type === 'gameOver' || e.type === 'roundWin'))
    }
    expect(s.phase).toBe('gameOver')
    expect(s.round).toBe(11)
    expect(s.scores.map((x) => x.score)).toEqual([11, 0])
    expect(all.filter((e) => e.type === 'roundWin')).toHaveLength(11)
    expect(all.at(-1)).toEqual({ type: 'gameOver', winners: [0] })
    expect(s.scores[0].gold).toBe(30 + 11 * 10)
    // after game over nothing advances
    const t = s.tick
    run(s, 10, () => [cmd(0, { kind: 'move', x: 500, y: 0 })])
    expect(s.phase).toBe('gameOver')
    expect(s.tick).toBe(t + 10)
    expect(pawn(s, 0).moveTarget).toBeNull()
  })

  test('FFA no-draw rule: a shared top score keeps the match going', () => {
    const s = newMatch({ shopSeconds: 0, winScore: 1 }, 3)
    runUntil(s, (st) => st.phase === 'fight')
    s.scores[1].score = 1 // player 1 already won a round
    // players 1 and 2 walk off the platform, player 0 wins this round -> scores 1, 1, 0
    const out = (p: number) => cmd(p, { kind: 'move', x: pawn(s, p).x * 4, y: pawn(s, p).y * 4 })
    while (s.phase === 'fight') step(s, [out(1), out(2)])
    runUntil(s, (st) => st.phase !== 'roundEnd')
    expect(s.scores.map((x) => x.score)).toEqual([1, 1, 0])
    expect(s.phase).toBe('shop') // tied at winScore: play on until one leads
  })
})

describe('arena pillars (systems.md §7.2)', () => {
  test('2-8 pillars of the theme’s radii in [-1000, 1000]^2, re-rolled every shop phase', () => {
    const s = createMatch({ ...DEFAULT_SETTINGS, shopSeconds: 1 }, slots(2), 3)
    const RADII = [[60], [70, 45, 60, 40], [50, 35]]
    const sets: string[] = []
    for (let round = 0; round < 6; round++) {
      expect(s.phase).toBe('shop')
      expect(s.obstacles.length).toBeGreaterThanOrEqual(2)
      expect(s.obstacles.length).toBeLessThanOrEqual(8)
      for (const o of s.obstacles) {
        expect(Math.abs(o.x)).toBeLessThanOrEqual(1000)
        expect(Math.abs(o.y)).toBeLessThanOrEqual(1000)
        expect(o.hp).toBe(400)
        expect(RADII[s.arena.theme]).toContain(o.radius)
      }
      sets.push(s.obstacles.map((o) => `${o.x.toFixed(1)},${o.y.toFixed(1)}`).join(';'))
      // play the round out: player 1 walks into the lava
      runUntil(s, (st) => st.phase === 'fight')
      while (s.phase !== 'shop') step(s, s.phase === 'fight' ? [cmd(1, { kind: 'move', x: -4000, y: 0 })] : [])
    }
    expect(new Set(sets).size).toBe(sets.length) // a new layout every shop phase
  })

  test('Rockpillars vanish at round start; arena pillars stay for the round', () => {
    const s = createMatch({ ...DEFAULT_SETTINGS, shopSeconds: 1 }, slots(2), 3)
    const arena = s.obstacles.length
    s.obstacles.push({ id: s.nextEntityId++, x: 0, y: 1500, radius: 90, hp: 400, variant: -1, ticksLeft: 9999, owner: 0 })
    runUntil(s, (st) => st.phase === 'fight')
    expect(s.obstacles.length).toBe(arena)
    expect(s.obstacles.every((o) => o.variant !== -1)).toBe(true)
  })
})

describe('teams', () => {
  test('teams mode: allies share the round win and spawn side by side', () => {
    const s = newMatch({ teamMode: 'teams', shopSeconds: 0 }, 4, 1, [1, 1, 2, 2])
    runUntil(s, (st) => st.phase === 'fight')
    expect(s.arena.layer).toBe(17) // 13 + 4 players
    // team 1 at angle 0 with +-0.1 rad offsets, team 2 at pi
    const radius = (13 + 4) * 100 - 600
    expect(pawn(s, 0).x).toBeCloseTo(radius * Math.cos(-0.1), 9)
    expect(pawn(s, 1).y).toBeCloseTo(radius * Math.sin(0.1), 9)
    expect(pawn(s, 2).x).toBeLessThan(0)
    for (const p of [2, 3]) pawn(s, p).x = -3000
    const events = runUntil(s, (st) => st.phase === 'roundEnd')
    expect(events.find((e) => e.type === 'roundWin')).toEqual({ type: 'roundWin', team: 1, players: [0, 1] })
    expect(s.scores.map((x) => x.score)).toEqual([1, 1, 0, 0])
  })

  test('shuffle with 4 players deals 2v2 (team count among divisors, excluding FFA)', () => {
    const s = newMatch({ teamMode: 'shuffle', shopSeconds: 0 }, 4, 99)
    runUntil(s, (st) => st.phase === 'fight')
    const teams = s.slots.map((x) => x.team)
    expect(new Set(teams).size).toBe(2)
    expect(teams.filter((t) => t === teams[0])).toHaveLength(2)
  })

  test('a leaver without bot takeover dies without credit and no longer counts', async () => {
    const { setPlayerConnected } = await import('./index')
    const s = newMatch({ botsReplaceLeavers: false, shopSeconds: 0 }, 3)
    runUntil(s, (st) => st.phase === 'fight')
    setPlayerConnected(s, 2, false)
    step(s, [])
    expect(s.events).toContainEqual({ type: 'death', pawn: pawn(s, 2).id, owner: 2, killer: null })
    expect(s.phase).toBe('fight') // two players still alive
  })
})

// ---------------------------------------------------------------------------
// Determinism: host and clients must agree bit-for-bit given the same seed and inputs.
// ---------------------------------------------------------------------------

function scriptedInputs(seed: number, tick: number): PlayerInput[] {
  // cheap integer hash so inputs are varied but reproducible
  let h = Math.imul(seed ^ tick, 0x9e3779b1) >>> 0
  h ^= h >>> 15
  const out: PlayerInput[] = []
  for (const player of [0, 1]) {
    h = Math.imul(h ^ (player + 1), 0x85ebca6b) >>> 0
    const r = h % 97
    const x = ((h >>> 8) % 2400) - 1200
    const y = ((h >>> 20) % 2400) - 1200
    const cmds: InputCommand[] = []
    if (r < 6) cmds.push({ kind: 'move', x, y })
    else if (r < 8) cmds.push({ kind: 'cast', slot: 6, x, y })
    else if (r < 9) cmds.push({ kind: 'cast', slot: 7, x, y })
    else if (r < 10) cmds.push({ kind: 'cast', slot: 1, x, y })
    else if (r < 11) cmds.push({ kind: 'stop' })
    else if (r === 11) cmds.push({ kind: 'buySpell', spell: 'teleport' })
    if (cmds.length) out.push({ player, tick, cmds })
  }
  return out
}

function simulate(seed: number, ticks: number, inputs: (t: number) => PlayerInput[]): SimState {
  const s = createMatch({ ...DEFAULT_SETTINGS, shopSeconds: 5 }, slots(2), seed)
  for (let t = 0; t < ticks; t++) step(s, inputs(t))
  return s
}

describe('determinism', () => {
  test('same seed and inputs give identical state hashes after 5000 ticks', () => {
    const a = simulate(1234, 5000, (t) => scriptedInputs(5, t))
    const b = simulate(1234, 5000, (t) => scriptedInputs(5, t))
    expect(hashState(a)).toBe(hashState(b))
    // the script actually exercised the game: fights, casts and damage happened
    expect(a.round).toBeGreaterThan(0)
    expect(a.scores.some((x) => x.deaths > 0) || a.pawns.some((p) => p.hp < 1000)).toBe(true)
  })

  test('different inputs diverge', () => {
    const a = simulate(1234, 5000, (t) => scriptedInputs(5, t))
    const b = simulate(1234, 5000, (t) => scriptedInputs(6, t))
    expect(hashState(a)).not.toBe(hashState(b))
  })

  test('input order inside a tick does not matter (sorted by player id)', () => {
    const fwd = simulate(9, 600, (t) => scriptedInputs(3, t))
    const rev = simulate(9, 600, (t) => scriptedInputs(3, t).reverse())
    expect(hashState(fwd)).toBe(hashState(rev))
  })

  test('a cloned state continues identically (snapshot / rollback safety)', () => {
    const a = simulate(77, 2000, (t) => scriptedInputs(1, t))
    const b = cloneState(a)
    expect(hashState(b)).toBe(hashState(a))
    for (let t = 2000; t < 3000; t++) {
      step(a, scriptedInputs(1, t))
      step(b, scriptedInputs(1, t))
    }
    expect(hashState(b)).toBe(hashState(a))
    expect(b).not.toBe(a)
  })

  test('state survives a JSON round trip (network snapshot) with the same hash', () => {
    const a = simulate(3, 1500, (t) => scriptedInputs(2, t))
    const b = JSON.parse(JSON.stringify(a)) as SimState
    expect(hashState(b)).toBe(hashState(a))
  })
})
