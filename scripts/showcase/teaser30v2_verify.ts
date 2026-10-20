/** Prove the filmed action and Matrix camera before accepting an export. */
import { readFileSync, writeFileSync } from 'node:fs'
import { collectAction } from '../../src/render/showcase/action'
import { FLOOR } from '../../src/render/showcase/cam'
import { TEASER30V2_SHOTS } from '../../src/render/showcase/shots/teaser30v2'
import { ShotSim } from '../../src/render/showcase/simShot'
import { speedAt, type CamCtx } from '../../src/render/showcase/types'
import type { SimEvent } from '../../src/sim/types'

const ids = ['s32_lineup', 's32_arena', 's32_ring', 's32_matrix', 's32_unload', 's32_meteors', 's32_battle', 's32_final', 's32_winner']
const results = []
for (const id of ids) {
  const spec = TEASER30V2_SHOTS.find(s => s.id === id)!
  const sim = new ShotSim(spec)
  const events: { vt: number; event: SimEvent }[] = []
  const ctx: CamCtx = { vt: 0, st: 0, dt: 1 / 60, dur: spec.dur, sim, action: collectAction(spec), mem: {},
    at(owner) { const p = sim.pawn(owner); return { x: p.x, y: p.y, h: FLOOR } },
    projAt(spell, owner, kind) { const p = sim.proj(spell, owner, kind); return p ? { x: p.x, y: p.y, h: 70 } : null },
  }
  let previousYaw = 0, sweep = 0, started = false, minSpeed = 1
  const steps = spec.renderSubsteps ?? 1
  for (let f = 0; f < Math.round(spec.dur * 60); f++) {
    for (let j = 0; j < steps; j++) {
      const vt = (f + j / steps) / 60
      const speed = speedAt(spec, vt, ctx.st)
      minSpeed = Math.min(minSpeed, speed)
      ctx.st += speed / (60 * steps)
      while (sim.state.tick - sim.t0 < Math.ceil(ctx.st * 60 - 1e-6)) {
        for (const event of sim.stepOnce()) events.push({ vt, event })
      }
    }
    ctx.vt = (f + 1) / 60
    const p = spec.camera(ctx)
    if (!Object.values(p).every(Number.isFinite)) throw new Error(`${id}: invalid camera pose`)
    const yaw = Math.atan2(p.x - p.tx, -(p.y - p.ty))
    if (started) sweep += Math.atan2(Math.sin(yaw - previousYaw), Math.cos(yaw - previousYaw))
    previousYaw = yaw; started = true
  }
  const casts = events.filter(e => e.event.type === 'cast').map(e => e.event.type === 'cast' ? e.event.spell : '')
  const deaths = events.filter(e => e.event.type === 'death')
  const meta = JSON.parse(readFileSync(`media/trailer/teaser30/v2/shots/${id}.json`, 'utf8'))
  if (meta.errors.length || meta.frames !== Math.round(spec.dur * 60)) throw new Error(`${id}: incomplete/error capture`)
  if (id === 's32_lineup' && new Set(casts).size !== 10) throw new Error('Opening must release ten distinct spells')
  if (id === 's32_ring' && deaths.length !== 8) throw new Error('Scourge ring must produce eight real deaths')
  if (id === 's32_matrix' && (Math.abs(sweep * 180 / Math.PI - 360) > 1 || minSpeed <= 0 || steps !== 4)) throw new Error('Matrix take needs a full orbit and continuous substepped time')
  if (id === 's32_arena' && (minSpeed < .25 || ctx.st < .9)) throw new Error('Arena reveal must show ongoing slow action')
  if (id === 's32_winner' && !events.some(e => e.event.type === 'roundWin' && e.event.players.includes(0))) throw new Error('Winner celebration never triggered')
  if (id === 's32_unload' && !events.some(e => e.event.type === 'modifier' && e.event.id === 'grip' && e.event.on)) throw new Error('Grip missed')
  if (id === 's32_meteors' && !deaths.some(e => e.event.type === 'death' && e.event.cause === 'meteor')) throw new Error('Meteor kill missing')
  if (id === 's32_battle') {
    const ricochets = events.filter(e => e.event.type === 'damage' && e.event.cause === 'bouncer')
    const thrust = events.some(e => e.event.type === 'spellHit' && e.event.spell === 'thrust')
    if (!thrust || ricochets.length < 2 || deaths.filter(e => e.vt >= .35 && e.vt < .35 + 8 * 60 / 143.75).length < 3) throw new Error('Battle needs the Thrust hit, two Bouncer hits and three visible kills before the cut')
  }
  if (id === 's32_final' && (!deaths.some(e => e.vt < 2.5 && e.event.type === 'death' && e.event.cause === 'lava') || !sim.pawn(0).alive)) throw new Error('Final needs a visible kill before the survivor close-up')
  results.push({ id, casts, deaths: deaths.map(e => e.vt), orbitDegrees: sweep * 180 / Math.PI, minSpeed, renderSubsteps: steps, frames: meta.frames, renderErrors: meta.errors })
  console.log(`${id}: ${meta.frames} frames, ${casts.length} casts, ${deaths.length} deaths, ${id === 's32_matrix' ? `${(sweep * 180 / Math.PI).toFixed(2)}° orbit` : 'capture complete'}`)
}
writeFileSync('media/trailer/teaser30/v2/simulation-checks.json', JSON.stringify(results, null, 2) + '\n')
