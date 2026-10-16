/**
 * Event / position trace of a bot 1v1 (pick brawl segments).
 *   npx vite-node scripts/showcase/trace_duel.ts <seed> [brutal|hard]
 */
import { ShotSim, COLORS } from '../../src/render/showcase/simShot'
import { isLocationSafe } from '../../src/sim'
const seed = Number(process.argv[2] ?? 38)
const diff = (process.argv[3] ?? 'brutal') as 'brutal'
const s = new ShotSim({ players: [{ name: 'A', color: COLORS.ember, bot: diff }, { name: 'B', color: COLORS.azure, bot: diff }], seed, layer: 15, theme: 1, level: 4, shrink: true, bystander: false })
const KIT0 = ['fireball', 'lightning', 'teleport', 'link']
const KIT1 = ['fireball', 'gravity', 'thrust', 'grip']
for (const p of s.state.pawns) for (const sp of p.owner === 0 ? KIT0 : KIT1) s.grant(p.owner, sp)
for (let i = 0; i < 60 * 40; i++) {
  const ev = s.stepOnce()
  for (const e of ev) {
    const who = (id: number) => 'P' + (s.state.pawns.find((p) => p.id === id)?.owner ?? '?')
    if (e.type === 'cast') console.log(s.st.toFixed(2), 'cast', who(e.pawn), e.spell)
    if (e.type === 'damage' && e.kb > 0) console.log(s.st.toFixed(2), 'HIT', who(e.target), e.amount.toFixed(0), 'kb', e.kb.toFixed(0))
    if (e.type === 'death') console.log(s.st.toFixed(2), 'DEATH', who(e.pawn), e.cause)
    if (e.type === 'arenaShrink') console.log(s.st.toFixed(2), 'shrink', e.layer)
  }
  if (i % 30 === 0) console.log('   ', s.st.toFixed(1), s.state.pawns.map((p) => `P${p.owner}(${p.x.toFixed(0)},${p.y.toFixed(0)} hp${p.hp.toFixed(0)} kbp${p.kbPoints.toFixed(0)}${isLocationSafe(s.state, p.x, p.y) ? '' : ' LAVA'})`).join(' '))
  if (s.state.phase !== 'fight') break
}
