/**
 * Event / position trace of a trailer match window (pick and time trailer shots).
 *   npx vite-node scripts/showcase/trace_trailer.ts <match> <seed> <from s> <to s> [owner,owner]
 */
import { ShotSim } from '../../src/render/showcase/simShot'
import { trailerMatch } from '../../src/render/showcase/shots/trailerMatch'
import { isLocationSafe } from '../../src/sim'

const [id, seedArg, fromArg, toArg, ownersArg] = process.argv.slice(2)
const from = Number(fromArg)
const to = Number(toArg)
const only = ownersArg ? new Set(ownersArg.split(',').map(Number)) : null
const s = new ShotSim({ ...trailerMatch(id).spec, seed: Number(seedArg) })
const who = (eid: number) => s.state.pawns.find((p) => p.id === eid)?.owner ?? -1
const show = (...owners: (number | null)[]) => !only || owners.some((o) => o !== null && only.has(o))
for (let i = 0; i < to * 60 + 1; i++) {
  const ev = s.stepOnce()
  const st = s.st
  if (st < from) continue
  for (const e of ev) {
    const t = st.toFixed(2)
    if (e.type === 'castStart' && show(who(e.pawn))) console.log(t, 'castStart', `P${who(e.pawn)}`, e.spell, `${(e.ticks / 60).toFixed(2)}s`)
    if (e.type === 'cast' && show(who(e.pawn))) console.log(t, 'cast', `P${who(e.pawn)}`, e.spell, `-> (${e.x.toFixed(0)},${e.y.toFixed(0)})`)
    if (e.type === 'damage' && e.kb > 0 && show(who(e.target), e.source)) console.log(t, 'HIT', `P${who(e.target)}`, e.cause, `-${e.amount.toFixed(0)} kb ${e.kb.toFixed(0)} by P${e.source}`)
    if (e.type === 'death' && show(e.owner, e.killer)) console.log(t, 'DEATH', `P${e.owner}`, e.cause, `killer P${e.killer}`, `at (${(e.x ?? 0).toFixed(0)},${(e.y ?? 0).toFixed(0)})`)
    if (e.type === 'teleport' && show(who(e.pawn))) console.log(t, 'teleport', `P${who(e.pawn)}`, `(${e.fromX.toFixed(0)},${e.fromY.toFixed(0)}) -> (${e.toX.toFixed(0)},${e.toY.toFixed(0)})`)
    if (e.type === 'modifier' && e.on && show(who(e.pawn))) console.log(t, 'mod', `P${who(e.pawn)}`, e.id)
    if (e.type === 'beam' && show(e.owner)) console.log(t, 'beam', `P${e.owner}`, e.target === null ? 'miss' : `target ${e.target}`, e.blocked ? 'blocked' : '')
    if (e.type === 'arenaShrink') console.log(t, 'shrink', e.layer)
    if (e.type === 'roundWin') console.log(t, 'ROUNDWIN', e.players)
    if (e.type === 'phase') console.log(t, 'phase', e.phase, e.round)
  }
  if (i % 30 === 0)
    console.log(
      '   ',
      st.toFixed(1),
      `L${s.state.arena.layer}`,
      s.state.pawns
        .filter((p) => p.alive && show(p.owner))
        .map((p) => `P${p.owner}(${p.x.toFixed(0)},${p.y.toFixed(0)} hp${p.hp.toFixed(0)}${isLocationSafe(s.state, p.x, p.y) ? '' : ' LAVA'})`)
        .join(' '),
    )
}
