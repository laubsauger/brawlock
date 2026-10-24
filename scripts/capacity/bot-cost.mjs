// Offline component timings on the actual host. No sockets, storage or live services.
// Ten combatants stay constant. This measures AI decisions, not total marginal bot-seat cost.
import { createBot } from '../../src/bots/index.ts'
import { createMatch, step } from '../../src/sim/index.ts'
import { DEFAULT_SERVER_CONFIG } from '../../src/net/server.ts'
import { cpus, totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'
const percentile = (a, p) => { const values = a.slice().sort((x, y) => x - y); return values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] }
const rows = []
function measure(difficulty, seed, seconds) {
  const slots = Array.from({ length: 10 }, (_, id) => ({ id, name: `Bot ${id}`, color: id + 1, kind: 'bot', difficulty, team: id }))
  const state = createMatch({ ...DEFAULT_SERVER_CONFIG.quickplay.settings, winScore: 99, shopSeconds: 8 }, slots, seed)
  const bots = slots.map(({ id }) => createBot(id, difficulty, seed * 31 + id))
  const decisions = [], activeDecisions = [], steps = [], counters = { casts: 0, moves: 0, purchases: 0, fightTicks: 0, aliveFightCalls: 0, rounds: 0 }
  let aiMs = 0, simMs = 0, activeAiMs = 0
  for (let tick = 0; tick < seconds * 60 && state.phase !== 'gameOver'; tick++) {
    if (state.phase === 'fight') counters.fightTicks++
    const inputs = bots.map(bot => {
      const active = state.phase === 'fight' && state.pawns.some(p => p.owner === bot.player && p.alive)
      const begin = performance.now(), cmds = bot.think(state), elapsed = performance.now() - begin
      aiMs += elapsed; decisions.push(elapsed)
      if (active) { activeAiMs += elapsed; activeDecisions.push(elapsed); counters.aliveFightCalls++ }
      for (const c of cmds) { if (c.kind === 'cast') counters.casts++; if (c.kind === 'move') counters.moves++; if (['buySpell', 'buyItem', 'buyMastery'].includes(c.kind)) counters.purchases++ }
      return { player: bot.player, tick: state.tick, cmds }
    })
    const begin = performance.now(); step(state, inputs); const elapsed = performance.now() - begin
    simMs += elapsed; steps.push(elapsed)
  }
  const simulatedSeconds = state.tick / 60
  return { difficulty, seed, simulatedSeconds, ...counters, rounds: state.round,
    aiMs, simMs, aiCorePct: aiMs / simulatedSeconds / 10, simulationCorePct: simMs / simulatedSeconds / 10,
    aiCorePctPerBot: aiMs / simulatedSeconds / 10 / 10,
    activeAiCorePctPerBot: activeDecisions.length ? activeAiMs / activeDecisions.length * 60 / 10 : null,
    thinkUsP50: percentile(decisions, .5) * 1000, thinkUsP95: percentile(decisions, .95) * 1000,
    activeThinkUsP95: percentile(activeDecisions, .95) * 1000, stepUsP95: percentile(steps, .95) * 1000 }
}
measure('hard', 99, 30) // Warm code before recording.
for (const seed of [101, 202, 303]) for (const difficulty of ['medium', 'hard', 'brutal']) rows.push(measure(difficulty, seed, 300))
console.log(JSON.stringify({ kind: 'offline-component-profile', at: new Date().toISOString(), node: process.version,
  host: { cpus: cpus().length, model: cpus()[0].model, memoryMb: totalmem() / 1048576 },
  sourceNet: __NET_ID__, scope: '1 core = 100%; pure AI think and simulation timings at 60 ticks/s, ten combatants; no transport, bot plans, prediction, rendering or account service', rows }, null, 2))
