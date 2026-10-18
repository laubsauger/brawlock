import { describe, expect, it, vi } from 'vitest'
import { Color, PerspectiveCamera, Vector3 } from 'three/webgpu'
import { CastMarks, HAND_MARKS } from './CastMarks'
import { S } from '../coords'

function marks() {
  const instance = Object.create(CastMarks.prototype) as CastMarks
  const sink = { addStreak: vi.fn(), begin: vi.fn() }
  Object.assign(instance, { batch: sink, right: new Vector3(1, 0, 0), up: new Vector3(0, 1, 0), color: new Color() })
  return { instance, sink }
}

describe('attached ability signatures', () => {
  it('has eight different silhouettes even without colour or motion, all legible from charge start', () => {
    const silhouettes = new Set<string>()
    for (const spell of Object.keys(HAND_MARKS)) {
      const { instance, sink } = marks()
      instance.charge(spell, new Vector3(), 0)
      expect(sink.addStreak.mock.calls.length).toBeGreaterThanOrEqual(5)
      silhouettes.add(JSON.stringify(sink.addStreak.mock.calls.map((s) => s.slice(0, 6))))
      expect(sink.addStreak.mock.calls.every((s) => Math.max(s[6], s[7], s[8]) >= .8)).toBe(true)
    }
    expect(silhouettes.size).toBe(8)
  })

  it('keeps every stroke on the current hand across translations, facings and charge progress', () => {
    for (const spell of Object.keys(HAND_MARKS)) for (const progress of [0, .5, 1]) {
      const { instance, sink } = marks()
      const camera = new PerspectiveCamera()
      camera.position.set(5, 7, -4)
      camera.lookAt(0, 0, 0)
      camera.updateMatrixWorld()
      instance.begin(camera)
      const hand = new Vector3(10, 3, -8)
      instance.charge(spell, hand, progress)
      const first = sink.addStreak.mock.calls.map((s) => [...s])
      for (const s of first) {
        const center = new Vector3(s[0], s[1], s[2])
        // Whole glyph, including line endpoints/caps, fits a 40-unit hand patch.
        const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
        const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
        const along = right.multiplyScalar(Math.cos(s[5])).addScaledVector(up, Math.sin(s[5]))
        const halfLength = s[3] * s[4] * .5
        const endA = center.clone().addScaledVector(along, halfLength)
        const endB = center.clone().addScaledVector(along, -halfLength)
        expect(Math.max(endA.distanceTo(hand), endB.distanceTo(hand)) + s[3] * .5).toBeLessThan(40 * S)
        expect(s.every(Number.isFinite)).toBe(true)
      }
      sink.addStreak.mockClear()
      const shift = new Vector3(-3, 1, 6)
      instance.charge(spell, hand.clone().add(shift), progress)
      sink.addStreak.mock.calls.forEach((s, i) => {
        expect(s[0] - first[i][0]).toBeCloseTo(shift.x)
        expect(s[1] - first[i][1]).toBeCloseTo(shift.y)
        expect(s[2] - first[i][2]).toBeCloseTo(shift.z)
      })
    }
  })

  it('cancellation contracts and dims instead of creating a launch flash or moving remnant', () => {
    const { instance, sink } = marks()
    const radii: number[] = []
    const brightness: number[] = []
    for (const age of [0, .5, .99]) {
      sink.addStreak.mockClear()
      instance.cancel(new Vector3(), age)
      radii.push(Math.max(...sink.addStreak.mock.calls.map((s) => Math.hypot(s[0], s[1], s[2]))))
      brightness.push(Math.max(...sink.addStreak.mock.calls.map((s) => Math.max(s[6], s[7], s[8]))))
    }
    expect(radii[2]).toBeLessThan(radii[1])
    expect(radii[1]).toBeLessThan(radii[0])
    expect(brightness[2]).toBeLessThan(brightness[1])
    expect(brightness[1]).toBeLessThan(brightness[0])
    expect(brightness[0]).toBeLessThan(.4)
  })
})
