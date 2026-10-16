/**
 * Seed scan for the bot duel ("The Brawl"): runs Brutal 1v1s headless and ranks them by how
 * well they show the push loop (hits, growing knockback, an escape, a pull, a lava finish).
 *   npx vite-node scripts/showcase/scan_duel.ts [from] [to]
 */
import { ShotSim } from '../../src/render/showcase/simShot'
import { COLORS } from '../../src/render/showcase/simShot'
import { isLocationSafe } from '../../src/sim'

const [fromArg, toArg] = process.argv.slice(2)
const KIT0 = ['fireball', 'lightning', 'teleport', 'link']
const KIT1 = ['fireball', 'gravity', 'thrust', 'grip']
const rows: { seed: number; score: number; info: string }[] = []
for (let seed = Number(fromArg ?? 1); seed <= Number(toArg ?? 200); seed++) {
  const s = new ShotSim({
    players: [
      { name: 'Ashcaller', color: COLORS.ember, bot: 'brutal' },
      { name: 'Frostbinder', color: COLORS.azure, bot: 'brutal' },
    ],
    seed,
    layer: 15,
    theme: 1,
    level: 4,
    shrink: true,
    bystander: false,
  })
  for (const p of s.state.pawns) for (const sp of p.owner === 0 ? KIT0 : KIT1) s.grant(p.owner, sp)
  let hits = 0
  const casts = new Set<string>()
  let escapes = 0
  const lavaSince = new Map<number, number>()
  let end = -1
  let cause = ''
  let kbAtDeath = 0
  let pulls = 0
  for (let i = 0; i < 60 * 40; i++) {
    const ev = s.stepOnce()
    for (const e of ev) {
      if (e.type === 'damage' && e.kb > 0) hits++
      if (e.type === 'cast') casts.add(e.spell)
      if (e.type === 'modifier' && e.on && (e.id === 'link' || e.id === 'grip')) pulls++
      if (e.type === 'death') {
        end = s.st
        cause = e.cause ?? ''
        kbAtDeath = s.state.pawns.find((p) => p.id === e.pawn)?.kbPoints ?? 0
      }
    }
    for (const p of s.state.pawns) {
      if (!p.alive) continue
      const safe = isLocationSafe(s.state, p.x, p.y)
      if (!safe && !lavaSince.has(p.owner)) lavaSince.set(p.owner, s.st)
      if (safe && lavaSince.has(p.owner)) {
        if (s.st - lavaSince.get(p.owner)! > 0.1) escapes++
        lavaSince.delete(p.owner)
      }
    }
    if (end >= 0) break
  }
  let score = 0
  if (end >= 14 && end <= 32) score += 10
  if (cause === 'lava') score += 6
  score += Math.min(hits, 14)
  score += Math.min(escapes, 2) * 4
  score += Math.min(pulls, 2) * 3
  score += casts.has('teleport') ? 3 : 0
  score += kbAtDeath > 250 ? 3 : 0
  score += Math.min(casts.size, 7)
  rows.push({ seed, score, info: `end ${end.toFixed(1)} ${cause} hits ${hits} escapes ${escapes} pulls ${pulls} kb ${kbAtDeath.toFixed(0)} casts ${[...casts].join(',')}` })
}
rows.sort((a, b) => b.score - a.score)
for (const r of rows.slice(0, 12)) console.log(r.seed, r.score, r.info)
