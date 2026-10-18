import { describe, expect, it } from 'vitest'
import { PerspectiveCamera, Vector3 } from 'three'
import { victoryCameraOffset, victoryCameraWeight } from './victoryCamera'
import { ROUND_END_SECONDS } from '../sim/config'

describe('winner shot', () => {
  it('starts and ends at the gameplay camera, with a continuous hold between', () => {
    expect(victoryCameraWeight(0, ROUND_END_SECONDS)).toBe(0)
    expect(victoryCameraWeight(1, 1)).toBe(1)
    expect(victoryCameraWeight(2, 1)).toBe(1)
    expect(victoryCameraWeight(ROUND_END_SECONDS, 0)).toBe(0)
    for (let age = 0; age <= ROUND_END_SECONDS; age += 1 / 120) {
      const before = victoryCameraWeight(age, ROUND_END_SECONDS - age)
      const after = victoryCameraWeight(age + 1 / 120, ROUND_END_SECONDS - age - 1 / 120)
      expect(Math.abs(after - before)).toBeLessThan(0.03)
    }
  })

  it('frames the feet and both raised hands on desktop and portrait', () => {
    for (const aspect of [16 / 9, 4 / 3, 390 / 844]) {
      for (const facing of [0, 1.4, -Math.PI / 2]) {
        const shot = victoryCameraOffset(facing, aspect)
        const camera = new PerspectiveCamera(shot.fov, aspect, 1, 10_000)
        camera.position.set(shot.x, 90 + shot.height, -shot.y)
        camera.lookAt(0, 100, 0)
        camera.updateMatrixWorld()
        for (const point of [new Vector3(0, 0, 0), new Vector3(0, 260, 0), new Vector3(145, 220, 0), new Vector3(-145, 220, 0)]) {
          point.project(camera)
          expect(Math.abs(point.x)).toBeLessThan(0.85)
          expect(Math.abs(point.y)).toBeLessThan(0.8)
        }
      }
    }
  })
})
