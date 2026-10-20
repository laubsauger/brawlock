/** Verify the staged action and continuous camera paths before spending time capturing. */
import { writeFileSync } from 'node:fs'
import { collectAction } from '../../src/render/showcase/action'
import { FLOOR, project } from '../../src/render/showcase/cam'
import { TEASER30_SHOTS } from '../../src/render/showcase/shots/teaser30'
import { ShotSim } from '../../src/render/showcase/simShot'
import { speedAt, type CamCtx } from '../../src/render/showcase/types'

const report = []
for (const spec of TEASER30_SHOTS) {
  const sim = new ShotSim(spec)
  const action = collectAction(spec)
  const c: CamCtx = {
    vt: 0, st: 0, dt: 1 / 60, dur: spec.dur, sim, action, mem: {},
    at(owner) { const p = sim.pawn(owner); return { x: p.x, y: p.y, h: FLOOR } },
    projAt(spell, owner, kind) { const p = sim.proj(spell, owner, kind); return p ? { x: p.x, y: p.y, h: FLOOR + 70 } : null },
  }
  let previous = spec.camera(c)
  let maxStep = 0
  let maxAcceleration = 0
  let lastDelta = 0
  const events = []
  const edge = []
  for (let k = 1; k <= Math.round(spec.dur * 60); k++) {
    c.st += speedAt(spec, (k - 1) / 60, c.st) / 60
    while (sim.state.tick - sim.t0 < Math.ceil(c.st * 60 - 1e-6)) {
      for (const e of sim.stepOnce()) {
        if (e.type === 'explosion' || e.type === 'beam' || e.type === 'damage' && e.kb > 0 || e.type === 'modifier' && e.id === 'grip' && e.on) events.push({ vt: k / 60, ...e })
      }
    }
    c.vt = k / 60
    const p = spec.camera(c)
    const delta = Math.hypot(p.x - previous.x, p.y - previous.y, p.h - previous.h)
    maxStep = Math.max(maxStep, delta)
    maxAcceleration = Math.max(maxAcceleration, Math.abs(delta - lastDelta))
    previous = p; lastDelta = delta
    if (spec.id !== 's30_arena' && spec.id !== 's30_battle') {
      for (const q of sim.curr.pawns) {
        if (!q.alive) continue
        const pos = project(p, 16 / 9, q.x, q.y, FLOOR + 70)
        if (Math.abs(pos.x) > .94 || Math.abs(pos.y) > .78) edge.push({ vt: c.vt, owner: q.owner, x: pos.x, y: pos.y })
      }
    }
  }
  if (maxStep > 8 || maxAcceleration > 1) throw new Error(`${spec.id}: camera discontinuity (${maxStep}, ${maxAcceleration})`)
  if (edge.length) throw new Error(`${spec.id}: featured pawn leaves the composition on ${edge.length} frames`)
  const row = { id: spec.id, maxStep, maxAcceleration, events, edge }
  report.push(row)
  console.log(`${spec.id}: max camera step ${maxStep.toFixed(3)}, acceleration ${maxAcceleration.toFixed(3)}, edge frames ${edge.length}`)
  for (const e of events) if (e.type === 'explosion') console.log(`  ${e.vt.toFixed(3)} ${e.spell} @ ${e.x.toFixed(1)}, ${e.y.toFixed(1)}`)
}
writeFileSync('media/trailer/teaser30/simulation-checks.json', JSON.stringify(report, null, 1))
const byId = (id: string) => report.find(s => s.id === id)!
if (!byId('s30_combo').events.some(e => e.type === 'explosion' && e.spell === 'lightning')) throw new Error('Missing Fireball detonation')
if (!byId('s30_grip').events.some(e => e.type === 'modifier')) throw new Error('Grip missed')
if (!byId('s30_snowball').events.some(e => e.type === 'damage' && e.cause === 'snowball')) throw new Error('Snowball missed')
if (byId('s30_scourge').events.filter(e => e.type === 'damage' && e.cause === 'scourge').length !== 3) throw new Error('Scourge needs three visible hits')
