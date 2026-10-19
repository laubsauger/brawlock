/**
 * Trailer cue sheet: replays every trailer shot's sim on the video clock (same speed curve
 * as the capture) and writes its key moment and event times in video seconds, for the edit.
 *   npx vite-node scripts/showcase/trailer_cues.ts <out.json> [shot,shot]
 */
import { writeFileSync } from 'node:fs'
import { ShotSim } from '../../src/render/showcase/simShot'
import { TRAILER_SHOTS } from '../../src/render/showcase/shots/trailer'
import { TICK_HZ } from '../../src/sim/types'
import { speedAt } from '../../src/render/showcase/types'

const [out, only] = process.argv.slice(2)
const pick = only ? new Set(only.split(',')) : null
const sheet: Record<string, { dur: number; hit: number; sync: number; events: [number, string, string, string][] }> = {}
for (const spec of TRAILER_SHOTS) {
  if (pick && !pick.has(spec.id)) continue
  const sim = new ShotSim(spec)
  const owner = (id: number) => sim.state.pawns.find((p) => p.id === id)?.owner ?? -1
  const events: [number, string, string, string][] = []
  let st = 0
  const frames = Math.round(spec.dur * 60)
  for (let k = 1; k <= frames; k++) {
    st += (1 / 60) * speedAt(spec, (k - 1) / 60, st)
    const need = Math.ceil(st * TICK_HZ - 1e-6)
    while (sim.state.tick - sim.t0 < need) {
      for (const e of sim.stepOnce()) {
        const vt = Number((k / 60).toFixed(3))
        if (e.type === 'damage' && e.kb > 0) events.push([vt, 'hit', e.cause ?? '', `P${owner(e.target)} kb ${e.kb.toFixed(0)} by P${e.source}`])
        else if (e.type === 'death') events.push([vt, 'death', e.cause ?? '', `P${e.owner}`])
        else if (e.type === 'cast') events.push([vt, 'cast', e.spell, `P${owner(e.pawn)}`])
        else if (e.type === 'explosion') events.push([vt, 'explosion', e.spell, ''])
        else if (e.type === 'teleport') events.push([vt, 'teleport', '', `P${owner(e.pawn)}`])
        else if (e.type === 'arenaShrink') events.push([vt, 'shrink', '', String(e.layer)])
        else if (e.type === 'roundWin') events.push([vt, 'roundWin', '', e.players.join(',')])
      }
    }
  }
  // the frame the key moment shows up on: the impact / teleport closest to the marked hit
  // (in slow motion the event's tick shows a few frames before the marked sim second)
  const hit = spec.hit ?? spec.dur / 2
  let sync = hit
  let best = Infinity
  for (const e of events) {
    if (e[1] === 'cast' || e[1] === 'shrink' || e[1] === 'roundWin' || e[0] < hit - 0.22 || e[0] > hit + 0.05) continue
    if (Math.abs(e[0] - hit) < best) {
      best = Math.abs(e[0] - hit)
      sync = e[0]
    }
  }
  sheet[spec.id] = { dur: spec.dur, hit, sync, events }
  const near = events.filter((e) => Math.abs(e[0] - (spec.hit ?? 0)) < 0.25 && e[1] !== 'cast').map((e) => `${e[0]} ${e[1]} ${e[2]} ${e[3]}`)
  console.log(`${spec.id.padEnd(12)} dur ${spec.dur.toFixed(2)} hit ${hit.toFixed(2)} sync ${sync.toFixed(2)} | ${near.slice(0, 4).join(' ; ')}`)
}
if (out) writeFileSync(out, JSON.stringify(sheet, null, 1))
