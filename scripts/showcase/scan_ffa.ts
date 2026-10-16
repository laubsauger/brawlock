/**
 * Seed scan for the finale: 8 Brutal bots, FFA, varied kits. Prints matches that end within
 * the time limit with their death timeline and the busiest 5 s window.
 *   npx vite-node scripts/showcase/scan_ffa.ts [from] [to]
 */
import { ShotSim } from '../../src/render/showcase/simShot'
import { FINALE_BASE } from '../../src/render/showcase/shots/finale'

const [a, b] = process.argv.slice(2)
for (let seed = Number(a ?? 1); seed <= Number(b ?? 40); seed++) {
  const s = new ShotSim({ ...FINALE_BASE, seed })
  const deaths: string[] = []
  const hitTimes: number[] = []
  let end = -1
  let winner = -1
  for (let i = 0; i < 60 * 90; i++) {
    const ev = s.stepOnce()
    for (const e of ev) {
      if (e.type === 'damage' && e.kb > 0) hitTimes.push(s.st)
      if (e.type === 'death') deaths.push(`${s.st.toFixed(1)}:P${e.owner}:${e.cause}`)
      if (e.type === 'roundWin') {
        end = s.st
        winner = e.players[0] ?? -1
      }
    }
    if (end >= 0 && s.st > end + 0.1) break
  }
  let best = 0
  let bestAt = 0
  for (const t of hitTimes) {
    const n = hitTimes.filter((u) => u >= t && u < t + 5).length
    if (n > best) {
      best = n
      bestAt = t
    }
  }
  console.log(`seed ${seed} end ${end.toFixed(1)} winner P${winner} hits ${hitTimes.length} busiest ${best}@${bestAt.toFixed(1)} deaths ${deaths.join(' ')}`)
}
