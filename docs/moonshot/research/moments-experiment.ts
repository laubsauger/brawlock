// Research experiment: the proposed moments rules (docs/moonshot/specs/moments.md draft) over bot-only matches.
// Frequencies per kind, score composition of the reel, Final Blow window sizes, finish zoom accuracy.
import { DEFAULT_SETTINGS, createMatch, step, gameWinners, teamOf, isRoundParticipant } from '../../../src/sim'
import { BotController } from '../../../src/bots'
import { TICK_HZ, type PlayerSlot, type BotDifficulty, type MatchSettings } from '../../../src/sim/types'
import { KillTally } from '../../../src/game/announcer'
import { isDeniedEscape, writeSlide, type SlideSnapshot } from '../../../src/game/teleportSave'
import { lavaOutcome } from '../../../src/bots/predict'
import { OBSTACLE_EXPLODE_RADIUS } from '../../../src/sim/config'

const S = (s: number) => Math.round(s * TICK_HZ)
const SEAL_MAX = 12, SEAL_GRACE = 0.5, FLIGHT_START = 200, FLIGHT_STOP = 20, LONG_FLIGHT = 6 * 192
const CLOSE_HP = 0.08, CLOSE_SAFE = Number(process.env.CLOSE_SAFE ?? 5)

interface Hit { tick: number; src: number; kb: number; cause: string; x: number; y: number; reflected: boolean; detonation: boolean; pillar: boolean; flightLen: number; flightEnd: number | null; x0: number; y0: number }
interface Mem { owner: number; hits: Hit[]; flight: Hit | null; stayStart: number | null; slide: SlideSnapshot & { hp: number; moveSpeed: number; alive: boolean }; closeAt: number | null; closeDone: number; closeConfirmed: number | null }
interface Moment { kind: string; actor: number; victims: number[]; from: number; to: number; tick: number; base: number; stakes: number; spectacle: number; novelty: number; traits: Set<string>; n?: number }
const score = (m: Moment) => m.base * m.stakes * m.spectacle * (m.stakes > 1 ? 1 : m.novelty)

const C = new Map<string, number>()
const bump = (k: string, n = 1) => C.set(k, (C.get(k) ?? 0) + n)
const D: Record<string, number[]> = {}
const push = (k: string, v: number) => (D[k] ??= []).push(v)
const pct = (xs: number[] = [], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN }

function runMatch(label: string, settings: MatchSettings, mix: BotDifficulty[], teams: number[] | null, seed: number, maxMinutes: number, local: number) {
  const slots: PlayerSlot[] = mix.map((d, id) => ({ id, name: d + id, color: 0x100000 * (id + 1), team: teams ? teams[id] : id, kind: 'bot', difficulty: d }))
  const state = createMatch(settings, slots, seed)
  const bots = slots.map((s) => new BotController(s.id, s.difficulty!, seed * 31 + s.id))
  const mem = new Map<number, Mem>()
  const tally = new KillTally()
  const chainMoment = new Map<number, Moment>()
  const seen = new Map<string, number>()
  const novelty = (kind: string, actor: number) => { const k = kind + ':' + actor; const n = seen.get(k) ?? 0; seen.set(k, n + 1); return Math.max(0.4, Math.pow(0.8, n)) }
  const moments: Moment[] = []
  let stolen = new Map<number, { owner: number; spell: string }>()
  let round = 0
  let teamAt = new Map<number, number>()
  let clutch = new Map<number, { enemies: number; at: number }>()
  let zooms: { pawn: number; tick: number; hit: Hit }[] = []
  const deficit = new Map<number, number>()
  let matchDecider: Moment | null = null
  for (let t = 0; t < maxMinutes * 60 * TICK_HZ && state.phase !== 'gameOver'; t++) {
    const prevStolen = stolen
    step(state, bots.map((b) => ({ player: b.player, tick: state.tick, cmds: b.think(state) })))
    const tick = state.tick
    const ev = state.events
    const byId = new Map(state.pawns.map((p) => [p.id, p]))
    const memOf = (id: number): Mem => {
      let m = mem.get(id)
      if (!m) { const p = byId.get(id)!; m = { owner: p.owner, hits: [], flight: null, stayStart: null, slide: { x: p.x, y: p.y, kbx: 0, kby: 0, inLava: false, hp: p.hp, moveSpeed: p.moveSpeed, alive: p.alive }, closeAt: null, closeDone: -1, closeConfirmed: null }; mem.set(id, m) }
      return m
    }
    const deaths: Moment[] = []
    for (const e of ev) {
      if (e.type === 'shieldReflect' && e.stolen) bump(label + ':shieldSteals')
      if (e.type === 'obstacleDestroyed') bump(label + ':pillarsDestroyed')
      if (e.type === 'phase' && e.phase === 'fight') {
        round++
        teamAt = new Map(state.slots.map((s) => [s.id, teamOf(state, s.id)]))
        clutch = new Map(); zooms = []
        for (const m of mem.values()) { m.hits = []; m.flight = null; m.stayStart = null; m.closeAt = null; m.closeConfirmed = null }
      } else if (e.type === 'damage') {
        const p = byId.get(e.target); if (!p) continue
        const m = memOf(e.target)
        if (e.amount > 0 && p.alive && p.hp <= CLOSE_HP * p.maxHp && e.source !== null && e.source !== p.owner && m.closeDone !== round) m.closeAt = tick
        let src = e.source, pillar = false
        if (src === null && e.cause === 'obstacle') {
          let best = Infinity
          for (const o of ev) if (o.type === 'obstacleDestroyed' && o.by != null) { const d = Math.hypot(o.x - e.x, o.y - e.y); if (d < OBSTACLE_EXPLODE_RADIUS + 1 && d < best) { best = d; src = o.by } }
          pillar = src !== null
        }
        if (src === null || src === p.owner) continue
        let reflected = false
        for (const o of ev) if ((o.type === 'projectileHit' || o.type === 'projectileExpire') && prevStolen.has(o.id)) { const s = prevStolen.get(o.id)!; if (s.owner === src && (e.cause ?? '') === s.spell) reflected = true }
        if (reflected) bump(label + ':stolenHits')
        let detonation = false
        if (e.cause === 'lightning') for (const o of ev) if (o.type === 'explosion' && o.spell === 'lightning' && Math.hypot(o.x - e.x, o.y - e.y) < o.radius + 1) detonation = true
        if (detonation) bump(label + ':detonationHits')
        const hit: Hit = { tick, src, kb: e.kb, cause: e.cause ?? '', x: e.x, y: e.y, reflected, detonation, pillar, flightLen: 0, flightEnd: tick, x0: e.x, y0: e.y }
        if (e.kb > 0) {
          if (m.flight) { m.flight.flightEnd = tick; m.flight.flightLen = Math.hypot(e.x - m.flight.x0, e.y - m.flight.y0) }
          if (e.kb >= FLIGHT_START) { hit.flightEnd = null; m.flight = hit }
        }
        m.hits.push(hit)
        while (m.hits.length && m.hits[0].tick < tick - S(SEAL_MAX)) m.hits.shift()
        // finish zoom: the hit lands on the last of its side with exactly two sides standing
        if (e.kb > 0 && state.phase === 'fight') {
          const sides = new Set<number>(); let mates = 0
          for (const q of state.pawns) if (q.alive && isRoundParticipant(state, q.owner)) { const s = teamOf(state, q.owner); sides.add(s); if (s === teamOf(state, p.owner) && q.id !== p.id) mates++ }
          const deciding = mates === 0 && (p.alive ? sides.size === 2 : sides.size <= 1)
          if (deciding) {
            const lethal = !p.alive || lavaOutcome(state, { x: p.x, y: p.y }, { x: p.vx - p.walkVx, y: p.vy - p.walkVy }, p.hp, p.moveSpeed, state.arena.layer).lethal
            if (lethal) { zooms.push({ pawn: p.id, tick, hit }); bump(label + ':zoom') }
          }
        }
      } else if (e.type === 'teleport') {
        const p = byId.get(e.pawn), m = mem.get(e.pawn)
        if (!p || !m || state.phase !== 'fight' || !m.slide.alive) continue
        if (!isDeniedEscape(m.slide, m.slide, e.toX, e.toY, { settings: state.settings, arena: state.arena })) continue
        let pusher: Hit | null = null
        for (let i = m.hits.length - 1; i >= 0; i--) if (m.hits[i].kb > 0) { pusher = m.hits[i]; break }
        const live = pusher && (pusher.flightEnd === null || pusher.flightEnd >= (m.stayStart ?? tick) - S(SEAL_GRACE) || pusher.tick >= (m.stayStart ?? tick))
        bump(label + ':denied')
        if (live) bump(label + ':deniedWithPusher')
        moments.push({ kind: 'denied', actor: p.owner, victims: live ? [pusher!.src] : [], from: (live ? pusher!.tick : tick - S(1)) - S(0.5), to: tick + S(1), tick, base: 1.2, stakes: 1, spectacle: 1, novelty: novelty('denied', p.owner), traits: new Set() })
      } else if (e.type === 'death') {
        if (e.cause === 'disconnect') continue
        const m = memOf(e.pawn)
        if (m.flight) { m.flight.flightEnd = tick; m.flight.flightLen = Math.hypot((e.x ?? 0) - m.flight.x0, (e.y ?? 0) - m.flight.y0); m.flight = null }
        let seal: Hit | null = null
        if (e.cause === 'lava') {
          let h: Hit | null = null
          for (let i = m.hits.length - 1; i >= 0; i--) if (m.hits[i].kb > 0) { h = m.hits[i]; break }
          const E = m.stayStart
          if (h && E !== null && tick - h.tick <= S(SEAL_MAX) && (h.tick >= E || h.flightEnd === null || h.flightEnd >= E - S(SEAL_GRACE))) seal = h
        } else {
          for (let i = m.hits.length - 1; i >= 0; i--) if (m.hits[i].tick === tick) { seal = m.hits[i]; break }
        }
        bump(label + ':deaths')
        if (e.cause === 'obstacle') bump(label + ':deathByPillar')
        const kill = tally.death(e.owner, e.killer, tick / TICK_HZ)
        if (kill && kill.chain >= 2) {
          let mm = chainMoment.get(kill.killer)
          if (!mm || kill.chain === 2) { mm = { kind: 'multiKnockout', actor: kill.killer, victims: [], from: tick - S(3.5), to: tick + S(0.5), tick, base: 0, stakes: 1, spectacle: 1, novelty: novelty('multi', kill.killer), traits: new Set(), n: 0 }; moments.push(mm); chainMoment.set(kill.killer, mm) }
          mm.n = kill.chain; mm.base = 0.9 * kill.chain; mm.to = tick + S(0.5); mm.victims.push(e.owner)
        }
        if (!seal) { bump(label + (e.killer === null ? ':uncredited' : ':creditedUnsealed')); continue }
        bump(label + ':knockout')
        if (seal.src !== e.killer) bump(label + ':sealNotKiller')
        push('sealDelta', (tick - seal.tick) / TICK_HZ); if (e.cause === 'lava') push('sealDeltaLava', (tick - seal.tick) / TICK_HZ); push('sealKb', seal.kb)
        const traits = new Set<string>()
        if (seal.reflected) traits.add('reflected')
        if (seal.detonation) traits.add('detonation')
        if (seal.pillar) traits.add('pillarBlast')
        if (seal.flightLen > LONG_FLIGHT) traits.add('longFlight')
        push('sealFlight', seal.flightLen)
        for (const tr of traits) bump(label + ':' + tr)
        const mult = (traits.has('reflected') ? 1.8 : 1) * (traits.has('detonation') ? 1.6 : 1) * (traits.has('pillarBlast') ? 1.5 : 1) * (traits.has('longFlight') ? 1.3 : 1)
        const spectacle = 0.85 + 0.15 * Math.min(2, seal.kb / 1500)
        const km: Moment = { kind: 'knockout', actor: seal.src, victims: [e.owner], from: seal.tick - S(0.5), to: tick + S(0.5), tick: seal.tick, base: mult, stakes: 1, spectacle, novelty: novelty('knockout', seal.src), traits }
        moments.push(km); deaths.push(km)
        const z = zooms.find((zz) => zz.pawn === e.pawn)
        if (z) { push('zoomLead', (tick - z.tick) / TICK_HZ); if (z.hit === seal) bump(label + ':zoomExact') }
      } else if (e.type === 'roundWin') {
        bump(label + ':rounds')
        if (e.team === -1) bump(label + ':draw')
        const last = deaths[deaths.length - 1]
        const decides = !!gameWinners(state)
        if (last) {
          last.traits.add('roundDecider'); last.stakes = 1.5; bump(label + ':roundDecider')
          push('decDelta', (last.to - S(0.5) - last.tick) / TICK_HZ)
          if (decides) { last.traits.add('matchDecider'); last.stakes = 2.5; bump(label + ':matchDecider'); matchDecider = last }
          if (zooms.some((z) => z.hit.tick === last.tick && z.hit.src === last.actor)) bump(label + ':deciderZoomed')
        } else bump(label + ':roundUndecided')
        if (zooms.length) bump(label + ':roundsZoomed')
        bump(label + ':zoomFalse', zooms.filter((z) => byId.get(z.pawn)?.alive).length)
        for (const [pl, c] of clutch) if (e.players.includes(pl) && state.pawns.some((q) => q.owner === pl && q.alive)) {
          bump(label + ':clutch')
          moments.push({ kind: 'clutch', actor: pl, victims: [], from: Math.max(c.at, (last?.from ?? tick) ), to: tick + S(1), tick, base: 1.5 + 0.5 * (c.enemies - 2), stakes: decides ? 2.5 : 1.5, spectacle: 1, novelty: novelty('clutch', pl), traits: new Set() })
        }
        const top = Math.max(...state.scores.map((s) => s.score))
        for (const s of state.scores) deficit.set(s.id, Math.max(deficit.get(s.id) ?? 0, top - s.score))
        // close calls still pending at round end are confirmed by surviving it
        for (const [id, m] of mem) if (m.closeAt !== null && byId.get(id)?.alive) { confirmClose(m, id); }
      } else if (e.type === 'gameOver') {
        if (e.winners.some((w) => (deficit.get(w) ?? 0) >= 2)) { bump(label + ':comeback'); if (matchDecider) matchDecider.traits.add('comeback') }
      }
    }
    function confirmClose(m: Mem, id: number) {
      m.closeDone = round; m.closeConfirmed = tick
      const at = m.closeAt!; m.closeAt = null
      bump(label + ':closeCall')
      moments.push({ kind: 'closeCall', actor: m.owner, victims: [], from: at - S(0.5), to: tick + S(0.5), tick: at, base: 0.8, stakes: 1, spectacle: 1, novelty: novelty('closeCall', m.owner), traits: new Set() })
      void id
    }
    if (state.phase === 'fight') {
      const alive = new Map<number, number[]>()
      for (const q of state.pawns) if (q.alive && isRoundParticipant(state, q.owner)) { const s = teamAt.get(q.owner) ?? q.owner; alive.set(s, [...(alive.get(s) ?? []), q.owner]) }
      for (const [side, a] of alive) {
        const size = [...teamAt.values()].filter((x) => x === side).length
        if (size < 2 || a.length !== 1) continue
        let enemies = 0
        for (const [s2, a2] of alive) if (s2 !== side) enemies += a2.length
        if (enemies >= 2 && !clutch.has(a[0])) clutch.set(a[0], { enemies, at: tick })
        else if (enemies >= 2) clutch.get(a[0])!.enemies = Math.max(clutch.get(a[0])!.enemies, enemies)
      }
    }
    for (const p of state.pawns) {
      const m = memOf(p.id)
      if (m.flight) {
        const sp = Math.hypot(p.vx - p.walkVx, p.vy - p.walkVy)
        if (!p.alive || sp < FLIGHT_STOP) { m.flight.flightEnd = tick; m.flight.flightLen = Math.hypot(p.x - m.flight.x0, p.y - m.flight.y0); m.flight = null }
      }
      if (p.alive && p.lavaTicks > 0) { if (m.stayStart === null) m.stayStart = tick } else m.stayStart = null
      // close call: alive and out of the lava CLOSE_SAFE after the hit
      if (m.closeAt !== null && tick - m.closeAt >= S(CLOSE_SAFE)) {
        if (p.alive && p.lavaTicks === 0 && state.phase === 'fight') confirmClose(m, p.id)
        else if (!p.alive) { m.closeAt = null; bump(label + ':closeCallDied') }
      }
      if (m.closeConfirmed !== null && !p.alive && tick - m.closeConfirmed <= S(3)) { bump(label + ':closeCallThenDied3s'); m.closeConfirmed = null }
      writeSlide(m.slide, p); m.slide.hp = p.hp; m.slide.moveSpeed = p.moveSpeed; m.slide.alive = p.alive
    }
    const st = new Map<number, { owner: number; spell: string }>()
    for (const pr of state.projectiles) if (pr.data.origOwner !== undefined && pr.data.origOwner !== pr.owner) st.set(pr.id, { owner: pr.owner, spell: pr.spell })
    stolen = st
  }
  bump(label + ':matches'); bump(label + ':minutes', state.tick / TICK_HZ / 60)
  if (state.phase !== 'gameOver') bump(label + ':unfinished')
  for (const m of moments) bump(label + ':m:' + m.kind)
  // reel: top 3 by score x local relevance, no overlapping windows
  const rel = (m: Moment) => (m.actor === local || m.victims.includes(local) ? 1.5 : 1)
  const ranked = [...moments].sort((a, b) => score(b) * rel(b) - score(a) * rel(a))
  const reel: Moment[] = []
  for (const m of ranked) { if (reel.length >= 3) break; if (reel.some((r) => m.from < r.to && r.from < m.to)) continue; reel.push(m) }
  for (const m of reel) { bump(label + ':reel:' + m.kind + ([...m.traits].filter((t) => t !== 'longFlight').length ? '+' + [...m.traits].filter((t) => t !== 'longFlight').sort().join('+') : '')); if (m.actor === local || m.victims.includes(local)) bump(label + ':reelLocal') }
  if (matchDecider && reel.includes(matchDecider)) bump(label + ':reelHasMatchDecider')
  push('reelLenS', reel.reduce((a, m) => a + Math.min(6, (m.to - m.from) / TICK_HZ), 0))
}

const M = Number(process.argv[2] ?? 4)
const ffa10: BotDifficulty[] = ['medium', 'medium', 'medium', 'medium', 'medium', 'hard', 'hard', 'hard', 'hard', 'hard']
const t0 = Date.now()
for (let i = 0; i < M; i++) runMatch('ffa10', { ...DEFAULT_SETTINGS, teamMode: 'ffa', winScore: 3, startGold: 50, roundGold: 15, killGold: 2, winGold: 3 }, ffa10, null, 100 + i, 60, 5)
for (let i = 0; i < M * 3; i++) runMatch('duel', { ...DEFAULT_SETTINGS }, i % 2 ? ['hard', 'brutal'] : ['brutal', 'uber'], null, 200 + i, 30, 0)
for (let i = 0; i < M; i++) runMatch('teams3v3', { ...DEFAULT_SETTINGS, teamMode: 'teams', winScore: 5 }, ['medium', 'hard', 'hard', 'medium', 'hard', 'hard'], [0, 0, 0, 1, 1, 1], 300 + i, 40, 1)
for (let i = 0; i < M; i++) runMatch('ffa6', { ...DEFAULT_SETTINGS, teamMode: 'ffa', winScore: 3 }, ['hard', 'hard', 'brutal', 'brutal', 'uber', 'medium'], null, 400 + i, 40, 0)
const groups = new Map<string, string[]>()
for (const [k, v] of [...C].sort()) { const [g, ...rest] = k.split(':'); (groups.get(g) ?? groups.set(g, []).get(g)!).push(`${rest.join(':')}=${Math.round(v * 10) / 10}`) }
for (const [g, l] of groups) console.log(g + '\n  ' + l.join('  '))
const q = (k: string) => `${k} p50 ${pct(D[k], .5)?.toFixed(2)} p75 ${pct(D[k], .75)?.toFixed(2)} p90 ${pct(D[k], .9)?.toFixed(2)} p95 ${pct(D[k], .95)?.toFixed(2)} max ${Math.max(...(D[k] ?? [0])).toFixed(2)} n ${(D[k] ?? []).length}`
for (const k of ['sealDeltaLava', 'sealKb', 'sealDelta', 'decDelta', 'sealFlight', 'zoomLead', 'reelLenS']) console.log(q(k))
const dd = D.decDelta ?? []
console.log('decider hit->death within 4.4/5.1/6.7/7.1/7.4 s:', [4.4, 5.1, 6.7, 7.1, 7.4].map((w) => (dd.filter((x) => x <= w).length / dd.length).toFixed(2)).join(' '))
console.log('wall s', ((Date.now() - t0) / 1000).toFixed(1))
