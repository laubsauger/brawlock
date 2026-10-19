/**
 * Node-side shot tuner: runs a shot's sim script without rendering and prints
 * its event log and pawn positions, so timing can be tuned in seconds.
 *   npx vite-node scripts/showcase/tune.ts <shotId> [every=0.25]
 */
import { ShotSim } from '../../src/render/showcase/simShot'
import { SHOTS } from '../../src/render/showcase/shots'
import { speedAt } from '../../src/render/showcase/types'

const [id, everyArg] = process.argv.slice(2)
const ids = id === 'all' ? SHOTS.map((s) => s.id) : [id]
for (const sid of ids) {
  const spec = SHOTS.find((s) => s.id === sid)
  if (!spec) throw new Error(`unknown shot ${sid}; known: ${SHOTS.map((s) => s.id).join(', ')}`)
  const sim = new ShotSim(spec)
  const every = Number(everyArg ?? 0.25)
  // integrate the speed curve: sim seconds covered by the shot's video duration
  let st = 0
  for (let vt = 0; vt < spec.dur; vt += 1 / 60) st += (1 / 60) * speedAt(spec, vt, st)
  const ticks = Math.ceil(st * 60)
  console.log(`== ${sid}: ${spec.dur}s video = ${st.toFixed(2)}s sim (${ticks} ticks), layer ${sim.state.arena.layer}, theme ${sim.state.arena.theme}`)
  let nextPrint = 0
  for (let i = 0; i < ticks; i++) {
    const ev = sim.stepOnce()
    for (const e of ev) {
      const pawnName = (pid: number | null | undefined) => {
        const p = sim.state.pawns.find((q) => q.id === pid)
        return p ? `P${p.owner}` : String(pid)
      }
      let extra = ''
      if (e.type === 'damage') extra = `${pawnName(e.target)} -${e.amount.toFixed(0)} kb ${e.kb.toFixed(0)}`
      else if (e.type === 'death') extra = `${pawnName(e.pawn)} cause ${e.cause} kb ${(e.kb ?? 0).toFixed(0)}`
      else if (e.type === 'castStart' || e.type === 'cast') extra = `${pawnName(e.pawn)} ${e.spell}`
      else if (e.type === 'modifier') extra = `${pawnName(e.pawn)} ${e.id} ${e.on ? 'on' : 'off'}`
      else if ('spell' in e) extra = String(e.spell)
      if (e.type === 'damage' && sim.hidden.size && extra.startsWith('P9')) continue
      if (e.type === 'modifier' && extra.startsWith('P9')) continue
      console.log(`  ${sim.st.toFixed(3)}  ${e.type} ${extra}`)
    }
    if (sim.st >= nextPrint - 1e-9) {
      nextPrint += every
      const ps = sim.state.pawns
        .filter((p) => !sim.hidden.has(p.owner))
        .map((p) => `P${p.owner}${p.alive ? '' : '+'}(${p.x.toFixed(0)},${p.y.toFixed(0)} hp${p.hp.toFixed(0)}${p.cast ? ' ' + p.cast.spell : ''})`)
        .join(' ')
      const pr = sim.state.projectiles.map((p) => `${p.kind ?? p.spell}#${p.id}(${p.x.toFixed(0)},${p.y.toFixed(0)})`).join(' ')
      console.log(`  ${sim.st.toFixed(2)} | ${ps}${pr ? ' | ' + pr : ''}`)
    }
  }
}
