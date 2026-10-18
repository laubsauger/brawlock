import { describe, expect, it } from 'vitest'
import { PerspectiveCamera, Vector3 } from 'three'
import { menuCameraAt } from './menuCamera'
import { createMenuStage } from './menuStage'

describe('menu camera composition', () => {
  it('keeps the sparring pair in frame throughout the arc and close view', () => {
    const stage = createMenuStage(0)
    const { state } = stage.step()
    for (const aspect of [1440 / 900, 1280 / 720, 390 / 844]) {
      for (let t = 0; t <= 144; t += 0.5) {
        const shot = menuCameraAt(t, stage.focus, stage.out, aspect, false)
        const camera = new PerspectiveCamera(shot.fov, aspect, 1, 20_000)
        camera.position.set(shot.x, shot.height, -shot.y)
        camera.lookAt(shot.aimX, 0, -shot.aimY)
        camera.updateMatrixWorld()
        for (const pawn of state.pawns) {
          const point = new Vector3(pawn.x, 80, -pawn.y).project(camera)
          expect(point.x).toBeGreaterThan(-1)
          expect(point.x).toBeLessThan(0.98)
          expect(Math.abs(point.y)).toBeLessThan(0.85)
          if (aspect > 1) expect(point.x).toBeGreaterThan(-0.05)
        }
      }
    }
  })

  it('moves continuously and holds still under reduced motion', () => {
    const stage = createMenuStage(0)
    for (let t = 0; t < 144; t += 0.1) {
      const a = menuCameraAt(t, stage.focus, stage.out, 1.6, false)
      const b = menuCameraAt(t + 1 / 60, stage.focus, stage.out, 1.6, false)
      expect(Math.hypot(a.x - b.x, a.y - b.y, a.height - b.height)).toBeLessThan(2)
      expect(menuCameraAt(t, stage.focus, stage.out, 1.6, true)).toEqual(menuCameraAt(0, stage.focus, stage.out, 1.6, true))
    }
  })
})
