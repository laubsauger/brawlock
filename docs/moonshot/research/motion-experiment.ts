// Research experiment for docs/moonshot/04-keystones.md: how bots move, per tier, in bot-only
// six-warlock FFA fights. A first cut of the plausibility metric; no source change.
// Run: npx vite-node docs/moonshot/research/motion-experiment.ts [matches, default 4]
//
// Per alive fight-second of each bot:
//   orders  move or stop commands issued
//   rev     reversals: walking resumes (or continues) within 0.6 s of the last walking tick,
//           heading more than 120 degrees away from it (stop-turn-go counts)
//   dither  seconds in which the bot issued 3+ orders but its walking moved it under 60 units
//   idle    seconds with no walking at all
//
// Measured 2026-10-28 (4 matches, seeds 500-503): Easy 0.9 orders/s, 0.19 reversals/s, no dither;
// Medium 2.4, 0.65, 0.07; Hard 8.7, 1.29, 0.15; Brutal 8.8, 1.24, 0.14; Uber 8.7, 1.16, 0.13.
// No human baseline yet: measure recorded human replays with the same definitions.
import { BotController } from '../../../src/bots'
import { DEFAULT_SETTINGS, createMatch, step } from '../../../src/sim'
import { TICK_HZ, type BotDifficulty, type PlayerSlot } from '../../../src/sim'

const MATCHES = Number(process.argv[2] ?? 4)
const tiers: BotDifficulty[] = ['easy', 'medium', 'hard', 'brutal', 'uber', 'hard']
type Acc = { sec: number; orders: number; rev: number; dither: number; idle: number }
const acc = new Map<string, Acc>()
for (let m = 0; m < MATCHES; m++) {
  const seed = 500 + m
  const slots: PlayerSlot[] = tiers.map((d, id) => ({ id, name: d, color: 0x100000 * (id + 1), team: id, kind: 'bot', difficulty: d }))
  const state = createMatch({ ...DEFAULT_SETTINGS, teamMode: 'ffa', winScore: 3 }, slots, seed)
  const bots = slots.map((s) => new BotController(s.id, s.difficulty!, seed * 31 + s.id))
  const win = Math.round(0.6 * TICK_HZ)
  const last = slots.map(() => ({ h: 0, t: -1e9 }))
  const hist = slots.map(() => [] as { h: number | null; x: number; y: number; o: number }[])
  for (let t = 0; t < 1500 * TICK_HZ && state.phase !== 'gameOver'; t++) {
    const inputs = bots.map((b) => ({ player: b.player, tick: state.tick, cmds: b.think(state) }))
    step(state, inputs)
    if (state.phase !== 'fight') { hist.forEach((h) => (h.length = 0)); continue }
    for (const p of state.pawns) {
      const id = p.owner
      const h = hist[id]
      if (!p.alive) { h.length = 0; continue }
      const orders = inputs[id].cmds.filter((c) => c.kind === 'move' || c.kind === 'stop').length
      const sp = Math.hypot(p.walkVx, p.walkVy)
      h.push({ h: sp > 1 ? Math.atan2(p.walkVy, p.walkVx) : null, x: p.x, y: p.y, o: orders })
      const a = acc.get(tiers[id]) ?? { sec: 0, orders: 0, rev: 0, dither: 0, idle: 0 }
      a.sec += 1 / TICK_HZ
      a.orders += orders
      // reversal: compare with the last tick this bot was walking, if that was within 0.6 s
      const cur = h[h.length - 1].h
      if (cur !== null) {
        const l = last[id]
        if (state.tick - l.t <= win) {
          let d = Math.abs(cur - l.h) % (2 * Math.PI)
          if (d > Math.PI) d = 2 * Math.PI - d
          if (d > (2 * Math.PI) / 3) a.rev++
        }
        l.h = cur
        l.t = state.tick
      }
      if (h.length % TICK_HZ === 0 && h.length >= TICK_HZ) {
        const s = h.slice(-TICK_HZ)
        let walked = 0, ord = 0, moving = 0
        for (let i = 1; i < s.length; i++) { if (s[i].h !== null) moving++ ; ord += s[i].o }
        // walking distance only: speed * dt over the second
        walked = moving * (p.moveSpeed / TICK_HZ)
        const net = Math.hypot(s[s.length - 1].x - s[0].x, s[s.length - 1].y - s[0].y)
        if (ord >= 3 && net < 60 && walked > 60) a.dither++
        if (moving === 0) a.idle++
      }
      acc.set(tiers[id], a)
    }
  }
}
for (const t of ['easy', 'medium', 'hard', 'brutal', 'uber']) {
  const a = acc.get(t)!
  const r = (x: number) => (x / a.sec).toFixed(2)
  console.log(`${t.padEnd(7)} fight-s ${a.sec.toFixed(0).padStart(5)} | orders/s ${r(a.orders)} | reversals/s ${r(a.rev)} | dither s/s ${r(a.dither)} | idle s/s ${r(a.idle)}`)
}
