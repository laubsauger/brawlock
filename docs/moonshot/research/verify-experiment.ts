// Scratch: can a server re-create a gauntlet run from the human seat's commands alone?
// Run 1: a Hard bot plays seat 0; its per-tick commands are recorded (wire-encoded, JSON round trip).
// Run 2: fresh bots, the recorded commands replayed into seat 0. Compare hashes and outcomes.
import { BotController } from '../../../src/bots'
import { DEFAULT_SETTINGS, createMatch, step, setPlayerConnected, hashState } from '../../../src/sim'
import { encodeCmd, decodeCmd } from '../../../src/net/stream'
import { TICK_HZ, type BotDifficulty, type InputCommand, type PlayerSlot, type SimState } from '../../../src/sim'

const WAVES: BotDifficulty[][] = [['easy'], ['easy', 'easy'], ['medium', 'easy'], ['medium', 'medium'], ['hard']]
function play(seed: number, salt: number, source: { bot?: BotController; tape?: Map<number, InputCommand[]> }) {
  const slots: PlayerSlot[] = [{ id: 0, name: 'you', color: 0xff7700, team: 0, kind: 'human' }]
  const waveOf: number[] = []
  let id = 1
  WAVES.forEach((w, wi) => w.forEach((d) => { slots.push({ id, name: d + id, color: 0x2e7bff, team: 1, kind: 'bot', difficulty: d }); waveOf[id] = wi; id++ }))
  const state: SimState = createMatch({ ...DEFAULT_SETTINGS, teamMode: 'teams', winScore: 5, shopSeconds: 4, botsReplaceLeavers: false, spectatorBets: false, bounties: false }, slots, seed)
  const seat = (wave: number) => { for (let b = 1; b < slots.length; b++) { const on = waveOf[b] === wave; setPlayerConnected(state, b, on); if (!on) state.pawns.find((p) => p.owner === b)!.alive = false } }
  seat(0)
  const bots = slots.slice(1).map((s) => new BotController(s.id, s.difficulty!, (seed ^ salt) >>> 0))
  const tape = new Map<number, unknown[]>()
  let wave = 0, lives = 2, cmdsTotal = 0
  const hashes: number[] = []
  for (let t = 0; t < 900 * TICK_HZ && state.phase !== 'gameOver' && lives > 0; t++) {
    const mine = source.bot ? source.bot.think(state) : (source.tape!.get(state.tick) ?? [])
    if (source.bot && mine.length) { tape.set(state.tick, mine.map(encodeCmd)); cmdsTotal += mine.length }
    step(state, [{ player: 0, tick: state.tick, cmds: mine }, ...bots.map((b) => ({ player: b.player, tick: state.tick, cmds: b.think(state) }))])
    for (const e of state.events) if (e.type === 'roundWin') { if (e.team === 0) { wave++; if (wave < WAVES.length) seat(wave) } else lives-- }
    if (state.tick % (10 * TICK_HZ) === 0) hashes.push(hashState({ ...state, events: [] }))
  }
  return { wave, lives, tick: state.tick, hash: hashState({ ...state, events: [] }), hashes, tape, cmdsTotal }
}
let ok = 0
for (let s = 0; s < 6; s++) {
  const seed = 2026_10_28 + s, salt = 0x9e3779b9 * (s + 1) >>> 0
  const a = play(seed, salt, { bot: new BotController(0, 'hard', seed * 7) })
  const json = JSON.stringify([...a.tape])
  const tape = new Map<number, InputCommand[]>(JSON.parse(json).map(([t, w]: [number, unknown[]]) => [t, w.map((x) => decodeCmd(x as never)!).filter(Boolean)]))
  const b = play(seed, salt, { tape })
  const same = a.hash === b.hash && a.wave === b.wave && a.tick === b.tick
  if (same) ok++
  const c = play(seed, salt ^ 1, { tape })
  console.log(`seed ${seed}: waves ${a.wave} lives ${a.lives} ${(a.tick / TICK_HZ).toFixed(0)} s | replay ${same ? 'identical' : 'DIFFERS'} | ${a.cmdsTotal} cmds on ${a.tape.size} ticks, ${json.length} bytes JSON | other salt: waves ${c.wave}, ${(c.tick / TICK_HZ).toFixed(0)} s`)
}
console.log(`${ok}/6 identical`)
import { gzipSync } from 'node:zlib'
{ const a = play(2026_10_28, 7, { bot: new BotController(0, 'hard', 1) }); const raw = JSON.stringify([...a.tape]); let prev = 0; const delta = JSON.stringify([...a.tape].map(([t, w]) => { const d = t - prev; prev = t; return [d, ...(w as unknown[]).map((c) => Array.isArray(c) ? c.map((v) => typeof v === 'number' ? Math.round(v * 10) / 10 : v) : c)] })); console.log(`tape ${(a.tick / TICK_HZ).toFixed(0)} s: raw ${raw.length} B, gzip ${gzipSync(raw).length} B, delta+0.1 rounding gzip ${gzipSync(delta).length} B, cmds ${a.cmdsTotal}`) }
