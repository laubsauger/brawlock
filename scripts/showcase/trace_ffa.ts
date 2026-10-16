/**
 * Event / position trace of the finale FFA (pick finale segments).
 *   npx vite-node scripts/showcase/trace_ffa.ts <seed> <from sim s>
 */
import { ShotSim } from '../../src/render/showcase/simShot'
import { FINALE_BASE } from '../../src/render/showcase/shots/finale'
import { isLocationSafe } from '../../src/sim'
const seed = Number(process.argv[2] ?? 20)
const from = Number(process.argv[3] ?? 0)
const s = new ShotSim({ ...FINALE_BASE, seed })
for (let i = 0; i < 60 * 70; i++) {
  const ev = s.stepOnce()
  if (s.st < from) continue
  for (const e of ev) {
    const who = (id: number) => 'P' + (s.state.pawns.find((p) => p.id === id)?.owner ?? '?')
    if (e.type === 'cast') console.log(s.st.toFixed(2), 'cast', who(e.pawn), e.spell)
    if (e.type === 'damage' && e.kb > 0) console.log(s.st.toFixed(2), 'HIT', who(e.target), e.amount.toFixed(0), 'kb', e.kb.toFixed(0), 'by P' + e.source)
    if (e.type === 'death') console.log(s.st.toFixed(2), 'DEATH', 'P' + e.owner, e.cause)
    if (e.type === 'arenaShrink') console.log(s.st.toFixed(2), 'shrink', e.layer)
    if (e.type === 'roundWin') console.log(s.st.toFixed(2), 'ROUNDWIN', e.players)
  }
  if (i % 30 === 0) console.log('   ', s.st.toFixed(1), 'L' + s.state.arena.layer, s.state.pawns.filter((p) => p.alive).map((p) => `P${p.owner}(${p.x.toFixed(0)},${p.y.toFixed(0)}${isLocationSafe(s.state, p.x, p.y) ? '' : ' LAVA'})`).join(' '))
  if (s.state.phase !== 'fight' && s.st > from + 2) break
}
