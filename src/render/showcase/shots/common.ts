/**
 * Shared shot helpers: column identity (the shop's names and hues), lower-third
 * builders and the reusable "spell camera" (caster close-up -> flight -> impact).
 */
import { COLUMNS } from '../../../ui/data/catalog'
import { FLOOR, Follow, SAFE, clamp01, ease, ease5, fitPose, lerp, orbit, type CamPose, type FrameBox, type V3 } from '../cam'
import { COLORS, type PlayerDef } from '../simShot'
import type { CamCtx, LowerThird } from '../types'

export { COLORS }

/** shop column index 0..5 -> { name, hue } (shop UI identity) */
export function column(i: number): { name: string; hue: string; n: number } {
  return { name: COLUMNS[i].name, hue: COLUMNS[i].hue, n: i + 1 }
}

export const KIT_HUE = '#e9d3b0'

export function spellLower(name: string, spell: string, col: number | 'kit' | 'item', line: string, at?: number, until?: number): LowerThird {
  if (col === 'kit') return { name, spell, kicker: 'Starting kit', kickerColor: KIT_HUE, line, at, until }
  if (col === 'item') return { name, spell, kicker: 'Active item', kickerColor: KIT_HUE, line, at, until }
  const c = column(col)
  return { name, spell, kicker: `Column ${c.n} · ${c.name}`, kickerColor: c.hue, line, at, until }
}

/** column chapter card shown over the first shot of a column */
export function chapter(col: number, at = 0.15, until = 1.45): { title: string; sub: string; color: string; at: number; until: number } {
  const c = column(col)
  return { title: c.name, sub: `Column ${c.n} of 6 · ${COLUMNS[col].hint}`, color: c.hue, at, until }
}

/** standard cast: hero on the left, dummies to the right */
export const HERO: PlayerDef = { name: 'Ashcaller', color: COLORS.ember }
export const DUMMIES: PlayerDef[] = [
  { name: 'Frostbinder', color: COLORS.azure },
  { name: 'Hexweaver', color: COLORS.violet },
  { name: 'Mossgrave', color: COLORS.moss },
  { name: 'Tidewarden', color: COLORS.teal },
  { name: 'Rosethorn', color: COLORS.rose },
]

/** 1D critically damped follower */
export class Smooth {
  v = 0
  private dv = 0
  private init = false
  constructor(private omega = 4) {}
  update(target: number, dt: number, omega = this.omega): number {
    if (!this.init) {
      this.v = target
      this.init = true
      return this.v
    }
    const e = Math.exp(-omega * dt)
    const d = this.v - target
    const tmp = (this.dv + omega * d) * dt
    this.v = target + (d + tmp) * e
    this.dv = (this.dv - omega * tmp) * e
    return this.v
  }
}

function mem<T>(c: CamCtx, key: string, make: () => T): T {
  if (!(key in c.mem)) c.mem[key] = make()
  return c.mem[key] as T
}

export interface SpellCamOpts {
  caster: number
  /** victim / point of interest after the impact */
  target: number | { x: number; y: number }
  /** projectile spell to follow in flight (null = no flight phase) */
  spell?: string | null
  kind?: string
  /** owner of the followed projectile (default caster; null = any owner, e.g. a reflected bolt) */
  owner?: number | null
  /**
   * orbit params per phase: [dist, pitch, yaw]; yaw is RELATIVE to the caster -> target line
   * (0 = camera on the right-hand side looking across the line, +60 = toward the target's end,
   * i.e. a front three-quarter view of the caster)
   */
  windup?: [number, number, number]
  flight?: [number, number, number]
  impact?: [number, number, number]
  /** flight focus: share of the target mixed into the projectile position */
  frameBoth?: number
  /** look-at height above the floor */
  lift?: number
  fov?: number
  /** responsiveness of the focus follower */
  omega?: number
  /** slow drift of yaw over the shot, degrees per second */
  drift?: number
  /** without a projectile: seconds (video) of the windup phase before switching to the impact framing */
  windupFor?: number
  /** impact framing: look at this point instead of the target / last projectile position */
  impactAt?: { x: number; y: number }
  /** fixed reference direction (degrees) instead of the caster -> target line */
  lineYaw?: number
}

/**
 * Event-driven spell camera: frames the caster while the projectile does not
 * exist yet, frames projectile + target in flight, then settles on the impact
 * point (latched last projectile position, or the target pawn) with a slow
 * push-in. Followers smooth every change, so the phases blend into one move.
 */
export function spellCam(o: SpellCamOpts): (c: CamCtx) => CamPose {
  return (c) => {
    const f = mem(c, 'f', () => new Follow(o.omega ?? 4.5))
    const dist = mem(c, 'd', () => new Smooth(2.4))
    const pitch = mem(c, 'p', () => new Smooth(2.4))
    const yaw = mem(c, 'y', () => new Smooth(2.0))
    const st = mem(c, 'st', () => ({ phase: 0, last: null as V3 | null, impactAt: -1, line: NaN }))
    const caster = c.at(o.caster)
    const tgt: V3 = typeof o.target === 'number' ? c.at(o.target) : { x: o.target.x, y: o.target.y, h: FLOOR }
    if (Number.isNaN(st.line)) st.line = o.lineYaw ?? (Math.atan2(tgt.y - caster.y, tgt.x - caster.x) * 180) / Math.PI
    const pr = o.spell ? c.projAt(o.spell, o.owner === null ? undefined : (o.owner ?? o.caster), o.kind) : null
    if (pr) {
      st.phase = 1
      st.last = pr
    } else if (st.phase === 1) {
      st.phase = 2
      st.impactAt = c.vt
    } else if (o.windupFor !== undefined && c.vt > o.windupFor && st.phase === 0) {
      st.phase = 2
      st.impactAt = c.vt
    }
    let focus: V3
    let p: [number, number, number]
    const W = o.windup ?? [430, 16, 58]
    const F = o.flight ?? [600, 24, 8]
    const I = o.impact ?? [430, 17, 30]
    if (st.phase === 0) {
      // caster, nudged toward the target so the aim line reads
      focus = { x: lerp(caster.x, tgt.x, 0.2), y: lerp(caster.y, tgt.y, 0.2), h: FLOOR }
      p = W
    } else if (st.phase === 1 && st.last) {
      const k = o.frameBoth ?? 0.45
      focus = { x: lerp(st.last.x, tgt.x, k), y: lerp(st.last.y, tgt.y, k), h: FLOOR }
      const sep = Math.hypot(st.last.x - tgt.x, st.last.y - tgt.y)
      p = [Math.max(F[0], sep * 0.85 + 260), F[1], F[2]]
    } else {
      const at = o.impactAt ? { x: o.impactAt.x, y: o.impactAt.y, h: FLOOR } : typeof o.target === 'number' ? tgt : st.last ?? tgt
      focus = { x: at.x, y: at.y, h: FLOOR }
      const push = ease(clamp01((c.vt - st.impactAt) / 2.5))
      p = [I[0] * (1 - 0.15 * push), I[1], I[2]]
    }
    f.update(focus, c.dt)
    const d = dist.update(p[0], c.dt)
    const pi = pitch.update(p[1], c.dt)
    const ya = yaw.update(p[2], c.dt) + (o.drift ?? 2) * c.vt
    return orbit(f.x, f.y, FLOOR + (o.lift ?? 45), d, pi, st.line + ya, o.fov ?? 40)
  }
}

/** Slow orbit around a fixed point (establishing / reveal shots). */
export function orbitCam(x: number, y: number, dist: [number, number], pitch: [number, number], yaw: [number, number], dur: number, fov = 42, lift = 40): (c: CamCtx) => CamPose {
  return (c) => {
    const t = ease5(c.vt / dur)
    return orbit(x, y, FLOOR + lift, lerp(dist[0], dist[1], t), lerp(pitch[0], pitch[1], t), lerp(yaw[0], yaw[1], t), fov)
  }
}

/** Camera that follows a pawn with a fixed relative orbit (Follow-smoothed). */
export function pawnCam(owner: number, dist: number, pitch: number, yaw: number, opts: { omega?: number; lift?: number; fov?: number; drift?: number; lead?: number } = {}): (c: CamCtx) => CamPose {
  return (c) => {
    const f = mem(c, 'pf', () => new Follow(opts.omega ?? 4))
    const p = c.at(owner)
    f.update(p, c.dt)
    return orbit(f.x, f.y, FLOOR + (opts.lift ?? 45), dist, pitch, yaw + (opts.drift ?? 0) * c.vt, opts.fov ?? 42)
  }
}

/** linear speed curve helper: slow motion `scale` between sim seconds a..b with eased ramps of `ramp` sim s */
export function slowmo(a: number, b: number, scale: number, ramp = 0.06): (st: number) => number {
  return (st) => {
    if (st <= a - ramp || st >= b + ramp) return 1
    if (st < a) return lerp(1, scale, ease((st - (a - ramp)) / ramp))
    if (st > b) return lerp(scale, 1, ease((st - b) / ramp))
    return scale
  }
}

export interface StageOpts {
  /** degrees above the ground (default 46: the arena floor and every path read) */
  pitch?: number
  /** degrees relative to the line from pawn `from` to pawn `to` at the shot start (0 = camera on its right-hand side) */
  yaw?: number
  /** absolute yaw instead (degrees, orbit convention) */
  yawAbs?: number
  from?: number
  to?: number
  fov?: number
  /** start this much farther out and ease in to the fit over the shot (slow push-in), default 0.07 */
  push?: number
  /** slow lateral dolly: total yaw change over the shot, degrees (default 0) */
  dolly?: number
  /** only frame action between these sim seconds */
  fromSt?: number
  untilSt?: number
  /** ignore these projectile spells / pawn owners when fitting */
  exclude?: string[]
  excludeOwners?: number[]
  /** extra points to keep in frame */
  include?: { x: number; y: number; h?: number }[]
  /** safe area override (NDC) */
  box?: FrameBox
  /** widen the fit (1 = tight to the safe area) */
  margin?: number
  lift?: number
}

/**
 * Wide, steady stage camera: one static framing fitted to the shot's whole
 * dry-run action (caster, every projectile path, impact zone, where the dead
 * fall), seen from a fixed angle, with only a slow push-in / lateral dolly.
 */
export function stage(o: StageOpts = {}): (c: CamCtx) => CamPose {
  return (c) => {
    const fit = mem(c, 'stageFit', () => {
      const a = c.action
      const pts: V3[] = []
      for (const sm of a.samples) {
        if (o.fromSt !== undefined && sm.st < o.fromSt) continue
        if (o.untilSt !== undefined && sm.st > o.untilSt) continue
        if (sm.what === 'proj' && sm.spell && o.exclude?.includes(sm.spell)) continue
        if (o.excludeOwners?.includes(sm.owner) && sm.what === 'pawn') continue
        pts.push(sm)
      }
      for (const p of o.include ?? []) pts.push({ x: p.x, y: p.y, h: p.h ?? FLOOR })
      let yaw = o.yawAbs
      if (yaw === undefined) {
        const A = c.sim.state.pawns.find((p) => p.owner === (o.from ?? 0))
        const B = c.sim.state.pawns.find((p) => p.owner === (o.to ?? 1))
        const line = A && B ? (Math.atan2(B.y - A.y, B.x - A.x) * 180) / Math.PI : 0
        yaw = line + (o.yaw ?? 0)
      }
      const m = o.margin ?? 1
      const box = o.box ?? SAFE
      const fitted = fitPose(pts, o.pitch ?? 46, yaw, o.fov ?? 38, 16 / 9, { left: box.left / m, right: box.right / m, bottom: box.bottom / m, top: box.top / m }, o.lift ?? 40)
      return { pose: fitted, yaw, dist: Math.hypot(fitted.x - fitted.tx, fitted.y - fitted.ty, fitted.h - fitted.th) }
    })
    const T = ease5(clamp01(c.vt / c.dur))
    const d = fit.dist * (1 + (o.push ?? 0.07) * (1 - T))
    const yaw = fit.yaw + (o.dolly ?? 0) * (T - 0.5)
    return orbit(fit.pose.tx, fit.pose.ty, fit.pose.th, d, o.pitch ?? 46, yaw, o.fov ?? 38)
  }
}
