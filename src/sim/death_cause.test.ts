import { describe, expect, test } from 'vitest'
import { FIREBALL_SLOT, SCOURGE_SLOT } from './config'
import { setPlayerConnected, step } from './index'
import { spawnProjectile } from './projectiles'
import { castNow, cmd, fight, grant, of, pawn, place } from './testkit'
import type { SimEvent, SimState } from './types'

type Death = Extract<SimEvent, { type: 'death' }>

/** Victim (player 1) dies to the first damage instance; caster is player 0 at the origin facing +x. */
function arena(victimX: number, victimY: number, overrides = {}): SimState {
  const s = fight(2, undefined, overrides)
  place(pawn(s, 0), 0, 0, 0)
  place(pawn(s, 1), victimX, victimY)
  pawn(s, 1).hp = 1.5
  return s
}

function death(s: SimState, setup: () => SimEvent[] = () => [], max = 400): Death {
  const seen = [...setup()]
  for (let i = 0; i < max && !of(seen, 'death').length; i++) {
    step(s, [])
    seen.push(...s.events)
  }
  const d = of(seen, 'death')[0]
  expect(d, 'no death event').toBeDefined()
  return d
}

const cast = (s: SimState, spell: string, x: number, y: number) => () => castNow(s, 0, grant(s, 0, spell), x, y)
const shoot = (s: SimState, spell: string, x: number, vx: number, data: Record<string, number>, kind?: string, radius = 30) => () => {
  spawnProjectile(s, 0, spell, x, 0, vx, 0, radius, { lifetime: 2, kind, data })
  return []
}

describe("'death' reports the cause, knockback and position of the lethal instance", () => {
  // [expected cause, knockback expected, scenario]
  const CASES: [string, boolean, () => [SimState, () => SimEvent[]]][] = [
    ['fireball', true, () => { const s = arena(300, 0); return [s, () => castNow(s, 0, FIREBALL_SLOT, 300, 0)] }],
    ['cluster', true, () => { const s = arena(200, 0); return [s, cast(s, 'cluster', 200, 0)] }],
    ['splitter', true, () => { const s = arena(300, 0); return [s, cast(s, 'splitter', 3000, 0)] }],
    ['twin', true, () => { const s = arena(800, 0); return [s, cast(s, 'twin', 800, 0)] }],
    ['boomerang', true, () => { const s = arena(300, 0); return [s, cast(s, 'boomerang', 2000, 0)] }],
    ['homing', true, () => { const s = arena(300, 0); return [s, cast(s, 'homing', 300, 0)] }],
    ['bouncer', true, () => { const s = arena(300, 0); return [s, cast(s, 'bouncer', 300, 0)] }],
    ['drain', true, () => { const s = arena(300, 0); return [s, cast(s, 'drain', 300, 0)] }],
    ['recharge', true, () => { const s = arena(300, 0); return [s, cast(s, 'recharge', 300, 0)] }],
    ['lightning', true, () => { const s = arena(300, 0); return [s, cast(s, 'lightning', 300, 0)] }],
    ['meteor', true, () => { const s = arena(800, 0); return [s, cast(s, 'meteor', 800, 0)] }],
    ['scourge', true, () => { const s = arena(100, 0); return [s, () => castNow(s, 0, SCOURGE_SLOT, 0, 0)] }],
    ['thrust', true, () => { const s = arena(400, 0); return [s, cast(s, 'thrust', 400, 0)] }],
    ['windwalk', true, () => {
      const s = arena(200, 0)
      return [s, () => [...castNow(s, 0, grant(s, 0, 'windwalk'), 0, 0), ...(step(s, [cmd(0, { kind: 'move', x: 400, y: 0 })]), s.events)]]
    }],
    ['gravity', false, () => { const s = arena(300, 0); return [s, shoot(s, 'gravity', 300, 0, { strength: 0, dps: 20, pawnRadius: 550, projRadius: 600, projPull: 0, dpsRadius: 250, dpsPeriod: 12, dpsTimer: 12 }, undefined, 25)] }],
    ['link', false, () => { const s = arena(600, 0); return [s, cast(s, 'link', 600, 0)] }],
    ['lava', false, () => { const s = arena(3000, 0); return [s, () => []] }],
  ]

  for (const [cause, knock, make] of CASES) {
    test(cause, () => {
      const [s, setup] = make()
      const d = death(s, setup)
      expect(d).toMatchObject({ owner: 1, cause })
      if (knock) expect(d.kb).toBeGreaterThan(0)
      else expect(d.kb).toBe(0)
      expect(Number.isFinite(d.x)).toBe(true)
      expect(Number.isFinite(d.y)).toBe(true)
    })
  }

  test('Lightning detonating your own Fireball: lightning', () => {
    const s = arena(300, 100) // off the beam line, inside the r225 detonation
    spawnProjectile(s, 0, 'fireball', 300, 0, 0, 0, 25, { lifetime: 5, data: { damage: 70, kb: 1 } })
    expect(death(s, cast(s, 'lightning', 1000, 0))).toMatchObject({ cause: 'lightning', killer: 0 })
  })

  test('Homing self-detonation: homing', () => {
    const s = arena(0, 200)
    const d = death(s, shoot(s, 'homing', 100, -1000, { damage: 70, target: -1, cruise: 1000, selfRadius: 292, selfKb: 0.9, haste: 50, burnout: 120, hasteTime: 4 }))
    expect(d).toMatchObject({ cause: 'homing', killer: 0 })
  })

  test('Snowball explosion (knockback) and Snowball chill (no knockback)', () => {
    const boom = arena(650, 0)
    const sb = { damage: 30, damageMin: 0, damageMax: 45, explosion: 200, kb: 0.8, drag: 425, slow: 100, dotPeriod: 0.5 }
    boom.projectiles.push({ ...snowballAt(boom, 500, sb), ticksLeft: 2 })
    const d1 = death(boom)
    expect(d1).toMatchObject({ cause: 'snowball' })
    expect(d1.kb).toBeGreaterThan(0)

    const chill = arena(300, 0)
    chill.projectiles.push({ ...snowballAt(chill, 300, sb), vx: 0, ticksLeft: 600 })
    const d2 = death(chill)
    expect(d2).toMatchObject({ cause: 'snowball', kb: 0 })
  })

  test('pillar explosion: obstacle, no kill credit', () => {
    const s = arena(0, 650)
    s.obstacles.push({ id: s.nextEntityId++, x: 0, y: 500, radius: 60, hp: 1, variant: 0 })
    spawnProjectile(s, 0, 'fireball', -200, 500, 1000, 0, 25, { lifetime: 1, data: { damage: 70, kb: 1 } })
    const d = death(s)
    expect(d).toMatchObject({ cause: 'obstacle', killer: null })
    expect(d.kb).toBeGreaterThan(0)
  })

  test('a leaver without bot takeover: disconnect, at the place they stood', () => {
    const s = arena(250, -40, { botsReplaceLeavers: false })
    setPlayerConnected(s, 1, false)
    step(s, [])
    expect(of(s.events, 'death')[0]).toEqual({ type: 'death', pawn: pawn(s, 1).id, owner: 1, killer: null, cause: 'disconnect', kb: 0, x: 250, y: -40 })
  })

  test('x / y is where the pawn was when it died; killer semantics unchanged', () => {
    const s = arena(2600, 0)
    const d = death(s)
    expect(d).toMatchObject({ cause: 'lava', killer: null, x: 2600, y: 0 })
  })
})

/** a Snowball owned by player 0 at (x, 0), r75, rolling +x at 400 */
function snowballAt(s: SimState, x: number, data: Record<string, number>) {
  return { id: s.nextEntityId++, owner: 0, spell: 'snowball', x, y: 0, vx: 400, vy: 0, radius: 75, ticksLeft: 60, data: { ...data } }
}
