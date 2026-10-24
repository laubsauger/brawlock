import { monitorEventLoopDelay } from 'node:perf_hooks'
import { createHeadlessClient } from '../../src/testing/headlessClient.ts'
import { DEFAULT_SERVER_CONFIG } from '../../src/net/server.ts'

const options = JSON.parse(process.argv[2])
if (!(/^ws:\/\/127\.0\.0\.1:\d+$/.test(options.base) || options.base === `wss://eu.brawlock.osc.link/_capacity/${options.run}`) || !Number.isInteger(options.humans) || options.humans < 1 || options.humans > 10 || !Number.isInteger(options.players) || options.players < Math.max(2, options.humans) || options.players > 10) throw new Error('Capacity clients require an isolated target and 1–10 humans')
const metrics = { sentBytes: 0, receivedBytes: 0, sentFrames: 0, receivedFrames: 0, commands: 0, starts: 0, results: 0 }
const NativeWebSocket = globalThis.WebSocket
globalThis.WebSocket = class extends NativeWebSocket {
  constructor(...args) { super(...args); this.addEventListener('message', (e) => { if (typeof e.data === 'string') { metrics.receivedBytes += Buffer.byteLength(e.data); metrics.receivedFrames++ } }) }
  send(data) { metrics.sentBytes += Buffer.byteLength(data); metrics.sentFrames++; super.send(data) }
}
const clients = []
const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable()
let closing = false, lastCpu = process.cpuUsage(), lastAt = performance.now()
const stop = (code = 0) => {
  if (closing) return
  closing = true
  for (const client of clients) client.session.leave()
  loop.disable()
  setTimeout(() => process.exit(code), 500)
}
process.on('SIGTERM', () => stop()); process.on('SIGINT', () => stop())
setTimeout(stop, 13 * 60_000).unref()
const until = async (fn, label) => {
  const deadline = performance.now() + 20_000
  while (!fn()) { if (performance.now() > deadline) throw new Error(`Timeout: ${label}`); await new Promise(r => setTimeout(r, 50)) }
}
try {
  let code
  for (let i = 0; i < options.humans; i++) {
    const key = `${options.run}-${options.room}-${i}`
    const client = createHeadlessClient(options.base, { key, device: `device-${key}`, profileId: `profile-${key}`, name: `Load ${i + 1}`, build: options.net, timeScale: 1,
      onCommands: n => { metrics.commands += n } })
    clients.push(client)
    // The owner probes before creating, just as a browser does. Creating in the
    // coordinator first can expire an isolated room during cold region probes.
    if (i === 0) code = await client.online.createRoom('test')
    await client.session.join(code)
    if (client.lobby().status !== 'open') throw new Error(client.lobby().error ?? 'Join failed')
  }
  const owner = clients[0]
  owner.session.updateSettings({ ...DEFAULT_SERVER_CONFIG.quickplay.settings, shopSeconds: 8 })
  for (let i = options.humans; i < options.players; i++) owner.session.addBot(i === options.players - 1 ? 'brutal' : i === options.players - 2 ? 'medium' : 'hard')
  await until(() => owner.lobby().slots.length === options.players && owner.lobby().settings?.shopSeconds === 8, 'full room setup')
  owner.session.startMatch()
  await until(() => clients.every(c => c.screen() === 'match'), 'all clients in match')
  console.log(JSON.stringify({ event: 'room.ready', room: options.room, humans: options.humans, bots: options.players - options.humans }))
  const seenMatches = new Set(), seenResults = new Map()
  setInterval(() => {
    if (closing) return
    const now = performance.now(), cpu = process.cpuUsage(), elapsed = now - lastAt
    const states = clients.map(c => c.shown()), debug = clients.map(c => c.session.debug())
    const first = states[0]
    const match = debug[0].matchId
    if (first && !seenMatches.has(match)) { seenMatches.add(match); metrics.starts++ }
    for (const c of clients) {
      if (c.results.length > (seenResults.get(c) ?? 0)) { if (c === owner) metrics.results += c.results.length - (seenResults.get(c) ?? 0); seenResults.set(c, c.results.length) }
      if (c.screen() === 'results' && !c.lobby().ready?.[c.lobby().localPlayer]) c.session.rematch()
    }
    const peers = clients.flatMap(c => c.session.netStats()?.peers ?? [])
    console.log(JSON.stringify({ event: 'sample', room: options.room, at: Date.now(), ...metrics, humans: clients.length,
      phase: first?.phase, round: first?.round, tick: first?.tick, confirmedTick: debug[0].streamTick, match,
      generatorCpuPct: (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / (elapsed * 10), generatorLoopMaxMs: loop.max / 1e6, generatorRssMb: process.memoryUsage.rss() / 1048576,
      rttMs: peers.map(p => p.rttMs), ackMs: peers.map(p => p.inputAckLagMs),
      desyncs: debug.reduce((n, d) => n + d.streamDesyncs, 0), checks: debug.reduce((n, d) => n + d.streamChecks, 0),
      active: clients.filter(c => c.screen() === 'match').length,
      errors: clients.map(c => c.lobby().error).filter(Boolean),
    }))
    loop.reset(); lastAt = now; lastCpu = cpu
  }, 1000)
} catch (error) { console.log(JSON.stringify({ event: 'error', room: options.room, message: error.message })); stop(1) }
