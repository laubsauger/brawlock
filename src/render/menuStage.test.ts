import { describe, expect, it } from 'vitest'
import { hashState, isLocationSafeAtLayer } from '../sim'
import type { SimEvent, SimState } from '../sim/types'
import { createMenuBattle, createMenuStage, createMenuTableau, MENU_LAYER } from './menuStage'

describe('menu battle', () => {
  it('shows moving strong bots, varied real attacks, impacts and eliminations', () => {
    const stage = createMenuBattle(41)
    const spells = new Set<string>()
    let moving = 0
    let damage = 0
    let deaths = 0
    let rounds = 0
    let previousTick = 0
    for (let i = 0; i < 180 * 60; i++) {
      const { state, events } = stage.step()
      if (i === 0) expect(state.phase).toBe('fight')
      expect(state.tick).toBeGreaterThan(previousTick)
      previousTick = state.tick
      expect(state.slots.every((slot) => slot.kind === 'bot' && ['brutal', 'uber'].includes(slot.difficulty!))).toBe(true)
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
    expect(rounds).toBeGreaterThanOrEqual(1)
    expect(moving / (180 * 60)).toBeGreaterThan(0.85)
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

  it('starts fresh seeded matches indefinitely without reversing the render timeline', () => {
    const stage = createMenuBattle(41)
    let tick = 0
    let freshMatches = 0
    let roundWins = 0
    for (let i = 0; i < 1200 * 60; i++) {
      const frame = stage.step()
      if (tick && frame.state.tick - tick > 1) freshMatches++
      if (frame.state.tick <= tick) throw new Error('Menu render timeline reversed')
      tick = frame.state.tick
      roundWins += frame.events.filter((event) => event.type === 'roundWin').length
    }
    expect(freshMatches).toBeGreaterThan(0)
    expect(roundWins).toBeGreaterThanOrEqual(6)
  })
})

function watch(seconds: number, theme = 0, seed = 41) {
  const stage = createMenuStage(theme, seed)
  const events: { tick: number; event: SimEvent }[] = []
  let last: SimState | null = null
  let activeTicks = 0
  let maxProjectiles = 0
  for (let tick = 0; tick < seconds * 60; tick++) {
    const frame = stage.step()
    last = frame.state
    for (const event of frame.events) events.push({ tick: last.tick, event })
    if (last.projectiles.length || last.pawns.some((pawn) => pawn.cast)) activeTicks++
    maxProjectiles = Math.max(maxProjectiles, last.projectiles.length)
    expect(last.pawns).toHaveLength(2)
    expect(last.obstacles).toHaveLength(2)
    expect(last.arena).toMatchObject({ layer: MENU_LAYER, nextShrinkTick: -1, theme })
    for (const pawn of last.pawns) {
      expect(pawn.alive).toBe(true)
      expect(isLocationSafeAtLayer(MENU_LAYER, pawn.x, pawn.y)).toBe(true)
      expect(Math.hypot(pawn.x - stage.focus.x, pawn.y - stage.focus.y)).toBeLessThan(430)
      expect(pawn.modifiers.every((modifier) => modifier.id === 'shield')).toBe(true)
    }
    for (const event of frame.events) if (event.type === 'cast' && event.spell === 'fireball') {
      const caster = last.pawns.find((pawn) => pawn.id === event.pawn)!
      const rival = last.pawns.find((pawn) => pawn.owner !== caster.owner)!
      expect(Math.hypot(event.x - rival.x, event.y - rival.y)).toBeLessThan(35)
    }
  }
  return { last: last!, events, activeTicks, maxProjectiles }
}

describe('menu sparring stage', () => {
  it('aims alternating real attacks at the rival with quiet recovery between shots', () => {
    const result = watch(32)
    const shots = result.events.filter(({ event }) => event.type === 'cast' && event.spell === 'fireball')
    expect(shots).toHaveLength(8)
    for (let index = 1; index < shots.length; index++) {
      expect(shots[index].tick - shots[index - 1].tick).toBeGreaterThanOrEqual(238)
      expect(shots[index].tick - shots[index - 1].tick).toBeLessThanOrEqual(242)
      expect((shots[index].event as Extract<SimEvent, { type: 'cast' }>).pawn)
        .not.toBe((shots[index - 1].event as Extract<SimEvent, { type: 'cast' }>).pawn)
    }
    const victims = new Set(result.events.flatMap(({ event }) => event.type === 'damage' ? [event.target] : []))
    expect(victims.size).toBe(2)
    expect(result.activeTicks / (32 * 60)).toBeLessThan(0.5)
  })

  it('really reflects a shot back into its caster and evades shots by walking and Teleport', () => {
    const { events } = watch(22)
    const reflect = events.find(({ event }) => event.type === 'shieldReflect')!
    expect(reflect.event).toMatchObject({ reflected: true, stolen: true })
    expect(events.some(({ tick, event }) => tick > reflect.tick && tick < reflect.tick + 60
      && event.type === 'damage' && event.source === 0 && event.target === 2)).toBe(true)
    // Third shot: the defender walks inward after the shot is launched, clearing its path.
    expect(events.some(({ tick, event }) => tick >= 600 && tick < 730 && event.type === 'damage')).toBe(false)
    const walking = createMenuStage(0, 41)
    let beforeWalk = { x: 0, y: 0 }
    let afterWalk = { x: 0, y: 0 }
    for (let tick = 1; tick <= 720; tick++) {
      const pawn = walking.step().state.pawns[1]
      if (tick === 600) beforeWalk = { x: pawn.x, y: pawn.y }
      if (tick === 720) afterWalk = { x: pawn.x, y: pawn.y }
    }
    expect(Math.hypot(afterWalk.x - beforeWalk.x, afterWalk.y - beforeWalk.y)).toBeGreaterThan(150)
    const teleport = events.find(({ event }) => event.type === 'teleport')!
    expect(teleport.event).toBeDefined()
    if (teleport.event.type === 'teleport') {
      expect(Math.hypot(teleport.event.toX - teleport.event.fromX, teleport.event.toY - teleport.event.fromY)).toBeCloseTo(180, 0)
    }
    expect(events.some(({ tick, event }) => tick >= 1080 && tick < 1210 && event.type === 'damage')).toBe(false)
    expect(events.some(({ event }) => event.type === 'death')).toBe(false)
  })

  it.each([0, 1, 2])('keeps theme %i safe and bounded for ninety seconds', (theme) => {
    const { last, events, maxProjectiles, activeTicks } = watch(90, theme)
    expect(maxProjectiles).toBe(1)
    expect(last.scores).toHaveLength(2)
    expect(events.some(({ event }) => event.type === 'death' || event.type === 'arenaShrink' || event.type === 'roundWin')).toBe(false)
    expect(events.filter(({ event }) => event.type === 'cast' && event.spell === 'fireball')).toHaveLength(22)
    expect(events.filter(({ event }) => event.type === 'shieldReflect')).toHaveLength(2)
    expect(events.filter(({ event }) => event.type === 'teleport')).toHaveLength(3)
    expect(activeTicks / (90 * 60)).toBeLessThan(0.5)
  })

  it('is deterministic and never mutates emitted snapshots or retains caller mutations', () => {
    const stage = createMenuStage(1, 19)
    const first = stage.step()
    const original = JSON.stringify(first)
    for (let tick = 0; tick < 450; tick++) stage.step()
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
  it.each([0, 1, 2])('completes every cast with a safe visible flight and landing in theme %i', (theme) => {
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
    for (let tick = 0; tick < 90 * 60; tick++) {
      const { state, events } = stage.step()
      expect(state.pawns).toHaveLength(10)
      expect(state.phase).toBe('fight')
      expect(state.arena).toMatchObject({ layer: MENU_LAYER, nextShrinkTick: -1, theme })
      const active = state.projectiles.length + state.pawns.filter((pawn) => pawn.cast).length
      peakActive = Math.max(peakActive, active)
      if (active === 0) quietTicks++
      for (const pawn of state.pawns) {
        expect(pawn.alive).toBe(true)
        expect(pawn.hp).toBe(pawn.maxHp)
        expect(isLocationSafeAtLayer(MENU_LAYER, pawn.x, pawn.y)).toBe(true)
      }
      for (const event of events) {
        expect(['castCancel', 'damage', 'death', 'arenaShrink', 'roundWin']).not.toContain(event.type)
        if (event.type === 'castStart') {
          expect(started.has(event.pawn)).toBe(false)
          started.set(event.pawn, { tick: state.tick, duration: event.ticks })
        } else if (event.type === 'cast') {
          const start = started.get(event.pawn)!
          expect(state.tick - start.tick).toBe(start.duration)
          expect(start.duration).toBeGreaterThanOrEqual(36)
          expect(start.duration).toBeLessThanOrEqual(48)
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
        expect(isLocationSafeAtLayer(MENU_LAYER, projectile.x, projectile.y)).toBe(true)
        const flight = flights.get(projectile.id)!
        const distance = Math.hypot(flight.x - projectile.x, flight.y - projectile.y)
        expect(distance).toBeLessThanOrEqual(flight.distance + 0.00001)
        flight.distance = distance
      }
    }
    expect(performers.size).toBe(10)
    expect(peakActive).toBe(2)
    expect(quietTicks / (90 * 60)).toBeGreaterThan(0.45)
    expect(releases).toBeGreaterThanOrEqual(30)
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
    for (let tick = 0; tick < 70; tick++) {
      frame = a.step()
      b.step()
    }
    expect(frame.state.projectiles.length).toBeGreaterThan(0)
    const inFlight = frame
    const flightOriginal = JSON.stringify(inFlight)
    for (let tick = 0; tick < 120; tick++) {
      a.step()
      b.step()
    }
    expect(JSON.stringify(retained)).toBe(original)
    expect(JSON.stringify(inFlight)).toBe(flightOriginal)
    inFlight.state.pawns[0].x = 99999
    inFlight.state.projectiles[0].x = 99999
    inFlight.events.length = 0
    for (let tick = 0; tick < 1800; tick++) {
      const left = a.step()
      const right = b.step()
      expect(hashState(left.state)).toBe(hashState(right.state))
      expect(left.events).toEqual(right.events)
    }
  })
})
