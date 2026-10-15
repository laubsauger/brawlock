import { describe, expect, test } from 'vitest'
import { DT, ORIGINAL_TICK, TICK_HZ } from './types'
import { frictionPerTick } from './config'
import { PI, atan2, cos, exp, log, pow, sin, wrapAngle } from './math'

// The sim may not use engine trig (cross-browser determinism), so its own trig must still be
// accurate enough that geometry (spawn ring, facing, aim) matches what engine trig would give.
describe('deterministic math matches libm closely', () => {
  test('sin / cos over the game range', () => {
    for (let x = -50; x <= 50; x += 0.0137) {
      expect(Math.abs(sin(x) - Math.sin(x))).toBeLessThan(4e-16)
      expect(Math.abs(cos(x) - Math.cos(x))).toBeLessThan(4e-16)
    }
  })

  test('atan2 over all quadrants', () => {
    for (let a = -3; a <= 3; a += 0.173) {
      for (let b = -3; b <= 3; b += 0.191) {
        expect(Math.abs(atan2(a, b) - Math.atan2(a, b))).toBeLessThan(5e-16)
      }
    }
    expect(atan2(0, -1)).toBe(PI)
    expect(atan2(1, 0)).toBe(PI / 2)
    expect(atan2(0, 0)).toBe(0)
  })

  test('exp / log / pow', () => {
    for (let x = -20; x <= 20; x += 0.37) expect(Math.abs(exp(x) / Math.exp(x) - 1)).toBeLessThan(5e-16)
    for (let x = 0.001; x < 1e6; x *= 1.7) expect(Math.abs(log(x) - Math.log(x))).toBeLessThan(5e-15)
    expect(Math.abs(pow(0.96, 1 / 0.035) / Math.pow(0.96, 1 / 0.035) - 1)).toBeLessThan(1e-14)
  })

  test('wrapAngle lands in (-pi, pi]', () => {
    for (let a = -40; a <= 40; a += 0.31) {
      const w = wrapAngle(a)
      expect(w).toBeGreaterThan(-PI)
      expect(w).toBeLessThanOrEqual(PI)
      expect(Math.abs(Math.sin(w) - Math.sin(a))).toBeLessThan(1e-12)
    }
  })
})

describe('friction conversion', () => {
  // The original multiplies velocity by 0.96 every 0.035 s tick; at 60 Hz the decay per real
  // second must be identical, or knockback distances change.
  test('one second of 60 Hz ticks decays like one second of original ticks', () => {
    const perTick = frictionPerTick(0.96)
    let v = 1
    for (let i = 0; i < TICK_HZ; i++) v *= perTick
    const original = Math.pow(0.96, 1 / ORIGINAL_TICK) // ~0.3115 per second
    expect(Math.abs(v / original - 1)).toBeLessThan(1e-12)
    expect(original).toBeCloseTo(0.3115, 4)
  })

  test('per-tick factor equals friction^(DT / 0.035) for lobby values', () => {
    for (const f of [0.9, 0.93, 0.96, 0.99, 1]) {
      expect(Math.abs(frictionPerTick(f) - Math.pow(f, DT / ORIGINAL_TICK))).toBeLessThan(1e-15)
    }
    expect(frictionPerTick(0)).toBe(0)
  })
})
