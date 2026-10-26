import { describe, expect, it } from 'vitest'
import { HAND_MARKS, cancelStrokes, chargeStrokes, type StrokeSink } from './CastMarks'
import { S } from '../coords'

// Strokes are planned in the camera plane around the hand (CastMarks places them at the current
// hand along the camera's right and up axes), so they follow the hand at any facing.
type Stroke = Parameters<StrokeSink>
const strokes = (draw: (out: StrokeSink) => void): Stroke[] => {
  const all: Stroke[] = []
  draw((...stroke) => { all.push(stroke) })
  return all
}
const brightness = (all: Stroke[]) => Math.max(...all.map((s) => Math.max(s[5], s[6], s[7])))
const charge = (spell: string, progress: number) => strokes((out) => chargeStrokes(spell, progress, out))

describe('attached ability signatures', () => {
  it('gives every authored spell its own silhouette without colour or motion, whole from charge start', () => {
    const spells = Object.keys(HAND_MARKS)
    const silhouettes = new Set<string>()
    for (const spell of spells) {
      const start = charge(spell, 0)
      expect(start.length).toBeGreaterThanOrEqual(5)
      const shape = (all: Stroke[]) => JSON.stringify(all.map((s) => s.slice(0, 5)))
      silhouettes.add(shape(start))
      // progress brightens the glyph; it never grows, travels or draws strokes in
      for (const progress of [.5, 1]) expect(shape(charge(spell, progress))).toBe(shape(start))
      expect(brightness(charge(spell, .5))).toBeGreaterThan(brightness(start))
      expect(brightness(start)).toBeGreaterThanOrEqual(brightness(charge(spell, 1)) / 2)
    }
    expect(silhouettes.size).toBe(spells.length)
  })

  it('keeps every stroke, line ends and caps included, on a 40-unit hand patch', () => {
    for (const spell of Object.keys(HAND_MARKS)) {
      for (const [mx, my, width, aspect, angle, ...colour] of charge(spell, 1)) {
        const half = width * aspect * .5
        const ends = [1, -1].map((side) => Math.hypot(mx + Math.cos(angle) * half * side, my + Math.sin(angle) * half * side))
        expect(Math.max(...ends) + width * .5).toBeLessThan(40 * S)
        expect([mx, my, width, aspect, angle, ...colour].every(Number.isFinite)).toBe(true)
      }
    }
  })

  it('cancellation contracts and dims instead of creating a launch flash or moving remnant', () => {
    const radii: number[] = []
    const dims: number[] = []
    for (const age of [0, .5, .99]) {
      const ring = strokes((out) => cancelStrokes(age, out))
      radii.push(Math.max(...ring.map((s) => Math.hypot(s[0], s[1]))))
      dims.push(brightness(ring))
    }
    expect(radii[2]).toBeLessThan(radii[1])
    expect(radii[1]).toBeLessThan(radii[0])
    expect(dims[2]).toBeLessThan(dims[1])
    expect(dims[1]).toBeLessThan(dims[0])
    // dimmer than any charge, even at charge start
    expect(dims[0]).toBeLessThan(Math.min(...Object.keys(HAND_MARKS).map((spell) => brightness(charge(spell, 0)))))
  })
})
