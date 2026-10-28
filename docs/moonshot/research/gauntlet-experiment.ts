// Research experiment for docs/moonshot/specs/daily.md: a five-wave gauntlet driven from outside
// the sim (like PracticeScenario), with a bot of each tier standing in for the human (player 0).
// Run from the repo root: npx vite-node <this file> [seeds] [shrinkSeconds] [lives]
import { BotController, BOT_PRESETS } from '../../../src/bots'
import { DEFAULT_SETTINGS, createMatch, step, setPlayerConnected } from '../../../src/sim'
import { TICK_HZ, type BotDifficulty, type PlayerSlot, type SimState } from '../../../src/sim'

const SEEDS = Number(process.argv[2] ?? 12)
const SHRINK = Number(process.argv[3] ?? 10)
const LIVES = Number(process.argv[4] ?? 3)
const VARIANT = process.argv[5] ?? 'base'
const BASE = Number(process.argv[6] ?? 9)
const OMEN = process.argv[7] ?? 'none'
const OMENS: Record<string, object> = { none: {}, bloodmoon: { kbMultiplier: 1.5 }, slick: { friction: 0.975 }, hungry: { lavaDps: 150 }, glass: { dmgMultiplier: 1.5 }, lean: { startGold: 15, roundGold: 6 }, feast: { startGold: 80 }, cold: { lavaDps: 60 } }

type Wave = { bots: BotDifficulty[]; champion?: boolean }
const WAVES: Wave[] = VARIANT === 'pyre'
  ? [{ bots: ['easy'] }, { bots: ['easy', 'easy'] }, { bots: ['medium', 'easy'] }, { bots: ['medium', 'medium'] }, { bots: ['brutal'], champion: true }]
  : VARIANT === 'soft'
  ? [{ bots: ['easy'] }, { bots: ['easy', 'easy'] }, { bots: ['medium'] }, { bots: ['medium', 'easy'] }, { bots: ['hard'], champion: true }]
  : [{ bots: ['easy'] }, { bots: ['easy', 'easy'] }, { bots: ['medium', 'easy'] }, { bots: ['medium', 'medium'] }, { bots: ['hard'], champion: true }]

function run(player: BotDifficulty, seed: number) {
  const slots: PlayerSlot[] = [{ id: 0, name: 'you', color: 0xff7700, team: 0, kind: 'human' }]
  const waveOf: number[] = []
  let id = 1
  WAVES.forEach((w, wi) => w.bots.forEach((d) => { slots.push({ id, name: `${d}${id}`, color: 0x2e7bff, team: 1, kind: 'bot', difficulty: d }); waveOf[id] = wi; id++ }))
  const state: SimState = createMatch({ ...DEFAULT_SETTINGS, teamMode: 'teams', winScore: WAVES.length, shopSeconds: 4,
    botsReplaceLeavers: false, spectatorBets: false, bounties: false, ...OMENS[OMEN] }, slots, seed)
  const seat = (wave: number) => {
    for (let b = 1; b < slots.length; b++) {
      const on = waveOf[b] === wave
      setPlayerConnected(state, b, on)
      const pawn = state.pawns.find((p) => p.owner === b)!
      if (!on) pawn.alive = false
      if (on && WAVES[wave].champion) state.scores.find((s) => s.id === b)!.gold += 80
    }
  }
  seat(0)
  const me = new BotController(0, player, seed * 31)
  const bots = slots.slice(1).map((s) => new BotController(s.id, s.difficulty!, seed))
  let wave = 0, lives = LIVES, fightTicks = 0, fightStart = -1, cleared = 0
  const waveTimes: number[] = []
  let waveFight = 0
  let target = -1
  const max = 1800 * TICK_HZ
  for (let t = 0; t < max && state.phase !== 'gameOver' && lives > 0; t++) {
    const inputs = [{ player: 0, tick: state.tick, cmds: me.think(state) }, ...bots.map((b) => ({ player: b.player, tick: state.tick, cmds: b.think(state) }))]
    const before = state.phase
    step(state, inputs)
    if (SHRINK > 0 && state.phase === 'fight' && before !== 'fight') {
      const active = state.pawns.filter((p) => p.alive).length
      const layer = Math.min(15, BASE + active)
      if (layer < state.arena.layer) {
        const maxR = (layer - 1) * 100 - 250
        let far = 0
        for (const p of state.pawns) if (p.alive) far = Math.max(far, Math.hypot(p.x, p.y))
        const k = far > maxR ? maxR / far : 1
        for (const p of state.pawns) { p.x *= k; p.y *= k; p.moveTarget = null }
        state.arena.layer = layer
      }
      state.arena.nextShrinkTick = state.tick + Math.round(SHRINK * TICK_HZ)
      target = state.arena.nextShrinkTick
    }
    if (SHRINK > 0 && state.phase === 'fight' && state.arena.nextShrinkTick !== target && state.arena.nextShrinkTick > 0) {
      state.arena.nextShrinkTick = state.tick + Math.round(SHRINK * TICK_HZ) - 1
      target = state.arena.nextShrinkTick
    }
    if (state.phase === 'fight') { fightTicks++; waveFight++ }
    for (const e of state.events) {
      if (e.type === 'roundWin') {
        if (e.team === 0) {
          cleared++; waveTimes.push(waveFight / TICK_HZ); waveFight = 0
          wave++
          if (wave < WAVES.length) seat(wave)
        } else lives--
      }
    }
  }
  return { cleared, lives, fight: fightTicks / TICK_HZ, total: state.tick / TICK_HZ, waveTimes }
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN }
console.log(`variant ${VARIANT}, shrink ${SHRINK}s (0 = classic), fight layer base, base layer ${BASE}, lives ${LIVES}, omen ${OMEN}, seeds ${SEEDS}, hz ${TICK_HZ}`)
for (const tier of ['easy', 'medium', 'hard', 'brutal', 'uber'] as BotDifficulty[]) {
  const cleared: number[] = [], fight: number[] = [], total: number[] = [], all5: number[] = []
  const perWave: number[][] = [[], [], [], [], []]
  const t0 = Date.now()
  for (let s = 0; s < SEEDS; s++) {
    const r = run(tier, 1000 + s)
    cleared.push(r.cleared); fight.push(r.fight); total.push(r.total)
    if (r.cleared === 5) all5.push(r.fight)
    r.waveTimes.forEach((w, i) => perWave[i].push(w))
  }
  const hist = [0, 1, 2, 3, 4, 5].map((k) => cleared.filter((c) => c === k).length).join('/')
  console.log(`${tier.padEnd(7)} waves cleared 0..5: ${hist} | p50 ${pct(cleared, .5)} | fight p50 ${pct(fight, .5).toFixed(0)} s, run p50 ${pct(total, .5).toFixed(0)} s (shop 4 s) | wave clear p50 ${perWave.map((w) => w.length ? pct(w, .5).toFixed(0) : '-').join(',')} | ${Date.now() - t0} ms`)
}
void BOT_PRESETS
