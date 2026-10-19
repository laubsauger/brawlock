/**
 * Highlight scan for the trailer: plays Uber-bot matches headless (8-way FFA, 4-way FFA,
 * duels) with varied high-level kits and lists the moments worth a shot: lava kills after
 * a big hit, multi-hits, Lightning detonating a projectile, escapes out of the lava, pulls.
 *   npx vite-node scripts/showcase/scan_trailer.ts [config=all] [from=1] [to=12] [--json out.json]
 */
import { writeFileSync } from 'node:fs'
import { ShotSim } from '../../src/render/showcase/simShot'
import { TRAILER_MATCHES, type TrailerMatch } from '../../src/render/showcase/shots/trailerMatch'
import { isLocationSafe } from '../../src/sim'

const args = process.argv.slice(2)
const jsonAt = args.indexOf('--json')
const jsonOut = jsonAt >= 0 ? args[jsonAt + 1] : ''
const pos = args.filter((a, i) => !a.startsWith('--') && (jsonAt < 0 || i !== jsonAt + 1))
const which = pos[0] ?? 'all'
const from = Number(pos[1] ?? 1)
const to = Number(pos[2] ?? 12)
const SECONDS = 150
/** utility casts worth a shot of their own */
const UTIL = new Set(['gravity', 'warpzone', 'rockpillar', 'magnetize', 'grip', 'swap', 'link', 'thrust'])

interface Moment {
  match: string
  seed: number
  st: number
  kind: string
  score: number
  spell: string
  who: number[]
  x: number
  y: number
  crowd: number
  round: number
  info: string
}

function scan(m: TrailerMatch, seed: number): Moment[] {
  const s = new ShotSim({ ...m.spec, seed })
  const out: Moment[] = []
  const lastHit = new Map<number, { st: number; source: number | null; spell: string; kb: number; clean: boolean; layer: number }>()
  const owner = (id: number) => s.state.pawns.find((p) => p.id === id)?.owner ?? -1
  const crowd = (x: number, y: number) => s.state.pawns.filter((p) => p.alive && Math.hypot(p.x - x, p.y - y) < 700).length
  let round = 1
  for (let i = 0; i < SECONDS * 60; i++) {
    const projBefore = new Set(s.state.projectiles.map((p) => p.id))
    const ev = s.stepOnce()
    const st = s.st
    const groups = new Map<string, { n: number; x: number; y: number; who: number[] }>()
    for (const e of ev) {
      if (e.type === 'phase' && e.phase === 'fight') round = e.round
      if (e.type === 'damage' && e.kb > 0 && e.source !== null) {
        const tgt = owner(e.target)
        // clean = attacker and victim both stood on the platform when it landed
        const att = s.state.pawns.find((p) => p.owner === e.source)
        const vic = s.state.pawns.find((p) => p.id === e.target)
        const clean = !!att && !!vic && isLocationSafe(s.state, att.x, att.y) && isLocationSafe(s.state, e.x, e.y)
        lastHit.set(e.target, { st, source: e.source, spell: e.cause ?? '', kb: e.kb, clean, layer: s.state.arena.layer })
        const k = `${e.source}:${e.cause}`
        const g = groups.get(k) ?? { n: 0, x: e.x, y: e.y, who: [e.source] }
        g.n++
        g.who.push(tgt)
        groups.set(k, g)
        if (e.kb >= 750) out.push({ match: m.id, seed, st, kind: 'bigHit', score: e.kb / 160, spell: e.cause ?? '', who: [e.source, tgt], x: e.x, y: e.y, crowd: crowd(e.x, e.y), round, info: `kb ${e.kb.toFixed(0)}` })
      }
      if (e.type === 'death' && e.cause !== 'disconnect') {
        const h = lastHit.get(e.pawn)
        const recent = h && st - h.st < 4 ? h : null
        const x = e.x ?? 0
        const y = e.y ?? 0
        out.push({
          match: m.id,
          seed,
          st: recent ? recent.st : st,
          kind: 'kill',
          score: 6 + (recent ? recent.kb / 220 : 0),
          spell: recent ? recent.spell : (e.cause ?? ''),
          who: [recent?.source ?? -1, e.owner],
          x,
          y,
          crowd: crowd(x, y),
          round,
          info: `${e.cause} died ${st.toFixed(2)}${recent ? ` hit kb ${recent.kb.toFixed(0)} ${(st - recent.st).toFixed(1)}s before${recent.clean ? ' clean' : ''} L${recent.layer}` : ''}`,
        })
      }
      if (e.type === 'beam' && e.target !== null && projBefore.has(e.target)) out.push({ match: m.id, seed, st, kind: 'combo', score: 9, spell: e.spell, who: [e.owner], x: e.toX, y: e.toY, crowd: crowd(e.toX, e.toY), round, info: 'beam hit a projectile' })
      if (e.type === 'teleport' && !isLocationSafe(s.state, e.fromX, e.fromY) && isLocationSafe(s.state, e.toX, e.toY))
        out.push({ match: m.id, seed, st, kind: 'escape', score: 6, spell: 'teleport', who: [owner(e.pawn)], x: e.toX, y: e.toY, crowd: crowd(e.toX, e.toY), round, info: 'out of the lava' })
      if (e.type === 'modifier' && e.on && (e.id === 'link' || e.id === 'grip')) {
        const p = s.state.pawns.find((q) => q.id === e.pawn)
        if (p) out.push({ match: m.id, seed, st, kind: 'pull', score: 3, spell: e.id, who: [p.owner], x: p.x, y: p.y, crowd: crowd(p.x, p.y), round, info: '' })
      }
      if (e.type === 'cast' && UTIL.has(e.spell)) {
        const p = s.state.pawns.find((q) => q.id === e.pawn)
        if (p) out.push({ match: m.id, seed, st, kind: 'util', score: crowd(p.x, p.y), spell: e.spell, who: [p.owner], x: p.x, y: p.y, crowd: crowd(p.x, p.y), round, info: `aim (${e.x.toFixed(0)},${e.y.toFixed(0)})` })
      }
      if (e.type === 'roundWin') out.push({ match: m.id, seed, st, kind: 'roundWin', score: 4, spell: '', who: e.players, x: 0, y: 0, crowd: 0, round, info: '' })
    }
    for (const [k, g] of groups) if (g.n >= 2) out.push({ match: m.id, seed, st, kind: 'multi', score: 5 * g.n, spell: k.split(':')[1], who: g.who, x: g.x, y: g.y, crowd: crowd(g.x, g.y), round, info: `${g.n} hit` })
  }
  return out
}

const all: Moment[] = []
for (const m of TRAILER_MATCHES) {
  if (which !== 'all' && m.id !== which) continue
  for (let seed = from; seed <= to; seed++) {
    const ms = scan(m, seed)
    all.push(...ms)
    const kills = ms.filter((x) => x.kind === 'kill').length
    const best = ms.reduce((a, b) => a + b.score, 0)
    console.log(`${m.id} seed ${seed}: ${ms.length} moments, ${kills} kills, score ${best.toFixed(0)}`)
  }
}
all.sort((a, b) => b.score - a.score)
for (const x of all.slice(0, 80))
  console.log(`${x.score.toFixed(1).padStart(5)} ${x.kind.padEnd(8)} ${x.match} s${x.seed} r${x.round} @${x.st.toFixed(2)} ${x.spell.padEnd(10)} P${x.who.join(',P')} crowd ${x.crowd} ${x.info}`)
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(all, null, 1))
