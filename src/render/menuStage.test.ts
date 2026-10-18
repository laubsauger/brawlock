import { describe, expect, it } from 'vitest'
import { hashState, isLocationSafeAtLayer } from '../sim'
import type { SimEvent, SimState } from '../sim/types'
import { createMenuStage, MENU_LAYER } from './menuStage'

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
