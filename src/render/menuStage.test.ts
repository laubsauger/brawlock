import { describe, expect, it } from 'vitest'
import { hashState, isLocationSafeAtLayer } from '../sim'
import { secondsOf, ticks } from '../sim/config'
import type { SimEvent, SimState } from '../sim/types'
import { createMenuBattle, createMenuStage, createMenuTableau, MENU_LAYER } from './menuStage'

describe('menu battle', () => {
  it('shows moving strong bots, varied real attacks and eliminations, then starts a fresh match on a forward timeline', () => {
    // first to one round win: a menu match to three runs about 40 simulated minutes
    const stage = createMenuBattle(41, 1)
    const spells = new Set<string>()
    let moving = 0
    let damage = 0
    let deaths = 0
    let rounds = 0
    let steps = 0
    let previousTick = 0
    let fresh: SimState | null = null
    // until the first round is won and the next match starts: how long eight bots take to
    // eliminate seven depends on the seed and the bots' builds (164-181 s across seeds), so no
    // fixed window
    for (let i = 0; i < ticks(3600) && !fresh; i++) {
      const { state, events } = stage.step()
      if (i === 0) {
        expect(state.phase).toBe('fight')
        expect(state.slots.every((slot) => slot.kind === 'bot' && ['brutal', 'uber'].includes(slot.difficulty!))).toBe(true)
      }
      if (state.tick <= previousTick) throw new Error('Menu render timeline reversed')
      // a fresh match skips its opening shop and approach, so the timeline jumps forward
      if (previousTick && state.tick - previousTick > 1) fresh = state
      previousTick = state.tick
      if (rounds) continue
      steps++
      if (state.pawns.some((pawn) => Math.hypot(pawn.walkVx, pawn.walkVy) > 20)) moving++
      for (const event of events) {
        if (event.type === 'cast') spells.add(event.spell)
        if (event.type === 'damage') damage++
        if (event.type === 'death') deaths++
        if (event.type === 'roundWin') rounds++
      }
    }
    expect(spells.size).toBeGreaterThanOrEqual(10)
    expect(damage).toBeGreaterThan(100)
    expect(deaths).toBeGreaterThanOrEqual(7)
    expect(rounds).toBe(1)
    expect(moving / steps).toBeGreaterThan(0.85)
    expect(fresh).not.toBeNull()
    expect(fresh!.phase).not.toBe('gameOver')
    expect(fresh!.scores.every((s) => s.score === 0)).toBe(true)
  })

  it('keeps independent seeded battles and snapshots detached from callers', () => {
    const a = createMenuBattle(13)
    const b = createMenuBattle(13)
    const retained = a.step()
    b.step()
    const original = JSON.stringify(retained)
    for (let i = 0; i < 60; i++) { a.step(); b.step() }
    expect(JSON.stringify(retained)).toBe(original)
    retained.state.pawns[0].x = 99999
    retained.state.pawns[0].slots.fill(null)
    retained.events.length = 0
    expect(a.step()).toEqual(b.step())
    expect(a.focus).toEqual(b.focus)
  })
})

function watch(seconds: number, theme = 0, seed = 41) {
  const stage = createMenuStage(theme, seed)
  const events: { tick: number; event: SimEvent }[] = []
  let last: SimState | null = null
  let activeTicks = 0
  let maxProjectiles = 0
  // per-tick invariants as plain checks: an expect per tick and pawn costs more than the stage
  const broken: string[] = []
  const check = (ok: boolean, what: string) => { if (!ok && broken.length < 5) broken.push(`${what} at tick ${last!.tick}`) }
  for (let tick = 0; tick < ticks(seconds); tick++) {
    const frame = stage.step()
    last = frame.state
    for (const event of frame.events) events.push({ tick: last.tick, event })
    if (last.projectiles.length || last.pawns.some((pawn) => pawn.cast)) activeTicks++
    maxProjectiles = Math.max(maxProjectiles, last.projectiles.length)
    check(last.pawns.length === 2 && last.obstacles.length === 2, 'two pawns and two ruins')
    check(last.arena.layer === MENU_LAYER && last.arena.nextShrinkTick === -1 && last.arena.theme === theme, 'fixed arena')
    for (const pawn of last.pawns) {
      check(pawn.alive, `pawn ${pawn.id} alive`)
      check(isLocationSafeAtLayer(MENU_LAYER, pawn.x, pawn.y), `pawn ${pawn.id} on the floor`)
      check(Math.hypot(pawn.x - stage.focus.x, pawn.y - stage.focus.y) < 430, `pawn ${pawn.id} in frame`)
      check(pawn.modifiers.every((modifier) => modifier.id === 'shield'), `pawn ${pawn.id} only shielded`)
    }
    for (const event of frame.events) if (event.type === 'cast' && event.spell === 'fireball') {
      const caster = last.pawns.find((pawn) => pawn.id === event.pawn)!
      const rival = last.pawns.find((pawn) => pawn.owner !== caster.owner)!
      check(Math.hypot(event.x - rival.x, event.y - rival.y) < 35, 'Fireball aimed at the rival')
    }
  }
  expect(broken).toEqual([])
  return { last: last!, events, activeTicks, maxProjectiles }
}

describe('menu sparring stage', () => {
  it('aims alternating real attacks at the rival with quiet recovery between shots', () => {
    const result = watch(32)
    const shots = result.events.filter(({ event }) => event.type === 'cast' && event.spell === 'fireball')
    expect(shots).toHaveLength(8)
    for (let index = 1; index < shots.length; index++) {
      expect(shots[index].tick - shots[index - 1].tick).toBeGreaterThanOrEqual(ticks(4) - ticks(1 / 30))
      expect(shots[index].tick - shots[index - 1].tick).toBeLessThanOrEqual(ticks(4) + ticks(1 / 30))
      expect((shots[index].event as Extract<SimEvent, { type: 'cast' }>).pawn)
        .not.toBe((shots[index - 1].event as Extract<SimEvent, { type: 'cast' }>).pawn)
    }
    const victims = new Set(result.events.flatMap(({ event }) => event.type === 'damage' ? [event.target] : []))
    expect(victims.size).toBe(2)
    expect(result.activeTicks / ticks(32)).toBeLessThan(0.5)
  })

  it('really reflects a shot back into its caster and evades shots by walking and Teleport', () => {
    const { events } = watch(22)
    const reflect = events.find(({ event }) => event.type === 'shieldReflect')!
    expect(reflect.event).toMatchObject({ reflected: true, stolen: true })
    expect(events.some(({ tick, event }) => tick > reflect.tick && tick < reflect.tick + ticks(1)
      && event.type === 'damage' && event.source === 0 && event.target === 2)).toBe(true)
    // Third shot: the defender walks inward after the shot is launched, clearing its path.
    expect(events.some(({ tick, event }) => tick >= ticks(10) && tick < ticks(12.17) && event.type === 'damage')).toBe(false)
    const walking = createMenuStage(0, 41)
    let beforeWalk = { x: 0, y: 0 }
    let afterWalk = { x: 0, y: 0 }
    for (let tick = 1; tick <= ticks(12); tick++) {
      const pawn = walking.step().state.pawns[1]
      if (tick === ticks(10)) beforeWalk = { x: pawn.x, y: pawn.y }
      if (tick === ticks(12)) afterWalk = { x: pawn.x, y: pawn.y }
    }
    expect(Math.hypot(afterWalk.x - beforeWalk.x, afterWalk.y - beforeWalk.y)).toBeGreaterThan(150)
    const teleport = events.find(({ event }) => event.type === 'teleport')!
    expect(teleport.event).toBeDefined()
    if (teleport.event.type === 'teleport') {
      expect(Math.hypot(teleport.event.toX - teleport.event.fromX, teleport.event.toY - teleport.event.fromY)).toBeCloseTo(180, 0)
    }
    expect(events.some(({ tick, event }) => tick >= ticks(18) && tick < ticks(20.17) && event.type === 'damage')).toBe(false)
    expect(events.some(({ event }) => event.type === 'death')).toBe(false)
  })

  it.each([0, 1, 2])('keeps theme %i safe and bounded for ninety seconds', (theme) => {
    const { last, events, maxProjectiles, activeTicks } = watch(90, theme)
    const count = (type: SimEvent['type'], spell?: string) =>
      events.filter(({ event }) => event.type === type && (!spell || (event.type === 'cast' && event.spell === spell))).length
    expect(maxProjectiles).toBe(1)
    expect(last.scores).toHaveLength(2)
    expect(events.some(({ event }) => event.type === 'death' || event.type === 'arenaShrink' || event.type === 'roundWin')).toBe(false)
    expect(count('cast', 'fireball')).toBeGreaterThanOrEqual(8)
    // every scripted answer really happens: each shield reflects, each Teleport lands
    expect(count('cast', 'shield')).toBeGreaterThan(0)
    expect(count('shieldReflect')).toBe(count('cast', 'shield'))
    expect(count('cast', 'teleport')).toBeGreaterThan(0)
    expect(count('teleport')).toBe(count('cast', 'teleport'))
    expect(activeTicks / ticks(90)).toBeLessThan(0.5)
  })

  it('is deterministic and never mutates emitted snapshots or retains caller mutations', () => {
    const stage = createMenuStage(1, 19)
    const first = stage.step()
    const original = JSON.stringify(first)
    for (let tick = 0; tick < ticks(7.5); tick++) stage.step()
    expect(JSON.stringify(first)).toBe(original)
    first.state.pawns[0].x = 99999
    first.state.pawns[0].slots.fill(null)
    first.state.settings.dmgMultiplier = 1000
    const next = stage.step()
    expect(next.state.pawns[0].x).not.toBe(99999)
    expect(next.state.pawns[0].slots[0]).toBe('fireball')
    expect(next.state.settings.dmgMultiplier).toBe(0.35)
    expect(hashState(watch(35, 1, 19).last)).toBe(hashState(watch(35, 1, 19).last))
  })
})


describe('menu coven rehearsal', () => {
  // All ten release once per 31-second phrase. Ninety seconds once; the other themes only move
  // the ruins, so one phrase shows every lane clear of them.
  it.each([[0, 90], [1, 31], [2, 31]])('completes every cast with a safe visible flight and landing in theme %i over %i seconds', (theme, seconds) => {
    const stage = createMenuTableau(theme, 41)
    const started = new Map<number, { tick: number; duration: number }>()
    const flights = new Map<number, { x: number; y: number; distance: number }>()
    const performers = new Set<number>()
    let releases = 0
    let landings = 0
    let quietTicks = 0
    let peakActive = 0
    const segmentDistance = (point: { x: number; y: number }, from: { x: number; y: number }, to: { x: number; y: number }) => {
      const dx = to.x - from.x
      const dy = to.y - from.y
      const t = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / (dx * dx + dy * dy)))
      return Math.hypot(point.x - from.x - t * dx, point.y - from.y - t * dy)
    }
    // per-tick invariants as plain checks: an expect per tick and pawn costs more than the stage
    const broken: string[] = []
    for (let tick = 0; tick < ticks(seconds); tick++) {
      const { state, events } = stage.step()
      const check = (ok: boolean, what: string) => { if (!ok && broken.length < 5) broken.push(`${what} at tick ${state.tick}`) }
      check(state.pawns.length === 10 && state.phase === 'fight', 'ten performers in a fight')
      check(state.arena.layer === MENU_LAYER && state.arena.nextShrinkTick === -1 && state.arena.theme === theme, 'fixed arena')
      const active = state.projectiles.length + state.pawns.filter((pawn) => pawn.cast).length
      peakActive = Math.max(peakActive, active)
      if (active === 0) quietTicks++
      for (const pawn of state.pawns) {
        check(pawn.alive && pawn.hp === pawn.maxHp, `pawn ${pawn.id} alive and unhurt`)
        check(isLocationSafeAtLayer(MENU_LAYER, pawn.x, pawn.y), `pawn ${pawn.id} on the floor`)
      }
      for (const event of events) {
        expect(['castCancel', 'damage', 'death', 'arenaShrink', 'roundWin']).not.toContain(event.type)
        if (event.type === 'castStart') {
          expect(started.has(event.pawn)).toBe(false)
          started.set(event.pawn, { tick: state.tick, duration: event.ticks })
        } else if (event.type === 'cast') {
          const start = started.get(event.pawn)!
          expect(state.tick - start.tick).toBe(start.duration)
          expect(secondsOf(start.duration)).toBeGreaterThanOrEqual(0.6)
          expect(secondsOf(start.duration)).toBeLessThanOrEqual(0.8)
          started.delete(event.pawn)
          performers.add(event.pawn)
          releases++
          const caster = state.pawns.find((pawn) => pawn.id === event.pawn)!
          const projectile = state.projectiles.find((p) => p.owner === caster.owner)!
          expect(projectile).toBeDefined()
          expect(events.some((e) => e.type === 'projectileSpawn' && e.id === projectile.id)).toBe(true)
          const distance = Math.hypot(event.x - projectile.x, event.y - projectile.y)
          expect(distance).toBeGreaterThan(450)
          flights.set(projectile.id, { x: event.x, y: event.y, distance })
          // A complete clear lane, rather than a shot into another model or scenery.
          for (const pawn of state.pawns) if (pawn !== caster) {
            expect(segmentDistance(pawn, caster, event)).toBeGreaterThan(90)
          }
          for (const obstacle of state.obstacles) {
            expect(segmentDistance(obstacle, caster, event)).toBeGreaterThan(obstacle.radius + 30)
          }
        } else if (event.type === 'projectileHit') {
          const flight = flights.get(event.id)!
          expect(flight).toBeDefined()
          expect(event.target).toBeNull()
          expect(Math.hypot(event.x - flight.x, event.y - flight.y)).toBeLessThan(0.00001)
          expect(isLocationSafeAtLayer(MENU_LAYER, event.x, event.y)).toBe(true)
          flights.delete(event.id)
          landings++
        }
      }
      for (const projectile of state.projectiles) {
        check(isLocationSafeAtLayer(MENU_LAYER, projectile.x, projectile.y), `projectile ${projectile.id} over the floor`)
        const flight = flights.get(projectile.id)!
        const distance = Math.hypot(flight.x - projectile.x, flight.y - projectile.y)
        check(distance <= flight.distance + 0.00001, `projectile ${projectile.id} closing on its landing`)
        flight.distance = distance
      }
    }
    expect(broken).toEqual([])
    expect(performers.size).toBe(10)
    expect(peakActive).toBe(2)
    // sampled once per tick, a flight counts up to a tick past its landing: 0.453 at 60 Hz, 0.450 at 30
    expect(quietTicks / ticks(seconds)).toBeGreaterThan(0.44)
    // the phrase repeats: every performer releases again in each full phrase
    expect(releases).toBeGreaterThanOrEqual(performers.size * Math.floor(seconds / 31))
    expect(releases - landings).toBeLessThanOrEqual(2)
    expect(flights.size).toBeLessThanOrEqual(2)
  })

  it('keeps snapshot ownership private and the repeated choreography deterministic', () => {
    const a = createMenuTableau(1, 19)
    const b = createMenuTableau(1, 19)
    let frame = a.step()
    b.step()
    const original = JSON.stringify(frame)
    const retained = frame
    for (let tick = 0; tick < ticks(1.17); tick++) {
      frame = a.step()
      b.step()
    }
    expect(frame.state.projectiles.length).toBeGreaterThan(0)
    const inFlight = frame
    const flightOriginal = JSON.stringify(inFlight)
    for (let tick = 0; tick < ticks(2); tick++) {
      a.step()
      b.step()
    }
    expect(JSON.stringify(retained)).toBe(original)
    expect(JSON.stringify(inFlight)).toBe(flightOriginal)
    inFlight.state.pawns[0].x = 99999
    inFlight.state.projectiles[0].x = 99999
    inFlight.events.length = 0
    // hashed every few ticks (a leaked mutation lasts at least a whole flight), events every tick
    const runs: { hashes: number[]; events: unknown[] }[] = [{ hashes: [], events: [] }, { hashes: [], events: [] }]
    for (let tick = 0; tick < ticks(30); tick++) {
      for (const [i, stage] of [a, b].entries()) {
        const frame = stage.step()
        if (tick % 5 === 0) runs[i].hashes.push(hashState(frame.state))
        runs[i].events.push(frame.events)
      }
    }
    expect(runs[0]).toEqual(runs[1])
  })
})
