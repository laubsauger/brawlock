/**
 * Showcase director: drives one shot frame by frame on the virtual clock.
 *
 * Per video frame (fixed 1/60 s): advance the sim by dt x timeScale (stepping
 * whole ticks as needed), write the render frame buffer so the world
 * interpolates at exactly that sub-tick time, set the cinematic camera pose
 * and the overlay. The world's own clock follows via devTime.scale, so
 * particles and animations slow down with the sim in slow motion.
 */
import { frame, pushEvents, resetFrame } from '../../game/frame'
import { devTime } from '../stats'
import { TICK_HZ, type SimState } from '../../sim/types'
import { FLOOR, type V3 } from './cam'
import { collectAction, type ActionInfo } from './action'
import { camOverride, setRigFocus } from './camRig'
import type { ShowcaseOverlay } from './overlay'
import { ShotSim } from './simShot'
import { speedAt, type CamCtx, type ShotSpec } from './types'

export const VIDEO_FPS = 60
const DTV = 1 / VIDEO_FPS

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export class Director {
  readonly sim: ShotSim
  /** video seconds since the shot started */
  vt = 0
  /** sim seconds (continuous) since the shot clock started */
  simT = 0
  timeScale = 1
  private alpha = 1
  private readonly mem: Record<string, unknown> = {}
  private readonly ctx: CamCtx
  /** dry run of the whole shot (stage cameras frame it) */
  readonly action: ActionInfo

  constructor(
    readonly spec: ShotSpec,
    private readonly overlay: ShowcaseOverlay | null,
  ) {
    this.action = collectAction(spec)
    this.sim = new ShotSim(spec)
    const self = this
    this.ctx = {
      vt: 0,
      st: 0,
      dt: DTV,
      dur: spec.dur,
      sim: this.sim,
      mem: this.mem,
      action: this.action,
      at: (owner) => self.pawnAt(owner),
      projAt: (spell, owner, kind) => self.projAt(spell, owner, kind),
    }
  }

  get frames(): number {
    return Math.round(this.spec.dur * VIDEO_FPS)
  }

  get done(): boolean {
    return this.vt >= this.spec.dur - 1e-6
  }

  /** hand the initial snapshot to the renderer */
  attach(): void {
    resetFrame()
    frame.localPlayer = this.spec.localPlayer ?? 0
    this.writeFrame(performance.now())
    this.applyCamera()
    this.overlay?.update(this.spec.overlay ?? null, 0, this.spec.dur)
  }

  private writeFrame(now: number): void {
    frame.prev = this.sim.prev
    frame.curr = this.sim.curr
    // the world interpolates alpha = (now - currAt) / (currAt - prevAt)
    frame.currAt = now - this.alpha * 1000
    frame.prevAt = frame.currAt - 1000
  }

  private find<T extends { id: number }>(list: T[], id: number): T | undefined {
    for (const x of list) if (x.id === id) return x
    return undefined
  }

  pawnAt(owner: number): V3 {
    const c = this.sim.curr.pawns.find((p) => p.owner === owner)
    if (!c) return { x: 0, y: 0, h: FLOOR }
    const p = this.find(this.sim.prev.pawns, c.id) ?? c
    return { x: lerp(p.x, c.x, this.alpha), y: lerp(p.y, c.y, this.alpha), h: FLOOR }
  }

  projAt(spell: string, owner?: number, kind?: string): V3 | null {
    const s: SimState = this.sim.curr
    let best: SimState['projectiles'][number] | undefined
    for (const p of s.projectiles) {
      if (p.spell !== spell) continue
      if (owner !== undefined && p.owner !== owner) continue
      if (kind !== undefined && (p.kind ?? p.spell) !== kind) continue
      if (!best || p.id > best.id) best = p
    }
    if (!best) return null
    const q = this.find(this.sim.prev.projectiles, best.id) ?? best
    return { x: lerp(q.x, best.x, this.alpha), y: lerp(q.y, best.y, this.alpha), h: 70 }
  }

  private applyCamera(): void {
    this.ctx.vt = this.vt
    this.ctx.st = this.simT
    const pose = this.spec.camera(this.ctx)
    camOverride.pose = pose
    setRigFocus(pose.tx, pose.ty)
  }

  /**
   * Advance one video frame. `nextNow` = the performance.now() the render will
   * see this frame (virtual clock after its step).
   */
  advance(nextNow: number, preroll = false, dt = DTV): void {
    if (!preroll) {
      const s = speedAt(this.spec, this.vt, this.simT)
      this.timeScale = s
      this.simT += dt * s
      const target = this.simT * TICK_HZ
      const need = Math.ceil(target - 1e-6)
      let guard = 0
      while (this.sim.state.tick - this.sim.t0 < need && guard++ < 16) {
        const ev = this.sim.stepOnce()
        pushEvents(this.sim.state.tick, ev)
      }
      const done = this.sim.state.tick - this.sim.t0
      this.alpha = Math.max(0, Math.min(1, 1 - (done - target)))
      this.vt += dt
    }
    devTime.scale = preroll ? 1 : this.timeScale
    this.ctx.dt = dt
    this.writeFrame(nextNow)
    this.applyCamera()
    this.overlay?.update(this.spec.overlay ?? null, this.vt, this.spec.dur)
  }
}
