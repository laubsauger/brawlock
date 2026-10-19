/**
 * Trailer shots: windows into real Uber-bot matches (trailerMatch.ts, picked with
 * scripts/showcase/scan_trailer.ts + trace_trailer.ts), each built around one key hit.
 * `hit` (video seconds) is the edit's sync point. No lower thirds or corner logo: the
 * titles are their own layer, composed in the edit (scripts/showcase/trailer.mjs).
 */
import { FLOOR, Follow, clamp01, ease, ease5, fitPose, lerp, orbit, span, type CamPose, type FrameBox, type V3 } from '../cam'
import type { ShotSim } from '../simShot'
import type { CamCtx, OverlaySpec, ShotSpec } from '../types'
import { Smooth, rimRadius, slowmo, stage } from './common'
import { trailerMatch } from './trailerMatch'

type CamKind = 'action' | 'close' | 'orbit' | 'low' | 'wide' | 'top' | 'freeze' | 'bullet'

interface MomentOpts {
  id: string
  match: string
  seed: number
  /** match seconds of the key hit */
  hit: number
  /** attacker / victim owners */
  a: number
  v: number
  cam: CamKind
  /** sim seconds shown before / after the hit (default 1.6 / 1.6) */
  pre?: number
  post?: number
  /** slow motion at the hit: [time scale, sim seconds held] */
  slow?: [number, number]
  /** yaw offset, degrees */
  yaw?: number
  pitch?: number
  /** distance scale for the framing */
  zoom?: number
  plates?: boolean
  /** more owners to keep in frame (action / wide) */
  also?: number[]
  /** hold the round-end moment instead of starting a new round */
  hold?: boolean
  /** bullet time: `at` sim seconds after the hit the sim nearly stops for `hold` video seconds while the camera sweeps `sweep` degrees */
  freeze?: { at: number; hold: number; low?: number; sweep?: number }
  /** slow motion through the flight before the hit: [time scale, sim seconds before the hit] */
  flight?: [number, number]
  /** projectile the bullet cam rides (default fireball) */
  spell?: string
  /** after the freeze, how far the camera turns to follow the victim (0..1, default 0.6) */
  chase?: number
}

/** the trailer has no lower third: frame the action around the centre */
const BOX: FrameBox = { left: -0.78, right: 0.78, bottom: -0.62, top: 0.66 }
const D2R = Math.PI / 180

function mem<T>(c: CamCtx, key: string, make: () => T): T {
  if (!(key in c.mem)) c.mem[key] = make()
  return c.mem[key] as T
}

/** where a pawn is in the dry run at sim second `st` (its death spot once dead) */
function posAt(c: CamCtx, owner: number, st: number): V3 {
  let best: V3 | null = null
  let bd = Infinity
  for (const s of c.action.samples) {
    if (s.what !== 'pawn' || s.owner !== owner) continue
    const d = Math.abs(s.st - st)
    if (d < bd) {
      bd = d
      best = { x: s.x, y: s.y, h: FLOOR }
    }
  }
  const death = c.action.deaths.find((d) => d.owner === owner)
  if (death && death.st <= st) return { x: death.x, y: death.y, h: FLOOR }
  return best ?? { x: 0, y: 0, h: FLOOR }
}

function pts(c: CamCtx, owners: number[], from: number, to: number, projOwners: number[] = [], projTo = to): V3[] {
  const out: V3[] = []
  for (const s of c.action.samples) {
    if (s.st < from || s.st > to) continue
    if (s.what === 'pawn' ? owners.includes(s.owner) : projOwners.includes(s.owner) && s.st <= projTo) out.push(s)
  }
  for (const d of c.action.deaths)
    if (owners.includes(d.owner) && d.st >= from && d.st <= to + 0.4)
      out.push({ x: d.x, y: d.y, h: FLOOR }, { x: d.x, y: d.y, h: FLOOR + 160 })
  return out
}

/** deterministic camera shake from the big hits the camera is looking at (decays in sim time) */
function shake(c: CamCtx, pose: CamPose, owners: number[]): CamPose {
  const s = mem(c, 'shake', () => ({ tick: -1, st: -99, amp: 0 }))
  const tick = c.sim.state.tick
  if (tick !== s.tick) {
    s.tick = tick
    for (const e of c.sim.events) {
      let amp = 0
      if (e.type === 'damage' && e.kb > 500) {
        const p = c.sim.state.pawns.find((q) => q.id === e.target)
        if (p && owners.includes(p.owner)) amp = Math.min(1, e.kb / 1900)
      }
      if (e.type === 'explosion' && (e.spell === 'meteor' || e.spell === 'scourge' || e.spell === 'cluster')) {
        const d = Math.hypot(e.x - pose.tx, e.y - pose.ty)
        if (d < 900) amp = Math.max(amp, e.spell === 'meteor' ? 1 : 0.6)
      }
      if (amp > s.amp * Math.exp(-(c.st - s.st) * 6)) {
        s.st = c.st
        s.amp = amp
      }
    }
  }
  const k = s.amp * Math.exp(-(c.st - s.st) * 6)
  if (k < 0.01) return pose
  const dist = Math.hypot(pose.x - pose.tx, pose.y - pose.ty, pose.h - pose.th)
  const a = dist * 0.012 * k
  const t = c.st * 60
  const dx = (Math.sin(t * 1.9) + Math.sin(t * 3.7 + 1.1)) * 0.5 * a
  const dy = (Math.sin(t * 2.3 + 2.0) + Math.sin(t * 4.1 + 0.4)) * 0.5 * a
  const dh = Math.sin(t * 2.9 + 0.7) * 0.4 * a
  return { ...pose, x: pose.x + dx, y: pose.y + dy, h: pose.h + dh, tx: pose.tx + dx * 0.6, ty: pose.ty + dy * 0.6, th: pose.th + dh * 0.6 }
}

/** angle (degrees) of the attacker -> victim line at the hit */
function lineDeg(c: CamCtx, a: number, v: number, hitSt: number): number {
  const A = posAt(c, a, hitSt - 0.05)
  const B = posAt(c, v, hitSt - 0.05)
  return (Math.atan2(B.y - A.y, B.x - A.x) * 180) / Math.PI
}

/** pick the side of the line whose camera sits toward the arena centre (lava behind the action) */
function sideYaw(c: CamCtx, a: number, v: number, hitSt: number, line: number): number {
  const A = posAt(c, a, hitSt)
  const B = posAt(c, v, hitSt)
  const mx = (A.x + B.x) / 2
  const my = (A.y + B.y) / 2
  const toward = (yaw: number) => Math.sin(yaw * D2R) * -mx + -Math.cos(yaw * D2R) * -my
  return toward(line) >= toward(line + 180) ? line : line + 180
}

function insideRim(c: CamCtx, p: CamPose): boolean {
  return Math.hypot(p.x, p.y) < rimRadius(c) || p.h > 2700
}

/** pull the camera in along its view ray until it is inside the caldera rim */
function keepInside(c: CamCtx, p: CamPose): CamPose {
  if (insideRim(c, p)) return p
  let lo = 0
  let hi = 1
  for (let i = 0; i < 24; i++) {
    const m = (lo + hi) / 2
    const q = { ...p, x: lerp(p.tx, p.x, m), y: lerp(p.ty, p.y, m), h: lerp(p.th, p.h, m) }
    if (insideRim(c, q)) lo = m
    else hi = m
  }
  return { ...p, x: lerp(p.tx, p.x, lo), y: lerp(p.ty, p.y, lo), h: lerp(p.th, p.h, lo) }
}

function actionCam(o: MomentOpts, hitSt: number): (c: CamCtx) => CamPose {
  return (c) => {
    const fit = mem(c, 'fit', () => {
      const line = lineDeg(c, o.a, o.v, hitSt)
      let yaw = sideYaw(c, o.a, o.v, hitSt, line) + (o.yaw ?? 0)
      const p = pts(c, [o.a, o.v, ...(o.also ?? [])], hitSt - 0.7, hitSt + Math.min(o.post ?? 1.6, 0.9), [o.a], hitSt + 0.1)
      const pitch = o.pitch ?? 38
      let pose = fitPose(p, pitch, yaw, 36, 16 / 9, BOX, 50)
      if (!insideRim(c, pose)) {
        const alt = fitPose(p, pitch, yaw + 180, 36, 16 / 9, BOX, 50)
        if (insideRim(c, alt)) {
          pose = alt
          yaw += 180
        }
      }
      const d = Math.hypot(pose.x - pose.tx, pose.y - pose.ty, pose.h - pose.th)
      return { pose, yaw, pitch, dist: Math.max(680, Math.min(1900, d)) * (o.zoom ?? 1) }
    })
    const T = ease5(c.vt / c.dur)
    const pose = orbit(fit.pose.tx, fit.pose.ty, fit.pose.th, fit.dist * (1.09 - 0.09 * T), fit.pitch, fit.yaw + 6 * (T - 0.5), 36)
    return shake(c, keepInside(c, pose), [o.a, o.v, ...(o.also ?? [])])
  }
}

function closeCam(o: MomentOpts, hitSt: number): (c: CamCtx) => CamPose {
  return (c) => {
    const f = mem(c, 'f', () => new Follow(5))
    const dist = mem(c, 'd', () => new Smooth(3))
    const pitch = mem(c, 'p', () => new Smooth(3))
    const line = mem(c, 'line', () => lineDeg(c, o.a, o.v, hitSt))
    const A = c.at(o.a)
    const V = c.at(o.v)
    // caster first (front three-quarter), then over to the victim as the hit lands
    const w = ease5(span(c.st, hitSt - 0.45, hitSt + 0.25))
    const k = lerp(0.22, 0.85, w)
    const focus = { x: lerp(A.x, V.x, k), y: lerp(A.y, V.y, k), h: FLOOR }
    const sep = Math.hypot(V.x - A.x, V.y - A.y)
    const z = o.zoom ?? 1
    f.update(focus, c.dt)
    const d = dist.update(lerp(560, Math.max(780, Math.min(1400, sep * 0.85 + 380)), w) * z, c.dt)
    const pi = pitch.update(lerp(o.pitch ?? 18, 28, w), c.dt)
    const yaw = line + 38 + (o.yaw ?? 0) - 18 * w + 3 * c.vt
    return shake(c, keepInside(c, orbit(f.x, f.y, FLOOR + 55, d, pi, yaw, 38)), [o.a, o.v])
  }
}

function orbitCam(o: MomentOpts, hitSt: number): (c: CamCtx) => CamPose {
  return (c) => {
    const fit = mem(c, 'fit', () => {
      const line = lineDeg(c, o.a, o.v, hitSt)
      const A = posAt(c, o.a, hitSt)
      const B = posAt(c, o.v, hitSt)
      const sep = Math.hypot(B.x - A.x, B.y - A.y)
      return { line, x: lerp(A.x, B.x, 0.62), y: lerp(A.y, B.y, 0.62), dist: Math.max(680, Math.min(1400, sep * 1.1 + 440)) * (o.zoom ?? 1) }
    })
    const f = mem(c, 'f', () => new Follow(2.2))
    // hold on the impact through the slow motion, then drift after the victim
    const V = c.at(o.v)
    const after = clamp01((c.st - hitSt - (o.slow?.[1] ?? 0)) / 0.8)
    f.update({ x: lerp(fit.x, V.x, 0.5 * after), y: lerp(fit.y, V.y, 0.5 * after), h: FLOOR }, c.dt)
    const T = ease5(c.vt / c.dur)
    const yaw = fit.line + (o.yaw ?? 0) - 55 + 110 * T
    const pose = orbit(f.x, f.y, FLOOR + 55, fit.dist * (1.06 - 0.1 * T), lerp(o.pitch ?? 22, (o.pitch ?? 22) + 10, T), yaw, 38)
    return shake(c, keepInside(c, pose), [o.a, o.v])
  }
}

function lowCam(o: MomentOpts, hitSt: number): (c: CamCtx) => CamPose {
  return (c) => {
    const f = mem(c, 'f', () => new Follow(3.2))
    const line = mem(c, 'line', () => lineDeg(c, o.a, o.v, hitSt))
    const A = c.at(o.a)
    const V = c.at(o.v)
    const sep = Math.hypot(V.x - A.x, V.y - A.y)
    f.update({ x: lerp(A.x, V.x, 0.6), y: lerp(A.y, V.y, 0.6), h: FLOOR }, c.dt)
    const d = mem(c, 'd', () => new Smooth(2)).update(Math.max(680, Math.min(1350, sep * 0.8 + 480)) * (o.zoom ?? 1), c.dt)
    // over the attacker's shoulder, low over the floor, the victim and the lava beyond
    const yaw = line - 90 + 24 + (o.yaw ?? 0) + 4 * c.vt
    return shake(c, keepInside(c, orbit(f.x, f.y, FLOOR + 70, d, o.pitch ?? 13, yaw, 40)), [o.a, o.v])
  }
}

interface Freeze {
  /** shot-clock sim second the freeze lands on */
  st: number
  /** video seconds held frozen */
  hold: number
  low?: number
}

/**
 * Bullet-time envelope (video seconds): ease into slow motion, hold it while the camera
 * starts to move, ease into the freeze, hold, and come back out the same way.
 */
const BT = { into: 0.35, slow: 0.22, slowHold: 0.55, toFreeze: 0.45, toSlow: 0.4, toReal: 0.45 }

function btMarks(hold: number) {
  const slowEnd = BT.into + BT.slowHold
  const frozen = slowEnd + BT.toFreeze
  const thaw = frozen + hold
  const slowAgain = thaw + BT.toSlow
  return { slowEnd, frozen, thaw, slowAgain, end: slowAgain + BT.toReal }
}

/** time scale `u` video seconds into an envelope, or null once it is over */
function envelope(u: number, hold: number, low: number): number | null {
  const k = btMarks(hold)
  if (u < BT.into) return lerp(1, BT.slow, ease(u / BT.into))
  if (u < k.slowEnd) return BT.slow
  if (u < k.frozen) return lerp(BT.slow, low, ease((u - k.slowEnd) / BT.toFreeze))
  if (u < k.thaw) return low
  if (u < k.slowAgain) return lerp(low, BT.slow, ease((u - k.thaw) / BT.toSlow))
  if (u < k.end) return lerp(BT.slow, 1, ease((u - k.slowAgain) / BT.toReal))
  return null
}

/** sim seconds an envelope covers before its freeze: it starts that much earlier */
function envelopeLead(hold: number, low: number): number {
  const k = btMarks(hold)
  let st = 0
  for (let u = 0; u < k.frozen; u += 1 / 600) st += (envelope(u, hold, low) ?? 1) / 600
  return st
}

/**
 * Per-frame time scale of a shot: the sim-time curve `speed` with bullet-time envelopes cut
 * in on the video clock. Returns the video-time curve, the length that covers `simLen` sim
 * seconds, the video second the sim reaches `mark`, and the video second each envelope starts.
 */
function timeline(speed: ((st: number) => number) | undefined, freezes: Freeze[], simLen: number, mark: number) {
  const table: number[] = []
  const starts: number[] = []
  let st = 0
  let vt = 0
  let hit = -1
  let next = 0
  let fz: { start: number; f: Freeze } | null = null
  while (st < simLen - 1e-9 && table.length < 3600) {
    let sp = speed ? speed(st) : 1
    if (!fz && next < freezes.length && st >= freezes[next].st - envelopeLead(freezes[next].hold, freezes[next].low ?? 0) - 1e-9) {
      fz = { start: vt, f: freezes[next] }
      starts.push(vt)
      next++
    }
    if (fz) {
      const e = envelope(vt - fz.start, fz.f.hold, fz.f.low ?? 0)
      if (e === null) fz = null
      else sp = Math.min(sp, e)
    }
    sp = Math.max(0, sp)
    table.push(sp)
    st += sp / 60
    vt += 1 / 60
    if (hit < 0 && st >= mark) hit = vt
  }
  const speedV = (v: number) => table[Math.min(table.length - 1, Math.max(0, Math.round(v * 60)))] ?? 1
  return { speedV, dur: table.length / 60, hit, starts }
}

/**
 * Bullet time: one continuous camera move across the whole envelope. The orbit starts while
 * time slows, sweeps through the freeze (a slight push-in and lower angle) and settles as time
 * comes back, then turns after the victim. The focus glides onto the frozen moment (taken from
 * the dry run, so it never jumps). No shake until time runs again.
 */
function freezeCam(o: MomentOpts, hitSt: number, freezeSt: number, s0: number, hold: number, sweep: number): (c: CamCtx) => CamPose {
  const chase = o.chase ?? 0.6
  const k = btMarks(hold)
  return (c) => {
    const m = mem(c, 'fz', () => {
      const A = posAt(c, o.a, freezeSt)
      const B = posAt(c, o.v, freezeSt)
      const a0 = posAt(c, o.a, hitSt)
      const b0 = posAt(c, o.v, hitSt)
      return { line: lineDeg(c, o.a, o.v, hitSt), at: { x: lerp(A.x, B.x, 0.5), y: lerp(A.y, B.y, 0.5) }, sep: Math.hypot(b0.x - a0.x, b0.y - a0.y) }
    })
    const fol = mem(c, 'f', () => new Follow(4))
    const A = c.at(o.a)
    const V = c.at(o.v)
    const now = { x: lerp(A.x, V.x, 0.5), y: lerp(A.y, V.y, 0.5) }
    const w = ease(span(c.vt, s0, s0 + k.frozen))
    let fx = lerp(now.x, m.at.x, w)
    let fy = lerp(now.y, m.at.y, w)
    if (c.vt > s0 + k.thaw) {
      const q = chase * ease(span(c.vt, s0 + k.thaw, s0 + k.end + 0.4))
      fx = lerp(m.at.x, V.x, q)
      fy = lerp(m.at.y, V.y, q)
    }
    fol.update({ x: fx, y: fy, h: FLOOR }, c.dt)
    const d0 = Math.max(620, Math.min(1250, m.sep * 1.05 + 460)) * (o.zoom ?? 1)
    const u = ease5(span(c.vt, s0 - 0.2, s0 + k.end))
    const bump = Math.sin(Math.PI * u)
    const after = c.vt > s0 + k.thaw ? ease(span(c.vt, s0 + k.thaw, s0 + k.end + 0.8)) : 0
    const yaw = m.line + (o.yaw ?? 0) - sweep / 2 + sweep * u
    const pitch = (o.pitch ?? 34) - 9 * bump
    const pose = keepInside(c, orbit(fol.x, fol.y, FLOOR + 60, d0 * (1 - 0.12 * bump) * (1 + 0.25 * chase * after), pitch, yaw, 38))
    return c.vt > s0 + k.end ? shake(c, pose, [o.a, o.v]) : pose
  }
}

/**
 * Bullet cam: over the caster's shoulder, then riding behind the projectile into the victim;
 * at the impact the camera swings around the impact point (through a freeze when there is
 * one) and follows the victim out.
 */
function bulletCam(o: MomentOpts, hitSt: number, s0: number, hold: number, sweep: number): (c: CamCtx) => CamPose {
  const spell = o.spell ?? 'fireball'
  const marks = btMarks(hold)
  return (c) => {
    const m = mem(c, 'b', () => ({ last: null as V3 | null, dir: null as { x: number; y: number } | null, impact: null as V3 | null, impactVt: 0 }))
    const eye = mem(c, 'eye', () => new Follow(7))
    const look = mem(c, 'look', () => new Follow(7))
    const A = c.at(o.a)
    const V = c.at(o.v)
    const dl = Math.hypot(V.x - A.x, V.y - A.y) || 1
    const toV = { x: (V.x - A.x) / dl, y: (V.y - A.y) / dl }
    const pr = c.st < hitSt + 0.02 ? c.projAt(spell, o.a) : null
    let E: V3
    let L: V3
    if (pr && !m.impact) {
      if (m.last) {
        const dx = pr.x - m.last.x
        const dy = pr.y - m.last.y
        const l = Math.hypot(dx, dy)
        if (l > 0.5) m.dir = { x: dx / l, y: dy / l }
      }
      m.last = { ...pr }
      const d = m.dir ?? toV
      E = { x: pr.x - d.x * 240 - d.y * 80, y: pr.y - d.y * 240 + d.x * 80, h: FLOOR + 150 }
      L = { x: pr.x + d.x * 260, y: pr.y + d.y * 260, h: FLOOR + 60 }
    } else if (!m.last) {
      E = { x: A.x - toV.x * 320 - toV.y * 110, y: A.y - toV.y * 320 + toV.x * 110, h: FLOOR + 200 }
      L = { x: lerp(A.x, V.x, 0.6), y: lerp(A.y, V.y, 0.6), h: FLOOR + 60 }
    } else {
      if (!m.impact) {
        m.impact = { ...m.last }
        m.impactVt = c.vt
      }
      const u = ease5(span(c.vt, m.impactVt, s0 + marks.end))
      const k = ease(span(c.vt, s0 + marks.thaw, s0 + marks.end + 0.6))
      const P = { x: lerp(m.impact.x, V.x, 0.7 * k), y: lerp(m.impact.y, V.y, 0.7 * k), h: FLOOR + 50 }
      const d = m.dir ?? toV
      const travel = (Math.atan2(d.y, d.x) * 180) / Math.PI
      // orbit yaw that looks along the travel direction is travel - 90
      const pose = orbit(P.x, P.y, P.h, 560 * (1 + 0.5 * k), lerp(18, 28, k), travel - 90 - 30 + sweep * u, 38)
      E = { x: pose.x, y: pose.y, h: pose.h }
      L = P
    }
    eye.update(E, c.dt)
    look.update(L, c.dt)
    return keepInside(c, { x: eye.x, y: eye.y, h: eye.h, tx: look.x, ty: look.y, th: look.h, fov: 42 })
  }
}

function holdRound(base?: (s: ShotSim) => void): (s: ShotSim) => void {
  return (s) => {
    base?.(s)
    if (s.state.phase === 'roundEnd') s.state.phaseTicksLeft = 600
  }
}

function moment(o: MomentOpts): ShotSpec {
  const m = trailerMatch(o.match)
  const pre = o.pre ?? 1.6
  const post = o.post ?? 1.6
  const speed = o.flight ? slowmo(pre - o.flight[1], pre, o.flight[0], 0.08) : o.slow ? slowmo(pre - 0.03, pre + o.slow[1], o.slow[0], 0.1) : undefined
  const freezes: Freeze[] = o.freeze ? [{ st: pre + o.freeze.at, hold: o.freeze.hold, low: o.freeze.low }] : []
  const tl = timeline(speed, freezes, pre + post, pre)
  const s0 = tl.starts[0] ?? tl.hit
  const hold = o.freeze?.hold ?? 0
  const sweep = o.freeze?.sweep ?? 140
  const freezeSt = pre + (o.freeze?.at ?? 0)
  const cam = o.cam
  const camera =
    cam === 'freeze'
      ? freezeCam(o, pre, freezeSt, s0, hold, sweep)
      : cam === 'bullet'
        ? bulletCam(o, pre, s0, hold, sweep)
        : cam === 'action'
          ? actionCam(o, pre)
          : cam === 'close'
            ? closeCam(o, pre)
            : cam === 'orbit'
              ? orbitCam(o, pre)
              : cam === 'low'
                ? lowCam(o, pre)
                : cam === 'top'
                  ? stage({ pitch: 68, yawAbs: o.yaw ?? 20, push: 0.05, dolly: 14, backdrop: 0, minPx: 40, box: BOX })
                  : stage({ pitch: o.pitch ?? 50, yawAbs: o.yaw ?? 10, push: 0.07, dolly: 10, backdrop: 0, minPx: 60, box: BOX })
  const overlay: OverlaySpec = { logo: false, plates: o.plates ?? (cam === 'wide' || cam === 'top' || cam === 'action'), nums: false, stamps: false }
  return {
    id: o.id,
    ...m.spec,
    seed: o.seed,
    ffwd: o.hit - pre,
    dur: tl.dur,
    hit: tl.hit,
    // freezes run on the video clock; a plain slow motion on the sim clock as before
    ...(freezes.length > 0 ? { speedV: tl.speedV } : { speed }),
    camera,
    overlay,
    localPlayer: o.a,
    tick: o.hold ? holdRound(m.spec.tick) : m.spec.tick,
  }
}

export const TRAILER_SHOTS: ShotSpec[] = [
  // --- the build: one moment per bar
  {
    // eight Uber bots at the bell: high over the caldera rim, sinking toward the platform
    id: 't_reveal',
    ...trailerMatch('ffa8').spec,
    seed: 8,
    ffwd: 0.2,
    dur: 6,
    hit: 3,
    localPlayer: 0,
    camera(c) {
      const t = c.vt / 6
      const horiz = lerp(2600, 1700, ease5(t))
      const h = lerp(3000, 1250, ease5(t))
      const yaw = lerp(212, 172, ease5(t)) * D2R
      return { x: Math.sin(yaw) * horiz, y: -Math.cos(yaw) * horiz, h, tx: 0, ty: 40, th: FLOOR + 40, fov: 40 }
    },
    overlay: { logo: false, plates: false, nums: false },
  },
  // a Fireball trade: both cast at once, Frostbinder loses it and flies into the lava
  moment({ id: 't_fireball', match: 'ffa8b', seed: 15, hit: 35.02, a: 0, v: 1, cam: 'close', pre: 0.5, post: 1.6, slow: [0.3, 0.2] }),
  moment({ id: 't_lava', match: 'ffa8b', seed: 2, hit: 24.13, a: 4, v: 3, cam: 'low', pre: 0.5, post: 1.7 }),
  moment({ id: 't_scourge', match: 'ffa8b', seed: 1, hit: 140.73, a: 5, v: 6, cam: 'close', pre: 1.1, post: 1.3, slow: [0.25, 0.15], pitch: 12 }),
  moment({ id: 't_lightning', match: 'ffa8', seed: 16, hit: 38.58, a: 4, v: 3, cam: 'orbit', pre: 0.9, post: 1.3, slow: [0.12, 0.12] }),
  moment({ id: 't_meteor', match: 'ffa8', seed: 3, hit: 32.2, a: 7, v: 0, also: [2], cam: 'action', pre: 1.7, post: 1.4, slow: [0.25, 0.18] }),
  // --- the drop: fast cuts
  moment({ id: 't_homing', match: 'ffa8', seed: 5, hit: 103.37, a: 2, v: 3, cam: 'action', pre: 0.6, post: 1.2 }),
  moment({ id: 't_boomerang', match: 'ffa8b', seed: 9, hit: 139.9, a: 2, v: 3, cam: 'action', pre: 1.0, post: 1.2 }),
  moment({ id: 't_cluster', match: 'ffa8b', seed: 14, hit: 44.8, a: 0, v: 4, cam: 'low', pre: 0.9, post: 1.3, slow: [0.3, 0.12] }),
  moment({ id: 't_snowball', match: 'ffa8', seed: 16, hit: 22.67, a: 6, v: 0, also: [1, 7], cam: 'action', pre: 1.4, post: 1.3 }),
  moment({ id: 't_thrust', match: 'ffa6', seed: 12, hit: 134.67, a: 3, v: 5, cam: 'close', pre: 0.7, post: 1.3 }),
  moment({ id: 't_recharge', match: 'ffa6', seed: 1, hit: 138.65, a: 1, v: 3, cam: 'action', pre: 0.9, post: 1.3 }),
  moment({ id: 't_splitter', match: 'ffa8b', seed: 3, hit: 66.4, a: 2, v: 5, cam: 'action', pre: 1.0, post: 1.2 }),
  moment({ id: 't_bouncer', match: 'ffa8b', seed: 1, hit: 106.33, a: 2, v: 4, cam: 'low', pre: 0.9, post: 1.3 }),
  moment({ id: 't_twin', match: 'ffa8b', seed: 1, hit: 149.98, a: 0, v: 7, cam: 'action', pre: 0.9, post: 1.2 }),
  moment({ id: 't_combo', match: 'ffa8b', seed: 15, hit: 138.13, a: 1, v: 1, cam: 'wide', pre: 1.0, post: 1.2, slow: [0.2, 0.1] }),
  moment({ id: 't_gravity', match: 'ffa8b', seed: 5, hit: 47.93, a: 4, v: 3, cam: 'action', pre: 1.5, post: 1.2 }),
  moment({ id: 't_warpzone', match: 'ffa8', seed: 1, hit: 43.77, a: 3, v: 4, also: [7], cam: 'action', pre: 1.4, post: 1.0 }),
  moment({ id: 't_link', match: 'ffa8', seed: 1, hit: 45.97, a: 0, v: 4, cam: 'action', pre: 0.9, post: 1.2 }),
  moment({ id: 't_rockpillar', match: 'ffa8b', seed: 9, hit: 25.85, a: 2, v: 7, cam: 'action', pre: 0.8, post: 1.2 }),
  moment({ id: 't_swap', match: 'ffa8', seed: 5, hit: 27.68, a: 5, v: 7, cam: 'action', pre: 1.4, post: 1.0 }),
  moment({ id: 't_grip', match: 'ffa8b', seed: 13, hit: 48.83, a: 5, v: 1, cam: 'action', pre: 1.3, post: 1.1 }),
  moment({ id: 't_drain', match: 'ffa8b', seed: 6, hit: 49.58, a: 5, v: 3, cam: 'close', pre: 0.8, post: 1.2 }),
  moment({ id: 't_escape', match: 'ffa8b', seed: 8, hit: 38.73, a: 6, v: 6, cam: 'wide', pre: 1.4, post: 1.0 }),
  moment({ id: 't_chaos', match: 'ffa8b', seed: 15, hit: 136.5, a: 7, v: 2, cam: 'top', pre: 2.0, post: 2.0 }),
  // --- second pass (2026-10-19): cleaner knockouts, more arenas and close-ups
  moment({ id: 't_lava2', match: 'ffa6', seed: 8, hit: 137.48, a: 0, v: 4, cam: 'action', pre: 0.8, post: 1.4, zoom: 0.8 }),
  moment({ id: 't_scourge2', match: 'ffa8b', seed: 11, hit: 107.53, a: 4, v: 2, cam: 'close', pre: 1.2, post: 1.3, slow: [0.3, 0.15] }),
  moment({ id: 't_scourge3', match: 'ffa6', seed: 13, hit: 133.53, a: 0, v: 5, cam: 'orbit', pre: 1.1, post: 1.3, slow: [0.2, 0.12] }),
  moment({ id: 't_scourge4', match: 'ffa8', seed: 6, hit: 144.73, a: 1, v: 6, cam: 'close', pre: 1.1, post: 0.9 }),
  moment({ id: 't_fire2', match: 'ffa6', seed: 10, hit: 133.47, a: 3, v: 5, cam: 'close', pre: 0.7, post: 1.0 }),
  moment({ id: 't_fire3', match: 'ffa8', seed: 13, hit: 118.17, a: 4, v: 5, cam: 'low', pre: 0.7, post: 1.0 }),
  moment({ id: 't_fire4', match: 'ffa6', seed: 16, hit: 145.95, a: 5, v: 1, cam: 'orbit', pre: 0.8, post: 1.0, slow: [0.25, 0.1] }),
  moment({ id: 't_homing2', match: 'ffa6', seed: 6, hit: 101.08, a: 1, v: 0, cam: 'action', pre: 0.9, post: 1.0 }),
  moment({ id: 't_bouncer2', match: 'ffa8', seed: 11, hit: 124.33, a: 5, v: 7, cam: 'action', pre: 0.9, post: 1.0, zoom: 0.85 }),
  moment({ id: 't_lightning2', match: 'ffa6', seed: 9, hit: 22.25, a: 3, v: 4, cam: 'close', pre: 0.5, post: 1.0 }),
  moment({ id: 't_lightning3', match: 'ffa8b', seed: 10, hit: 133.38, a: 1, v: 7, cam: 'action', pre: 0.5, post: 1.1 }),
  moment({ id: 't_boomerang2', match: 'ffa6', seed: 13, hit: 114.0, a: 0, v: 2, cam: 'action', pre: 1.0, post: 0.9 }),
  moment({ id: 't_thrust2', match: 'ffa6', seed: 5, hit: 44.5, a: 3, v: 1, cam: 'close', pre: 0.5, post: 1.2 }),
  moment({ id: 't_thrust3', match: 'ffa8', seed: 11, hit: 34.48, a: 7, v: 6, cam: 'low', pre: 0.5, post: 1.1 }),
  moment({ id: 't_recharge2', match: 'ffa8b', seed: 16, hit: 26.43, a: 7, v: 3, cam: 'action', pre: 0.9, post: 0.9 }),
  moment({ id: 't_twin2', match: 'ffa6', seed: 7, hit: 116.48, a: 2, v: 1, cam: 'action', pre: 0.9, post: 0.9 }),
  moment({ id: 't_meteor2', match: 'ffa8', seed: 1, hit: 33.38, a: 4, v: 5, cam: 'orbit', pre: 1.6, post: 1.0, slow: [0.3, 0.12] }),
  moment({ id: 't_splitter2', match: 'ffa8b', seed: 14, hit: 133.28, a: 5, v: 3, cam: 'action', pre: 0.9, post: 1.0 }),
  moment({ id: 't_cluster2', match: 'ffa8b', seed: 3, hit: 135.87, a: 0, v: 6, cam: 'close', pre: 0.6, post: 0.9 }),
  moment({ id: 't_drain2', match: 'duel', seed: 13, hit: 31.53, a: 0, v: 1, cam: 'close', pre: 0.7, post: 1.2, zoom: 0.75 }),
  moment({ id: 't_duel', match: 'duel', seed: 4, hit: 125.83, a: 0, v: 1, cam: 'orbit', pre: 0.8, post: 1.2, slow: [0.25, 0.12] }),
  moment({ id: 't_ffa_wide', match: 'ffa8', seed: 16, hit: 22.67, a: 6, v: 0, cam: 'wide', pre: 2.0, post: 1.5 }),
  moment({ id: 't_top2', match: 'ffa8b', seed: 15, hit: 37.63, a: 7, v: 0, cam: 'top', pre: 2.0, post: 1.5 }),
  moment({ id: 't_esc2', match: 'ffa8', seed: 2, hit: 124.83, a: 3, v: 3, cam: 'action', pre: 1.2, post: 0.8 }),
  moment({ id: 't_esc3', match: 'ffa8b', seed: 5, hit: 39.03, a: 0, v: 0, cam: 'close', pre: 1.0, post: 0.8 }),
  moment({ id: 't_multi2', match: 'ffa6', seed: 9, hit: 40.75, a: 2, v: 1, cam: 'close', pre: 0.6, post: 1.0 }),
  moment({ id: 't_final_pre', match: 'ffa8', seed: 8, hit: 61.63, a: 6, v: 3, cam: 'action', pre: 1.2, post: 1.0 }),
  // --- third pass: round-one replacements for takes whose bot match diverged in the browser
  // (bots aim with Math.* trig, which can differ between Node and Chrome over a long fast-forward)
  moment({ id: 't_scourge5', match: 'ffa8b', seed: 13, hit: 64.13, a: 5, v: 2, cam: 'close', pre: 1.3, post: 1.3, slow: [0.3, 0.15], zoom: 0.75 }),
  moment({ id: 't_scourge6', match: 'ffa8', seed: 13, hit: 57.23, a: 7, v: 3, cam: 'orbit', pre: 1.1, post: 1.2, slow: [0.2, 0.12] }),
  moment({ id: 't_scourge7', match: 'ffa8b', seed: 9, hit: 27.03, a: 5, v: 6, cam: 'close', pre: 1.1, post: 1.0 }),
  moment({ id: 't_bouncer3', match: 'ffa4', seed: 8, hit: 40.33, a: 3, v: 0, cam: 'action', pre: 0.9, post: 1.0 }),
  moment({ id: 't_boomerang3', match: 'ffa8', seed: 13, hit: 44.88, a: 1, v: 2, cam: 'action', pre: 1.0, post: 0.9 }),
  moment({ id: 't_lightning4', match: 'ffa8', seed: 6, hit: 24.15, a: 0, v: 6, cam: 'action', pre: 0.5, post: 1.2 }),
  moment({ id: 't_fire5', match: 'ffa8b', seed: 14, hit: 37.72, a: 4, v: 5, cam: 'close', pre: 0.7, post: 1.0 }),
  moment({ id: 't_fire6', match: 'ffa8b', seed: 16, hit: 33.95, a: 7, v: 4, cam: 'orbit', pre: 0.8, post: 1.0, slow: [0.25, 0.1] }),
  moment({ id: 't_chaos2', match: 'ffa8', seed: 8, hit: 55.0, a: 6, v: 3, cam: 'top', pre: 2.0, post: 2.0 }),
  moment({ id: 't_cluster3', match: 'ffa8', seed: 15, hit: 20.52, a: 3, v: 4, cam: 'close', pre: 0.6, post: 0.9 }),
  // --- v2 (2026-10-19): bullet time and a bullet cam
  // a long Fireball (0.45 s flight) frozen mid-air on its way in, then the knockout into the lava
  moment({ id: 't_fireball_fz', match: 'ffa8', seed: 10, hit: 38.98, a: 4, v: 6, cam: 'freeze', pre: 1.1, post: 2.0, freeze: { at: -0.2, hold: 1.4, sweep: 70 } }),
  moment({ id: 't_lightning_fz', match: 'ffa8', seed: 16, hit: 38.58, a: 4, v: 3, cam: 'freeze', pre: 0.9, post: 1.3, freeze: { at: 0.02, hold: 1.5, sweep: 140 } }),
  // a Homing missile ridden into its target, frozen on the impact
  moment({ id: 't_bullet_homing', match: 'ffa6', seed: 6, hit: 101.08, a: 1, v: 0, cam: 'bullet', spell: 'homing', pre: 0.8, post: 1.2, freeze: { at: 0.0, hold: 1.0, sweep: 100 } }),
  // knockback x2.3: frozen on the hit, then the camera chases the victim deep into the lava
  moment({ id: 't_flight', match: 'ffa6', seed: 8, hit: 137.48, a: 0, v: 4, cam: 'freeze', pre: 0.8, post: 1.0, freeze: { at: -0.04, hold: 1.0, sweep: 80 }, chase: 1 }),
  // the final Scourge: frozen in the blast, both warlocks in frame, then the fall
  moment({ id: 't_final_fz', match: 'ffa8', seed: 8, hit: 65.23, a: 6, v: 3, cam: 'freeze', pre: 1.4, post: 2.8, freeze: { at: 0.03, hold: 1.6, sweep: 150 }, hold: true }),
  // --- the finale: the last two on a three-ring platform (ffa8 seed 8)
  moment({ id: 't_final_a', match: 'ffa8', seed: 8, hit: 62.83, a: 3, v: 6, cam: 'action', pre: 1.0, post: 1.6, yaw: -20 }),
  moment({ id: 't_final_tp', match: 'ffa8', seed: 8, hit: 64.13, a: 6, v: 3, cam: 'close', pre: 0.5, post: 1.0 }),
  moment({ id: 't_final_b', match: 'ffa8', seed: 8, hit: 65.23, a: 6, v: 3, cam: 'orbit', pre: 1.6, post: 1.4, slow: [0.15, 0.2], hold: true }),
  {
    // the winner alone on what is left of the platform: plate for the end card
    ...moment({ id: 't_end', match: 'ffa8', seed: 8, hit: 66.0, a: 6, v: 6, cam: 'low', pre: 0.2, post: 7.0, hold: true }),
    camera(c) {
      const P = c.at(6)
      const T = ease5(c.vt / c.dur)
      return orbit(P.x, P.y, FLOOR + 80, lerp(700, 1100, T), lerp(12, 22, T), lerp(150, 215, T), 40)
    },
  },
]
