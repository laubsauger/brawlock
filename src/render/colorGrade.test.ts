import { describe, expect, it, vi } from 'vitest'

// Evaluate the production TSL expression on numeric nodes. The browser fixture
// additionally checks the actual compiled shader against fixed scene captures.
vi.mock('three/tsl', () => {
  class Scalar {
    constructor(readonly value: number) {}
    add(other: Scalar | number) { return new Scalar(this.value + n(other)) }
    sub(other: Scalar | number) { return new Scalar(this.value - n(other)) }
    mul(other: Scalar | number) { return new Scalar(this.value * n(other)) }
  }
  const n = (value: Scalar | number) => value instanceof Scalar ? value.value : value
  class Vector {
    readonly r: Scalar; readonly g: Scalar; readonly b: Scalar
    constructor(readonly channels: number[]) { [this.r, this.g, this.b] = channels.map((value) => new Scalar(value)) }
    mul(value: Scalar | number) { return new Vector(this.channels.map((channel) => channel * n(value))) }
  }
  return {
    float: (value: number) => new Scalar(value),
    vec3: (...values: number[]) => new Vector(values),
    dot: (a: Vector, b: Vector) => new Scalar(a.channels.reduce((sum, value, i) => sum + value * b.channels[i], 0)),
    max: (a: Scalar, b: Scalar) => new Scalar(Math.max(n(a), n(b))),
    mix: (a: Scalar, b: Scalar, t: Scalar) => new Scalar(n(a) + (n(b) - n(a)) * n(t)),
    smoothstep: (a: number, b: number, value: Scalar) => {
      const t = Math.max(0, Math.min(1, (n(value) - a) / (b - a)))
      return new Scalar(t * t * (3 - 2 * t))
    },
  }
})

import { vec3 } from 'three/tsl'
import { gradeSceneColor } from './colorGrade'
import { PLAYER_COLORS } from '../net/lobbyColors'

const grade = (rgb: number[]) => (gradeSceneColor(vec3(rgb[0], rgb[1], rgb[2])) as unknown as { channels: number[] }).channels

describe('scene grading readability and color constraints', () => {
  it('opens dim floor detail while retaining black and dark shadow detail', () => {
    expect(grade([0, 0, 0])).toEqual([0, 0, 0])
    const floor = [0.012, 0.018, 0.04]
    grade(floor).forEach((value, i) => expect(value / floor[i]).toBeCloseTo(1.10, 8))
    expect(grade([0.001, 0.001, 0.001])[0]).toBeGreaterThanOrEqual(0.001 * 0.97)
  })

  it('keeps the luminance ramp strictly increasing without exceeding existing HDR ceilings', () => {
    let previous = -1
    for (let i = 0; i <= 1024; i++) {
      const level = (i / 1024) * 2.2
      const [value] = grade([level, level, level])
      expect(value).toBeGreaterThan(previous)
      expect(value).toBeLessThanOrEqual(2.2)
      previous = value
    }
  })

  it('preserves all ten player color ratios through the shadow and midtone range', () => {
    const linear = (channel: number) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    for (const color of PLAYER_COLORS) {
      const rgb = [color >> 16 & 255, color >> 8 & 255, color & 255].map((channel) => linear(channel / 255))
      for (const light of [0.01, 0.04, 0.2, 1]) {
        const input = rgb.map((channel) => channel * light)
        const output = grade(input)
        const gain = output[0] / input[0]
        input.forEach((channel, i) => expect(output[i] / channel).toBeCloseTo(gain, 10))
      }
    }
  })

  it('leaves colored emissive highlights unchanged rather than whitening them', () => {
    for (const highlight of [[0.65, 0.02, 0.01], [0.01, 0.03, 2.2], [0.1, 6, 0.2], [4, 1.2, 0.1], [6, 6, 6]]) {
      expect(grade(highlight)).toEqual(highlight)
    }
  })
})
