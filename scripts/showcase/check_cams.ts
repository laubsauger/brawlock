/**
 * Camera sanity check for every shot, without rendering: camera inside the caldera rim,
 * warlocks at least ~60 px tall (1080p), the action in frame.
 *   npx vite-node scripts/showcase/check_cams.ts [shotId]
 */
import { collectAction } from '../../src/render/showcase/action'
import { FLOOR, project } from '../../src/render/showcase/cam'
import { ShotSim } from '../../src/render/showcase/simShot'
import { SHOTS } from '../../src/render/showcase/shots'
import { rimRadius } from '../../src/render/showcase/shots/common'
import type { CamCtx } from '../../src/render/showcase/types'

const only = process.argv[2]
for (const spec of SHOTS) {
  if (only && spec.id !== only) continue
  const action = collectAction(spec)
  const sim = new ShotSim(spec)
  const ctx: CamCtx = { vt: 0, st: 0, dt: 1 / 60, dur: spec.dur, sim, mem: {}, action, at: () => ({ x: 0, y: 0, h: FLOOR }), projAt: () => null }
  const rim = rimRadius(ctx)
  let worst = Infinity
  let outside = 0
  let st = 0
  const notes: string[] = []
  for (let k = 0; k < Math.round(spec.dur * 60); k++) {
    const s = spec.speed ? spec.speed(st) : 1
    st += s / 60
    while (sim.state.tick - sim.t0 < Math.ceil(st * 60 - 1e-6)) sim.stepOnce()
    ctx.vt = (k + 1) / 60
    ctx.st = st
    const pose = spec.camera(ctx)
    const r = Math.hypot(pose.x, pose.y)
    if (r > rim && pose.h < 2700) outside++
    for (const p of sim.state.pawns) {
      if (!p.alive || sim.hidden.has(p.owner)) continue
      const a = project(pose, 16 / 9, p.x, p.y, FLOOR)
      const b = project(pose, 16 / 9, p.x, p.y, FLOOR + 130)
      if (Math.abs(a.x) > 1 || Math.abs(a.y) > 1) continue
      worst = Math.min(worst, ((b.y - a.y) / 2) * 1080)
    }
  }
  if (outside > 0) notes.push(`camera outside rim on ${outside} frames`)
  if (worst < 55) notes.push(`smallest on-screen warlock ${worst.toFixed(0)} px`)
  console.log(`${spec.id.padEnd(16)} rim ${rim.toFixed(0)} minPawn ${Number.isFinite(worst) ? worst.toFixed(0) : '-'}px ${notes.join('; ')}`)
}
