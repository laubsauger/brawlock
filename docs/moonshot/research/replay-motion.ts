// Research tool for docs/moonshot/specs/bot-motion.md: how humans and bots move in recorded
// matches. Re-simulates each replay on the build that recorded it and measures, per player and
// alive fight-second, the same things as motion-experiment.ts plus click shape:
//   orders/s      move or stop commands
//   casts/s       cast commands
//   rev/s         walking resumed or continued within 0.6 s more than 120 degrees from the last heading
//   dither        share of seconds with 3+ orders in which walking moved the pawn under 60 units net
//   idle          share of seconds without walking
//   click-flip    share of consecutive move orders (within 0.5 s) aimed more than 120 degrees apart
//   short-click   share of move orders aimed under 120 units from the pawn
//   gap-p50       median time between move orders, s (p10 and p90 beside it)
//   gap-cv        spread of those gaps (standard deviation over mean, gaps under 1 s)
//
// A replay only re-simulates on its own build. To get that build: compute the netcode id of
// candidate commits (release tags first) with `git archive <commit> src/sim src/net
// scripts/net-id.mjs src/game/progressionCatalog.ts | tar -x -C <dir>; node <dir>/scripts/net-id.mjs <dir>`,
// then `git archive <commit> src | tar -x -C <root>` and run:
//   npx vite-node docs/moonshot/research/replay-motion.ts -- <root> media/replays/<file>.brawlock ...
//
// Measured 2026-10-28 on five exported matches (media/replays, git-ignored; builds alpha.10, .13,
// .14 and .16; none desynced). Fight-second ranges across matches:
//   BeFlat (top-rated)  orders 4.1-5.5  rev 0.18-0.32  dither 0.05-0.08  click-flip 0.03-0.06
//   Laub                orders 4.9-5.8  rev 0.16-0.33  dither 0.06-0.08  click-flip 0.03-0.06
//   POPE                orders 0.9-1.2  rev 0.05-0.08  dither 0.01      click-flip 0.02-0.07
//   Hard bots           orders 8.3-8.6  rev 0.76-0.91  dither 0.11-0.13  click-flip 0.10-0.12
//   Brutal bots         orders 8.3-8.8  rev 0.74-1.34  dither 0.11-0.17  click-flip 0.10-0.16
//   Medium bots         orders 2.3      rev 0.49-0.55  dither 0.06-0.07  click-flip 0.25-0.27
// Time between move orders (p10 / p50 / p90, s): BeFlat 0.07-0.08 / 0.10-0.15 / 0.30-0.58, Laub
// 0.08-0.10 / 0.17 / 0.23-0.30; Hard and Brutal bots 0.10 / 0.10 / 0.10 at 60 Hz and 0.07 / 0.10 /
// 0.13 at 30 Hz: every bot decides on the same fixed 0.1 s clock, in step with the others.
// Humans click often too (about five orders a second); what sets the bots apart is turning
// around three to five times as often and clicking in opposite directions two to three times as
// often. Rounds-mode bots reverse more than hill-mode bots.
import { readFileSync } from 'node:fs'
const [root, ...files] = process.argv.slice(2).filter((a) => a !== '--')
const fmt = await import(`${root}/src/game/replay/format.ts`)
const pl = await import(`${root}/src/game/replay/player.ts`)
const types = await import(`${root}/src/sim/types.ts`)
type Acc = { name: string; kind: string; diff: string; sec: number; orders: number; casts: number; rev: number; dither: number; idle: number; windows: number; flips: number; pairs: number; short: number; moves: number; gaps: number[] }
const cv = (xs: number[]) => { const g = xs.filter((x) => x < 1); const m = g.reduce((a, b) => a + b, 0) / Math.max(1, g.length); return g.length ? Math.sqrt(g.reduce((a, b) => a + (b - m) ** 2, 0) / g.length) / m : NaN }
const pick = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN }
for (const f of files) {
  const d = await fmt.decodeReplay(new Uint8Array(readFileSync(f)))
  if (!d) { console.log('unreadable', f); continue }
  if (d.hz && types.setTickRate) types.setTickRate(d.hz)
  const HZ: number = types.TICK_HZ
  const p = new pl.ReplayPlayer(d, d.netId)
  const steps = new Map<number, unknown>(d.steps.map((s: [number]) => [s[0], s]))
  const acc = new Map<number, Acc>()
  const hist = new Map<number, { walking: boolean; x: number; y: number; o: number }[]>()
  const last = new Map<number, { h: number; t: number }>()
  const lastMove = new Map<number, { t: number; a: number }>()
  const win = Math.round(0.6 * HZ)
  while (!p.done) {
    const rec = steps.get(p.tick)
    const inputs: { player: number; cmds: { kind: string; x?: number; y?: number }[] }[] = rec ? fmt.decodeInputs(rec) : []
    const before = new Map<number, { x: number; y: number }>(p.state.pawns.map((q: { owner: number; x: number; y: number }) => [q.owner, { x: q.x, y: q.y }]))
    p.stepOnce()
    const s = p.state
    if (s.phase !== 'fight') { hist.clear(); continue }
    for (const pawn of s.pawns) {
      const id = pawn.owner
      if (!pawn.alive) { hist.delete(id); continue }
      const slot = s.slots.find((x: { id: number }) => x.id === id)
      let a = acc.get(id)
      if (!a) { a = { name: slot?.name ?? String(id), kind: slot?.kind ?? '?', diff: slot?.difficulty ?? '', sec: 0, orders: 0, casts: 0, rev: 0, dither: 0, idle: 0, windows: 0, flips: 0, pairs: 0, short: 0, moves: 0, gaps: [] }; acc.set(id, a) }
      a.sec += 1 / HZ
      const cmds = inputs.filter((i) => i.player === id).flatMap((i) => i.cmds)
      let o = 0
      for (const c of cmds) {
        if (c.kind === 'cast') a.casts++
        if (c.kind !== 'move' && c.kind !== 'stop') continue
        o++
        a.orders++
        if (c.kind === 'move') {
          const from = before.get(id) ?? pawn
          const dx = c.x! - from.x, dy = c.y! - from.y
          a.moves++
          if (Math.hypot(dx, dy) < 120) a.short++
          const ang = Math.atan2(dy, dx)
          const lm = lastMove.get(id)
          if (lm) {
            const gap = (s.tick - lm.t) / HZ
            a.gaps.push(gap)
            if (gap <= 0.5 && Math.hypot(dx, dy) > 1) {
              a.pairs++
              let dd = Math.abs(ang - lm.a) % (2 * Math.PI); if (dd > Math.PI) dd = 2 * Math.PI - dd
              if (dd > (2 * Math.PI) / 3) a.flips++
            }
          }
          lastMove.set(id, { t: s.tick, a: ang })
        }
      }
      const walking = Math.hypot(pawn.walkVx, pawn.walkVy) > 1
      if (walking) {
        const h = Math.atan2(pawn.walkVy, pawn.walkVx)
        const l = last.get(id)
        if (l && s.tick - l.t <= win) { let dd = Math.abs(h - l.h) % (2 * Math.PI); if (dd > Math.PI) dd = 2 * Math.PI - dd; if (dd > (2 * Math.PI) / 3) a.rev++ }
        last.set(id, { h, t: s.tick })
      }
      let hh = hist.get(id); if (!hh) { hh = []; hist.set(id, hh) }
      hh.push({ walking, x: pawn.x, y: pawn.y, o })
      if (hh.length % HZ === 0) {
        const w = hh.slice(-HZ)
        let mv = 0, ord = 0
        for (const e of w) { if (e.walking) mv++; ord += e.o }
        const walked = mv * (pawn.moveSpeed / HZ)
        const net = Math.hypot(w[w.length - 1].x - w[0].x, w[w.length - 1].y - w[0].y)
        a.windows++
        if (ord >= 3 && net < 60 && walked > 60) a.dither++
        if (mv === 0) a.idle++
      }
    }
  }
  console.log(`\n${f.split('/').pop()}  hz ${HZ}  ${d.settings.gameMode}  desync ${p.desync ? 'at tick ' + p.desync.tick : 'none'}`)
  console.log('player          kind  tier    fight-s orders/s casts/s rev/s dither idle  click-flip short-click gap-p10/p50/p90  gap-cv')
  for (const a of [...acc.values()].sort((x, y) => (x.kind > y.kind ? -1 : 1))) {
    const r = (x: number) => (x / a.sec).toFixed(2)
    const sh = (x: number, n: number) => (n ? (x / n).toFixed(2) : '-')
    console.log(`${a.name.padEnd(15)} ${a.kind.padEnd(5)} ${a.diff.padEnd(7)} ${a.sec.toFixed(0).padStart(7)} ${r(a.orders).padStart(8)} ${r(a.casts).padStart(7)} ${r(a.rev).padStart(5)} ${sh(a.dither, a.windows).padStart(6)} ${sh(a.idle, a.windows).padStart(5)} ${sh(a.flips, a.pairs).padStart(10)} ${sh(a.short, a.moves).padStart(11)} ${[0.1, 0.5, 0.9].map((q) => pick(a.gaps, q).toFixed(2)).join('/').padStart(15)} ${cv(a.gaps).toFixed(2).padStart(7)}`)
  }
}
