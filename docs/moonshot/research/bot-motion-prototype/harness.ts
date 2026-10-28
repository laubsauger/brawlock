// Research harness for docs/moonshot/specs/bot-motion.md. Motion metrics per seat label plus round results.
import { BOT_PRESETS, BotController, type BotParams } from '../../../../src/bots'
import { DEFAULT_SETTINGS, createMatch, step, isEnemy } from '../../../../src/sim'
import { dangerAt } from '../../../../src/bots/danger'
import { TICK_HZ } from '../../../../src/sim/types'
import type { BotDifficulty, InputCommand, MatchSettings, PlayerSlot } from '../../../../src/sim/types'

export interface Seat { label: string; base: BotDifficulty; over?: Partial<BotParams>; ctor?: any }
export interface Acc {
  sec: number; orders: number; redirects: number; rev: number; revFree: number; dither: number; ditherR: number; ditherS: number; idle: number; windows: number; flips: number; pairs: number; short: number; moves: number; gaps: number[]
  byTag: Record<string, number>; redirByTag: Record<string, number>; revByTag: Record<string, number>; trans: Record<string, number>
}
export const newAcc = (): Acc => ({ sec: 0, orders: 0, redirects: 0, rev: 0, revFree: 0, dither: 0, ditherR: 0, ditherS: 0, idle: 0, windows: 0, flips: 0, pairs: 0, short: 0, moves: 0, gaps: [], byTag: {}, redirByTag: {}, revByTag: {}, trans: {} })
const bump = (r: Record<string, number>, k: string, n = 1) => { r[k] = (r[k] ?? 0) + n }
const angDiff = (a: number, b: number) => { let d = Math.abs(a - b) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d }

export const picks: Record<string, number> = {}
/** per tier: think gaps (s); lockstep: [both decide, A decides, B decides, ticks] over same-tier pairs */
export const timing: Record<string, { gaps: number[]; both: number; a: number; b: number; n: number }> = {}
export interface MatchOut { seats: Seat[]; acc: Acc[]; rounds: number[][]; scores: number[]; seconds: number }

export function playMatch(seats: Seat[], settings: Partial<MatchSettings>, seed: number, botSeed = (id: number) => seed * 31 + id): MatchOut {
  const slots: PlayerSlot[] = seats.map((s, id) => ({ id, name: s.label, color: 0x100000 * (id + 1), team: id, kind: 'bot', difficulty: s.base }))
  const state = createMatch({ ...DEFAULT_SETTINGS, ...settings } as MatchSettings, slots, seed)
  const tag = new WeakMap<object, string>()
  let curTick = 0
  const bots = seats.map((s, id) => {
    const C = s.ctor ?? BotController
    const b = new C(id, s.base, botSeed(id), { ...BOT_PRESETS[s.base], ...(s.over ?? {}) })
    const orig = b.enqueue.bind(b)
    b.enqueue = (at: number, cmds: InputCommand[]) => {
      const fromDecide = b._lastDecideTick !== undefined ? b._lastDecideTick === curTick : b.nextThinkTick === curTick + b.thinkTicks
      let t = fromDecide ? b.lastAction : 'unstick'
      if (t === 'wander' && b._wanderKind) t = `wander:${b._wanderKind}`
      for (const c of cmds) tag.set(c, t)
      return orig(at, cmds)
    }
    // wander picker attribution
    const pw = b.pickWander.bind(b)
    b.pickWander = (st: any, me: any, target: any, safety: number) => {
      b._pick = 'roam'
      const w0 = b.wander
      const reason = !w0 ? 'none' : Math.hypot(me.x - w0.x, me.y - w0.y) < 100 ? 'arrive' : st.tick > b.nextWanderTick ? 'timer' : 'other'
      const r = pw(st, me, target, safety)
      if (st.phase === 'fight') {
        const stay = b.wander && b.wander.x === me.x && b.wander.y === me.y
        picks[`${b._pick === 'roam' && b.params.edgePressure && target ? 'standoff?' : b._pick}:${reason}${stay ? ':stay' : ''}`] = (picks[`${b._pick === 'roam' && b.params.edgePressure && target ? 'standoff?' : b._pick}:${reason}${stay ? ':stay' : ''}`] ?? 0) + 1
      }
      if (b._pick === 'roam' && b.params.edgePressure && target && !(st.pawns.filter((o: any) => o.alive && o.owner !== id).length >= 2)) b._pick = 'standoff'
      b._wanderKind = b._pick + (b.wander && b.wander.x === me.x && b.wander.y === me.y ? ":stay" : "")
      return r
    }
    const pf = b.pickFfaWander.bind(b)
    b.pickFfaWander = (...a: any[]) => { b._pick = 'ffa'; return pf(...a) }
    const ph = b.pickHillWander.bind(b)
    b.pickHillWander = (...a: any[]) => { const r = ph(...a); if (r) b._pick = 'hill'; return r }
    return b
  })
  const acc = seats.map(() => newAcc())
  const win = Math.round(0.6 * TICK_HZ)
  const last = seats.map(() => ({ h: 0, t: -1e9, tag: '' }))
  const lastOrderTag = seats.map(() => '')
  const lastDec = seats.map(() => -1)
  const threatTick = seats.map(() => -1e9)
  const hist = seats.map(() => [] as { h: number | null; x: number; y: number; o: number; r: number; wx: number; wy: number }[])
  const lastMove = seats.map(() => null as null | { t: number; a: number })
  const rounds: number[][] = []
  let died: number[] = []
  let prev = state.phase
  const SURVIVED = 1e9
  let t = 0
  for (; t < 1500 * TICK_HZ && state.phase !== 'gameOver'; t++) {
    curTick = state.tick
    const before = bots.map((b) => b.nextThinkTick)
    const inputs = bots.map((b) => ({ player: b.player, tick: state.tick, cmds: b.think(state) as InputCommand[] }))
    if (state.phase === 'fight') {
      const dec = bots.map((b, i) => (b._lastDecideTick !== undefined ? b._lastDecideTick === curTick : b.nextThinkTick !== before[i]))
      const alive = bots.map((b) => state.pawns.some((p) => p.owner === b.player && p.alive))
      bots.forEach((b, i) => {
        if (!alive[i]) { lastDec[i] = -1; return }
        const tm = (timing[seats[i].base] ??= { gaps: [], both: 0, a: 0, b: 0, n: 0 })
        if (dec[i]) { if (lastDec[i] >= 0) tm.gaps.push((curTick - lastDec[i]) / TICK_HZ); lastDec[i] = curTick }
        for (let j = i + 1; j < bots.length; j++) {
          if (seats[j].base !== seats[i].base || !alive[j]) continue
          tm.n++; if (dec[i]) tm.a++; if (dec[j]) tm.b++; if (dec[i] && dec[j]) tm.both++
        }
      })
    }
    // redirects: judged against the pawn before the step applies the orders
    const redir = seats.map(() => 0)
    const ord = seats.map(() => 0)
    if (state.phase === 'fight') {
      for (const p of state.pawns) {
        if (!p.alive) continue
        let mt = p.moveTarget ? { ...p.moveTarget } : null
        for (const c of inputs[p.owner].cmds) {
          if (c.kind !== 'move' && c.kind !== 'stop') { if (c.kind === 'cast') mt = null; continue }
          ord[p.owner]++
          const tg = tag.get(c) ?? '?'
          bump(acc[p.owner].byTag, tg)
          let isRedir = false
          if (c.kind === 'stop') isRedir = mt !== null
          else if (!mt) isRedir = true
          else {
            const a1 = Math.atan2(mt.y - p.y, mt.x - p.x), a2 = Math.atan2(c.y - p.y, c.x - p.x)
            const d1 = Math.hypot(mt.x - p.x, mt.y - p.y)
            isRedir = d1 > 5 && angDiff(a1, a2) > (25 * Math.PI) / 180
          }
          if (isRedir) { redir[p.owner]++; bump(acc[p.owner].redirByTag, tg) }
          if (c.kind === 'move') {
            const A = acc[p.owner]
            const dx = c.x - p.x, dy = c.y - p.y
            A.moves++
            if (Math.hypot(dx, dy) < 120) A.short++
            const ang = Math.atan2(dy, dx)
            const lm = lastMove[p.owner]
            if (lm) {
              const gap = (state.tick - lm.t) / TICK_HZ
              A.gaps.push(gap)
              if (gap <= 0.5 && Math.hypot(dx, dy) > 1) { A.pairs++; if (angDiff(ang, lm.a) > (2 * Math.PI) / 3) A.flips++ }
            }
            lastMove[p.owner] = { t: state.tick, a: ang }
          }
          mt = c.kind === 'stop' ? null : { x: c.x, y: c.y }
          lastOrderTag[p.owner] = tg
        }
      }
    }
    step(state, inputs)
    if (state.phase === 'fight' && prev !== 'fight') died = seats.map(() => SURVIVED)
    if (state.phase === 'fight' || prev === 'fight') for (const e of state.events) if (e.type === 'death') died[e.owner] = state.tick
    if (prev === 'fight' && state.phase !== 'fight') rounds.push(died)
    prev = state.phase
    if (state.phase !== 'fight') { hist.forEach((h) => (h.length = 0)); continue }
    for (const p of state.pawns) {
      const id = p.owner
      const h = hist[id]
      if (!p.alive) { h.length = 0; continue }
      const a = acc[id]
      const sp = Math.hypot(p.walkVx, p.walkVy)
      h.push({ h: sp > 1 ? Math.atan2(p.walkVy, p.walkVx) : null, x: p.x, y: p.y, o: ord[id], r: redir[id], wx: p.walkVx / TICK_HZ, wy: p.walkVy / TICK_HZ })
      a.sec += 1 / TICK_HZ
      a.orders += ord[id]
      a.redirects += redir[id]
      if (dangerAt(state.projectiles.filter((pr) => isEnemy(state, id, pr.owner)), p.x, p.y) >= 1.6) threatTick[id] = state.tick
      const cur = h[h.length - 1].h
      if (cur !== null) {
        const l = last[id]
        if (state.tick - l.t <= win && angDiff(cur, l.h) > (2 * Math.PI) / 3) {
          a.rev++
          if (state.tick - threatTick[id] > Math.round(0.4 * TICK_HZ)) a.revFree++
          bump(a.revByTag, lastOrderTag[id])
          bump(a.trans, `${l.tag}>${lastOrderTag[id]}`)
        }
        l.h = cur; l.t = state.tick; l.tag = lastOrderTag[id]
      }
      if (h.length % TICK_HZ === 0 && h.length >= TICK_HZ) {
        const s = h.slice(-TICK_HZ)
        let moving = 0, o = 0, r = 0
        for (let i = 1; i < s.length; i++) { if (s[i].h !== null) moving++; o += s[i].o; r += s[i].r }
        const walked = moving * (p.moveSpeed / TICK_HZ)
        const net = Math.hypot(s[s.length - 1].x - s[0].x, s[s.length - 1].y - s[0].y)
        a.windows++
        if (o >= 3 && net < 60 && walked > 60) a.dither++
        if (r >= 3 && net < 60 && walked > 60) a.ditherR++
        let path = 0, nx = 0, ny = 0
        for (const e of s) { path += Math.hypot(e.wx, e.wy); nx += e.wx; ny += e.wy }
        if (path >= 100 && Math.hypot(nx, ny) < 0.5 * path) a.ditherS++
        if (moving === 0) a.idle++
      }
    }
  }
  return { seats, acc, rounds, scores: seats.map((_, id) => state.scores.find((s) => s.id === id)?.score ?? 0), seconds: t / TICK_HZ }
}

export function merge(into: Acc, a: Acc) {
  for (const k of ['sec', 'orders', 'redirects', 'rev', 'revFree', 'dither', 'ditherR', 'ditherS', 'idle', 'windows', 'flips', 'pairs', 'short', 'moves'] as const) into[k] += a[k]
  into.gaps.push(...a.gaps)
  for (const k of ['byTag', 'redirByTag', 'revByTag', 'trans'] as const) for (const [t, n] of Object.entries(a[k])) bump(into[k], t, n)
}

export function line(label: string, a: Acc): string {
  const r = (x: number) => (x / a.sec).toFixed(2)
  const w = (x: number) => (x / Math.max(1, a.windows)).toFixed(3)
  const g = [...a.gaps].sort((x, y) => x - y)
  return `${label.padEnd(9)} fs ${a.sec.toFixed(0).padStart(5)} | ord/s ${r(a.orders)} | rev/s ${r(a.rev)} free ${r(a.revFree)} | dither ${w(a.dither)} | ditherS ${w(a.ditherS)} | idle ${w(a.idle)} | flip ${(a.flips / Math.max(1, a.pairs)).toFixed(3)} flip/s ${r(a.flips)} | short ${(a.short / Math.max(1, a.moves)).toFixed(2)} | gaps ${[0.1, 0.5, 0.9].map((q) => (g[Math.floor(q * g.length)] ?? NaN).toFixed(2)).join("/")} | redir/s ${r(a.redirects)}`
}

export function top(rec: Record<string, number>, total: number, n = 8): string {
  return Object.entries(rec).sort((x, y) => y[1] - x[1]).slice(0, n).map(([k, v]) => `${k} ${(100 * v / total).toFixed(0)}%`).join(', ')
}

/** round share of seat label A over B across matches: who outlived whom */
export function roundShare(outs: MatchOut[], a: string, b: string): { w: number; l: number; d: number } {
  let w = 0, l = 0, d = 0
  for (const o of outs) {
    const ia = o.seats.findIndex((s) => s.label === a), ib = o.seats.findIndex((s) => s.label === b)
    if (ia < 0 || ib < 0) continue
    for (const died of o.rounds) { if (died[ia] > died[ib]) w++; else if (died[ib] > died[ia]) l++; else d++ }
  }
  return { w, l, d }
}
