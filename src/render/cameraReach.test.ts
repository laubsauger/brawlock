import { describe, expect, it } from 'vitest'
import * as THREE from 'three/webgpu'
import { ARENA_MARGIN, CameraReach, EDGE_SPEED, reachFor, type ReachInput } from './cameraReach'
import { cameraRig, frameOffset, zoomStep, ZOOM_MAX, ZOOM_ORIGINAL_MAX } from './cameraRig'

/**
 * Camera reach is how players see and snipe across the map without a
 * detached camera: edge pan and peek must reach the far side of a full
 * arena, move smoothly (no jumps, no bobbing), come back to the warlock on
 * their own, and never leave the arena. The overview zoom must fit a whole
 * full-size arena while the original zoom steps stay exactly as they were.
 */

const FULL_R = 2000 // layer 21, ten players
const DT = 1 / 60

function input(over: Partial<ReachInput> = {}): ReachInput {
  return {
    dt: DT,
    pointer: { x: 0, y: 0, inside: true },
    peek: false,
    aiming: false,
    cursor: { x: 0, y: 0, valid: false },
    pawn: { x: 0, y: 0 },
    arenaR: FULL_R,
    reach: reachFor('normal', FULL_R),
    edgeSpeed: EDGE_SPEED,
    ...over,
  }
}

describe('camera reach', () => {
  it('reach per setting frames the far side of a full arena (diameter based)', () => {
    expect(reachFor('short', FULL_R)).toBe(1600)
    expect(reachFor('normal', FULL_R)).toBe(3000)
    expect(reachFor('far', FULL_R)).toBe(4000)
  })

  it('edge pan accelerates smoothly, then holds at the reach / arena limit', () => {
    const r = new CameraReach()
    // warlock at the west edge of the arena, cursor on the east screen edge
    const pawn = { x: -1800, y: 0 }
    let prev = 0
    let prevStep = 0
    for (let i = 0; i < 60 * 4; i++) {
      const o = r.step(input({ pawn, pointer: { x: 0.99, y: 0, inside: true } }))
      const stepLen = o.x - prev
      // never a jump: at most the edge speed per frame, and no sudden jerk
      expect(stepLen).toBeLessThanOrEqual(EDGE_SPEED * DT + 1e-6)
      expect(stepLen - prevStep).toBeLessThanOrEqual(EDGE_SPEED * DT * 0.25)
      prevStep = stepLen
      prev = o.x
    }
    // reached the full reach east of the warlock (inside the arena)
    expect(r.ox).toBeCloseTo(3000, 0)
  })

  it('never takes the view centre past the arena edge plus margin', () => {
    const r = new CameraReach()
    const pawn = { x: 1700, y: 0 }
    for (let i = 0; i < 60 * 4; i++) r.step(input({ pawn, pointer: { x: 0.99, y: 0.99, inside: true } }))
    expect(Math.hypot(pawn.x + r.ox, pawn.y + r.oy)).toBeLessThanOrEqual(FULL_R + ARENA_MARGIN + 1e-6)
  })

  it('eases back to the warlock without overshoot when the cursor leaves the edge', () => {
    const r = new CameraReach()
    for (let i = 0; i < 90; i++) r.step(input({ pointer: { x: 0.99, y: 0, inside: true } }))
    const start = r.ox
    expect(start).toBeGreaterThan(500)
    let prev = start
    for (let i = 0; i < 90; i++) {
      r.step(input({ pointer: { x: 0.3, y: 0, inside: true } }))
      // monotonic, never past the warlock (no bobbing)
      expect(r.ox).toBeLessThanOrEqual(prev + 1e-6)
      expect(r.ox).toBeGreaterThanOrEqual(0)
      prev = r.ox
    }
    // ~1.5 s later it is back (critically damped, ~0.6 s)
    expect(r.ox).toBeLessThan(start * 0.02)
  })

  it('edge pan off: the screen edge never pans, peek still does', () => {
    const r = new CameraReach()
    for (let i = 0; i < 60 * 2; i++) r.step(input({ edgePan: false, pointer: { x: 0.99, y: 0.99, inside: true } }))
    expect(r.ox).toBe(0)
    expect(r.oy).toBe(0)
    const pawn = { x: 0, y: -1800 }
    for (let i = 0; i < 60 * 2; i++) r.step(input({ edgePan: false, pawn, peek: true, pointer: { x: 0, y: 0.9, inside: true } }))
    expect(r.oy).toBeGreaterThan(2000)
  })

  it('peek eases toward the cursor up to the reach, and back on release', () => {
    const r = new CameraReach()
    // warlock at the south edge looking north across the whole arena
    const pawn = { x: 0, y: -1800 }
    for (let i = 0; i < 60 * 2; i++) r.step(input({ pawn, peek: true, pointer: { x: 0, y: 0.9, inside: true } }))
    // straight up-screen = game +y, close to the full reach
    expect(r.oy).toBeGreaterThan(3000 * 0.9)
    expect(Math.abs(r.ox)).toBeLessThan(1)
    for (let i = 0; i < 60 * 2; i++) r.step(input({ pawn, peek: false, pointer: { x: 0, y: 0.9, inside: true } }))
    expect(r.oy).toBeLessThan(50)
  })

  it('leans toward the cursor while aiming, capped, and much less otherwise', () => {
    const r = new CameraReach()
    const cursor = { x: 2500, y: 0, valid: true }
    const aim = r.step(input({ aiming: true, cursor }))
    expect(aim.x).toBeCloseTo(650, 0)
    const idle = r.step(input({ aiming: false, cursor }))
    expect(idle.x).toBeCloseTo(160, 0)
  })
})

describe('overview zoom', () => {
  it('keeps the original 200-unit steps inside 500..1500', () => {
    expect(zoomStep(1100, 1)).toBe(1300)
    expect(zoomStep(1300, -1)).toBe(1100)
    expect(zoomStep(500, -3)).toBe(500)
  })

  it('beyond 1500 steps by the same ratio as the last original notch, up to the max', () => {
    const r = 1 + 200 / ZOOM_ORIGINAL_MAX
    expect(zoomStep(1500, 1)).toBeCloseTo(1500 * r, 6)
    expect(zoomStep(2000, -1)).toBeCloseTo(2000 / r, 6)
    expect(zoomStep(ZOOM_MAX, 5)).toBe(ZOOM_MAX)
  })

  it('frames the warlock a little below centre normally, centred at the overview', () => {
    expect(frameOffset(1100)).toBeCloseTo(0.1, 6)
    expect(frameOffset(ZOOM_MAX)).toBeCloseTo(-0.2, 6)
  })

  it('fits a whole full-size arena on a 16:9 screen at max zoom, with margin', () => {
    const cam = new THREE.PerspectiveCamera(55, 16 / 9, 0.5, 400)
    cameraRig.reset()
    cameraRig.recenter()
    cameraRig.targetDist = ZOOM_MAX
    cameraRig.dist = ZOOM_MAX
    cameraRig.update(cam, 0, 0, 1 / 60, 16 / 9, 0)
    cam.updateMatrixWorld()
    let worst = 0
    // the arena's outermost tile corners reach ~2100 from the centre
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2
      const v = new THREE.Vector3(Math.cos(a) * 21, 0, -Math.sin(a) * 21).project(cam)
      worst = Math.max(worst, Math.abs(v.x), Math.abs(v.y))
    }
    expect(worst).toBeLessThan(0.97)
    cameraRig.reset()
  })
})
