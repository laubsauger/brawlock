/**
 * Hover-card clip planner: for each ability shot, picks a 2-3 s window (cast -> impact ->
 * reaction) and a 16:9 crop of the recorded 1920x1080 take that keeps the action (pawns,
 * projectiles, blast radii, replayed exactly as the director drove them) and stays clear of
 * the burned-in overlays (wordmark, lower third, column card). Writes the plan JSON that
 * hovercards.mjs encodes; offsets in it can be tweaked by hand.
 *   npx vite-node scripts/showcase/hovercards_plan.ts <out.json>
 */
import { writeFileSync } from 'node:fs'
import { collectAction } from '../../src/render/showcase/action'
import { FLOOR, project, type CamPose } from '../../src/render/showcase/cam'
import { ShotSim } from '../../src/render/showcase/simShot'
import { SHOTS } from '../../src/render/showcase/shots'
import type { CamCtx, LowerThird } from '../../src/render/showcase/types'

const ABILITIES = [
  'kit_fireball', 'kit_scourge',
  'c1_boomerang', 'c1_lightning', 'c1_homing', 'c1_twin',
  'c2_teleport', 'c2_thrust', 'c2_swap',
  'c3_cluster', 'c3_drain', 'c3_bouncer', 'c3_recharge',
  'c4_windwalk', 'c4_meteor', 'c4_splitter', 'c4_snowball',
  'c5_shield', 'c5_rush', 'c5_alteration',
  'c6_gravity', 'c6_grip', 'c6_warpzone', 'c6_magnetize', 'c6_rockpillar', 'c6_link',
  'it_redirector', 'it_pact',
]
/** shots whose subject is the caster's own move: key on that event, keep every pawn in frame */
const CASTER_MOVE: Record<string, string> = { c2_teleport: 'teleport', c2_swap: 'swap', c5_alteration: 'swap' }
const W = 1920
const H = 1080
const MIN_W = 560

interface Rect {
  x: number
  y: number
  w: number
  h: number
}
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

function lowerZone(l: LowerThird | undefined): Rect {
  if (!l) return { x: 0, y: 0, w: 0, h: 0 }
  // burned-in lower third: kicker 19 px caps, title 84 px Metal Mania, line 29 px Barlow
  const w = Math.max(l.name.length * 40, l.line.length * 13.8, l.kicker.length * 17) + 40
  return { x: 60, y: 812, w, h: 190 }
}

const out: unknown[] = []
for (const id of ABILITIES) {
  const spec = SHOTS.find((s) => s.id === id)!
  const action = collectAction(spec)
  const sim = new ShotSim(spec)
  const ctx: CamCtx = { vt: 0, st: 0, dt: 1 / 60, dur: spec.dur, sim, mem: {}, action, at: () => ({ x: 0, y: 0, h: FLOOR }), projAt: () => null }
  const frames = Math.round(spec.dur * 60)
  const poses: CamPose[] = []
  const pts: { k: number; x: number; y: number; h: number; o?: number }[] = []
  const evs: { vt: number; type: string; e: Record<string, unknown> }[] = []
  let st = 0
  for (let k = 1; k <= frames; k++) {
    st += (spec.speed ? spec.speed(st) : 1) / 60
    while (sim.state.tick - sim.t0 < Math.ceil(st * 60 - 1e-6)) {
      for (const e of sim.stepOnce()) evs.push({ vt: (k - 1) / 60, type: e.type, e: e as unknown as Record<string, unknown> })
    }
    ctx.vt = k / 60
    ctx.st = st
    poses.push(spec.camera(ctx))
    for (const p of sim.state.pawns) {
      if (sim.hidden.has(p.owner) || !p.alive) continue
      pts.push({ k, x: p.x, y: p.y, h: FLOOR, o: p.owner }, { k, x: p.x, y: p.y, h: FLOOR + 150, o: p.owner })
    }
    for (const p of sim.state.projectiles) {
      const r = Math.min(p.radius, 300)
      pts.push({ k, x: p.x - r, y: p.y, h: 70 }, { k, x: p.x + r, y: p.y, h: 70 }, { k, x: p.x, y: p.y - r, h: 70 }, { k, x: p.x, y: p.y + r, h: 70 })
    }
  }
  for (const v of evs) {
    if (v.type === 'death') pts.push({ k: Math.round(v.vt * 60) + 1, x: Number(v.e.x), y: Number(v.e.y), h: FLOOR + 210, o: Number(v.e.owner) })
    if (v.type === 'explosion') {
      const r = Math.min(Number(v.e.radius), 320)
      const k = Math.round(v.vt * 60) + 1
      for (let a = 0; a < 8; a++) pts.push({ k, x: Number(v.e.x) + Math.cos((a / 8) * 6.283) * r, y: Number(v.e.y) + Math.sin((a / 8) * 6.283) * r, h: FLOOR })
    }
  }
  // window: from just before the first cast to ~0.9 s after the impact, 2-3 s long
  const firstCast = evs.find((v) => v.type === 'castStart' || v.type === 'cast')?.vt ?? 0.2
  const death = evs.find((v) => v.type === 'death')
  const hit = [...evs].reverse().find((v) => v.type === 'damage' && Number(v.e.kb) > 0)
  const other = evs.find((v) => v.type === 'swap' || v.type === 'teleport' || v.type === 'shieldReflect' || v.type === 'spellHit')
  const move = CASTER_MOVE[id] ? evs.find((v) => v.type === CASTER_MOVE[id]) : undefined
  const key = move ? move.vt + 0.35 : (death?.vt ?? hit?.vt ?? other?.vt ?? firstCast + 1.2)
  let t0 = Math.max(0, firstCast - 0.25)
  let t1 = key + 0.9
  if (t1 - t0 > 3) t0 = t1 - 3
  if (t1 - t0 < 2) t1 = t0 + 2
  if (t1 > spec.dur) {
    t0 = Math.max(0, t0 - (t1 - spec.dur))
    t1 = spec.dur
  }
  // screen bounds of the action between two video times
  // pawns that get hit or die: the impact focus keeps them and the projectiles, not the caster
  const victims = new Set<number>()
  if (!CASTER_MOVE[id]) for (const v of evs) {
    if (v.type === 'death') victims.add(Number(v.e.owner))
    if (v.type === 'damage' && Number(v.e.kb) > 0) {
      const pw = sim.state.pawns.find((q) => q.id === Number(v.e.target))
      if (pw) victims.add(pw.owner)
    }
  }
  const box = (from: number, to: number, onlyVictims = false) => {
    const bb = { x0: W, y0: H, x1: 0, y1: 0 }
    for (const p of pts) {
      const vt = p.k / 60
      if (vt < from || vt > to) continue
      if (onlyVictims && victims.size > 0 && p.o !== undefined && !victims.has(p.o)) continue
      const q = project(poses[p.k - 1], W / H, p.x, p.y, p.h)
      if (q.z <= 1) continue
      const sx = ((q.x + 1) / 2) * W
      const sy = ((1 - q.y) / 2) * H
      if (sx < -200 || sx > W + 200 || sy < -200 || sy > H + 200) continue
      bb.x0 = Math.min(bb.x0, sx)
      bb.x1 = Math.max(bb.x1, sx)
      bb.y0 = Math.min(bb.y0, sy)
      bb.y1 = Math.max(bb.y1, sy)
    }
    return bb
  }
  const zones: Rect[] = [{ x: 30, y: 20, w: 240, h: 85 }, lowerZone(Array.isArray(spec.overlay?.lower) ? spec.overlay?.lower[0] : spec.overlay?.lower)]
  const card = spec.overlay?.card
  if (card && t0 < card.until && t1 > card.at) zones.push({ x: 380, y: 95, w: 1160, h: 250 })
  type BB = { x0: number; y0: number; x1: number; y1: number }
  const tryFit = (bb: BB, margin: number): { rect: Rect; clean: boolean; bad: number } => {
    const { x0, y0, x1, y1 } = bb
    let w = Math.max(MIN_W, (x1 - x0) * (1 + 2 * margin), (y1 - y0) * (1 + 2 * margin) * (16 / 9))
    w = Math.min(W, w)
    const h = (w * 9) / 16
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    let best: { rect: Rect; clean: boolean; bad: number } | null = null
    // every placement that keeps the action box inside the crop (and the crop inside the frame)
    for (let x = Math.max(0, x1 - w); x <= Math.min(W - w, x0) + 1e-6; x += 8) {
      for (let y = Math.max(0, y1 - h); y <= Math.min(H - h, y0) + 1e-6; y += 8) {
        const r = { x, y, w, h }
        const bad = zones.reduce((n, z) => n + (overlap(r, z) ? 1 : 0), 0)
        const d = Math.hypot(x + w / 2 - cx, y + h / 2 - cy) + bad * 1e6
        if (!best || d < best.bad) best = { rect: r, clean: bad === 0, bad: d }
      }
    }
    if (!best) {
      const r = { x: Math.min(W - w, Math.max(0, cx - w / 2)), y: Math.min(H - h, Math.max(0, cy - h / 2)), w, h }
      const bad = zones.reduce((n, z) => n + (overlap(r, z) ? 1 : 0), 0)
      best = { rect: r, clean: bad === 0, bad }
    }
    return best
  }
  const fitBox = (bb: BB): { rect: Rect; clean: boolean; cut: number } => {
    for (const m of [0.08, 0.03, 0]) {
      const f = tryFit(bb, m)
      if (f.clean) return { rect: f.rect, clean: true, cut: 0 }
    }
    // let the crop clip up to 70 px off the bottom of the action box (feet / ground) to clear the caption
    for (let cut = 10; cut <= 70; cut += 10) {
      const f = tryFit({ ...bb, y1: bb.y1 - cut }, 0)
      if (f.clean) return { rect: f.rect, clean: true, cut }
    }
    return { rect: tryFit(bb, 0.03).rect, clean: false, cut: 0 }
  }
  const MAX_W = 1150
  const full = box(t0, Math.min(t1, key + 0.55))
  const focus = box(Math.max(t0, key - 0.45), Math.min(t1, key + 0.55), true)
  const needW = (bb: BB) => Math.max((bb.x1 - bb.x0) * 1.06, (bb.y1 - bb.y0) * 1.06 * (16 / 9))
  let fit = needW(full) <= MAX_W ? fitBox(full) : { rect: { x: 0, y: 0, w: 0, h: 0 }, clean: false, cut: 0 }
  let note: string | null = fit.clean ? 'cast to reaction' : null
  if (!fit.clean) {
    fit = fitBox(focus)
    note = fit.clean ? 'impact focus (approach, hit, reaction; caster may be out of frame)' : null
  }
  if (fit.clean && fit.cut > 0) note += `; bottom ${fit.cut} px of the action box cut to clear the caption`
  const r = fit.rect
  const { x0, y0, x1, y1 } = fit.clean && note?.startsWith('cast') ? full : focus
  const even = (v: number) => Math.round(v / 2) * 2
  out.push({
    id,
    t0: Number(t0.toFixed(3)),
    t1: Number(t1.toFixed(3)),
    key: Number(key.toFixed(3)),
    crop: { x: even(r.x), y: even(r.y), w: even(r.w), h: even((even(r.w) * 9) / 16) },
    action: { x0: Math.round(x0), y0: Math.round(y0), x1: Math.round(x1), y1: Math.round(y1) },
    flag: fit.clean ? null : 'action overlaps a burned-in overlay (lower third / wordmark / card): no clean crop',
    note,
  })
  console.log(`${id.padEnd(15)} ${t0.toFixed(2)}-${t1.toFixed(2)}s crop ${even(r.w)}x${even((even(r.w) * 9) / 16)}+${even(r.x)}+${even(r.y)}${fit.clean ? '' : '  FLAG'}${note ? '  ' + note : ''}`)
}
writeFileSync(process.argv[2] ?? 'hovercards.json', JSON.stringify(out, null, 1))
