import { readFileSync, mkdirSync, appendFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { cpus, totalmem } from 'node:os'

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const direct = config.base === `https://eu.brawlock.osc.link/_capacity/${config.run}` && /^eu-\d+$/.test(config.run)
if (!(direct || /^http:\/\/127\.0\.0\.1:\d+$/.test(config.base)) || !config.token || !Array.isArray(config.stages) || config.stages.length < 1 || config.stages.length > 8 || config.stages.reduce((n, s) => n + s.seconds, 0) > 720
  || config.stages.some(s => !Number.isInteger(s.rooms) || s.rooms < 1 || s.rooms > 48 || ![1, 10].includes(s.humans) || !Number.isInteger(s.players) || s.players < Math.max(2, s.humans) || s.players > 10 || !Number.isInteger(s.seconds) || s.seconds < 10 || s.seconds > 300)) throw new Error('Explicit bounded isolated capacity configuration required')
const out = resolve(config.out); mkdirSync(out, { recursive: true })
copyFileSync(import.meta.filename, `${out}/runner-used.mjs`)
const buildDir = resolve(config.buildDir)
if (!buildDir.startsWith(resolve('artifacts/capacity') + '/')) throw new Error('Build must be an isolated capacity artifact')
const manifest = JSON.parse(readFileSync(`${buildDir}/manifest.json`, 'utf8'))
manifest.transport = direct ? 'independent direct WSS connections through nginx/TLS; SSH control-plane only' : 'local loopback'
manifest.generator = { node: process.version, cpus: cpus().length, model: cpus()[0].model, memoryMb: totalmem() / 1048576 }
manifest.bundleSha256 = Object.fromEntries(['server', 'worker'].map(name => [name, createHash('sha256').update(readFileSync(`${buildDir}/${name}.mjs`)).digest('hex')]))
const samplesFile = `${out}/samples.jsonl`
const workers = new Set(), results = []
let interrupted = false
const stopWorkers = async () => {
  const children = [...workers]
  for (const child of children) child.kill('SIGTERM')
  await Promise.all(children.map(child => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3000).unref() })))
  workers.clear()
}
process.on('SIGINT', () => { interrupted = true }); process.on('SIGTERM', () => { interrupted = true })
const json = async (path, options = {}) => {
  const r = await fetch(config.base + path, { ...options, headers: { ...options.headers, ...(path.startsWith('/internal/') ? { authorization: `Bearer ${config.token}` } : {}) }, signal: AbortSignal.timeout(5000), redirect: 'error' })
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`)
  return r.json()
}
const wait = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, label) => { const deadline = Date.now() + 30_000; while (!await fn()) { if (Date.now() > deadline) throw new Error(`Timeout: ${label}`); await wait(150) } }
const percentile = (values, p) => { const v = values.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.ceil(v.length * p) - 1)] : null }
const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable()
writeFileSync(`${out}/manifest.json`, JSON.stringify({ ...manifest, run: config.run, stages: config.stages, region: config.region, target: config.base,
  warmupSeconds: 10, guardrails: { serverCpuPct: config.findCeiling ? 150 : 95, cpuHoldSeconds: 10, serverRssMb: 400, generatorLoopMaxMs: 150, generatorHoldSeconds: 5, simulationMinHz: 58.8, simulationHoldSeconds: 5, inputAckP95MaxMs: 500, latencyHoldSeconds: 5 } }, null, 2))
try {
  const baseline = await json('/internal/monitoring')
  if (baseline.region !== `capacity-${config.run}`) throw new Error('Target is not the isolated capacity process')
  if (baseline.rooms.length || baseline.players || baseline.connections) throw new Error('Isolated server must be empty')
  appendFileSync(samplesFile, JSON.stringify({ event: 'baseline', ...baseline }) + '\n')
  for (let index = 0; index < config.stages.length; index++) {
    if (interrupted) break
    const stage = config.stages[index], latest = new Map(), history = [], states = [], failures = []
    let stageClosing = false
    console.log(JSON.stringify({ event: 'stage.start', index, ...stage }))
    for (let room = 0; room < stage.rooms; room++) {
      const child = spawn(process.execPath, [`${buildDir}/worker.mjs`, JSON.stringify({ base: config.base.replace(/^http/, 'ws'), run: config.run, room, humans: stage.humans, players: stage.players, net: manifest.net })], { stdio: ['ignore', 'pipe', 'pipe'] })
      workers.add(child)
      let buffer = ''
      child.stdout.on('data', data => {
        buffer += data
        let end
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
          try {
            const value = JSON.parse(line)
            appendFileSync(samplesFile, JSON.stringify({ stage: index, ...value }) + '\n')
            if (value.event === 'sample' || value.event === 'room.ready') latest.set(room, value)
            if (value.event === 'sample') history.push(value)
            if (value.event === 'error') failures.push(value.message)
          } catch { failures.push('Invalid generator output') }
        }
      })
      child.stderr.on('data', data => appendFileSync(`${out}/generator-stderr.log`, data))
      child.on('error', error => failures.push(error.message))
      child.on('exit', (code, signal) => { if (!stageClosing && !interrupted) failures.push(`Generator exited early (${code ?? signal})`) })
    }
    await until(() => { if (failures.length) throw new Error(failures[0]); return latest.size === stage.rooms }, 'room startup')
    await wait(10_000)
    let highCpu = 0, highGenerator = 0, slowSimulation = 0, highInputLag = 0, reason = null
    const start = Date.now()
    while (Date.now() - start < stage.seconds * 1000 && !interrupted) {
      await wait(1000)
      const [{ server, monitorRttMs }, controlRttMs] = await Promise.all([(async () => {
        const begin = performance.now(), server = await json('/internal/monitoring')
        return { server, monitorRttMs: performance.now() - begin }
      })(), direct ? (async () => {
        const begin = performance.now(), r = await fetch('https://eu.brawlock.osc.link/health', { signal: AbortSignal.timeout(5000), redirect: 'error' })
        if (!r.ok) throw new Error(`Control health HTTP ${r.status}`)
        await r.arrayBuffer(); return performance.now() - begin
      })() : Promise.resolve(null)])
      const row = { event: 'server', stage: index, at: Date.now(), ...server, monitorRttMs, controlRttMs, coordinatorLoopMaxMs: loop.max / 1e6 }
      loop.reset(); states.push(row); appendFileSync(samplesFile, JSON.stringify(row) + '\n')
      highCpu = server.perf.processCpuPct > (config.findCeiling ? 150 : 95) ? highCpu + 1 : 0
      highGenerator = row.coordinatorLoopMaxMs > 150 || [...latest.values()].some(v => v.generatorLoopMaxMs > 150) ? highGenerator + 1 : 0
      const ackP95 = percentile([...latest.values()].flatMap(v => v.ackMs ?? []), .95)
      highInputLag = ackP95 !== null && ackP95 > 500 ? highInputLag + 1 : 0
      const recent = states.slice(-10)
      const delivered = recent.reduce((sum, s) => sum + s.perf.simStepsPerSec, 0) / recent.length / stage.rooms
      slowSimulation = recent.length >= 10 && delivered < 58.8 ? slowSimulation + 1 : 0
      if (failures.length) reason = `generator-error: ${failures[0]}`
      else if ([...latest.values()].some(v => v.desyncs > 0)) reason = 'stream-correctness-failure'
      else if ([...latest.values()].some(v => v.errors?.length)) reason = 'client-disconnect'
      else if (server.perf.rssMb > 400) reason = 'server-memory-guardrail'
      else if (highCpu >= 10) reason = 'server-cpu-guardrail'
      else if (slowSimulation >= 5) reason = 'simulation-throughput-degraded'
      else if (highInputLag >= 5) reason = 'input-confirmation-degraded'
      else if (highGenerator >= 5) reason = 'generator-limited'
      if (reason) break
    }
    stageClosing = true
    await stopWorkers()
    await until(async () => (await json('/health')).rooms === 0, 'room cleanup')
    if (!reason && !interrupted && (history.length === 0 || !history.some(h => h.phase === 'fight' && h.commands > 0 && h.checks > 0))) reason = 'insufficient-combat-proof'
    const byRoom = Array.from({ length: stage.rooms }, (_, room) => {
      const rows = history.filter(h => h.room === room)
      const rates = []
      for (let i = 1; i < rows.length; i++) { const a = rows[i - 1], b = rows[i]; if (a.match === b.match && b.confirmedTick >= a.confirmedTick && a.confirmedTick >= 0) rates.push((b.confirmedTick - a.confirmedTick) * 1000 / (b.at - a.at)) }
      return { room, sampleCount: rows.length, confirmedHzP50: percentile(rates, .5), confirmedHzP05: percentile(rates, .05), commands: rows.at(-1)?.commands ?? 0,
        results: rows.at(-1)?.results ?? 0, checks: rows.at(-1)?.checks ?? 0, desyncs: Math.max(0, ...rows.map(r => r.desyncs ?? 0)),
        sentBytes: rows.at(-1)?.sentBytes ?? 0, receivedBytes: rows.at(-1)?.receivedBytes ?? 0 }
    })
    const report = { ...stage, elapsedSeconds: (Date.now() - start) / 1000, reason, interrupted,
      serverCpuP50: percentile(states.map(s => s.perf.processCpuPct), .5), serverCpuP95: percentile(states.map(s => s.perf.processCpuPct), .95),
      serverRssMaxMb: Math.max(0, ...states.map(s => s.perf.rssMb)), serverLoopP95MaxMs: Math.max(0, ...states.map(s => s.perf.eventLoopP95Ms)), serverStepMaxMs: Math.max(0, ...states.map(s => s.perf.simStepMaxMs)),
      serverHzPerRoomP50: percentile(states.map(s => s.perf.simStepsPerSec / stage.rooms), .5), serverHzPerRoomP05: percentile(states.map(s => s.perf.simStepsPerSec / stage.rooms), .05),
      controlRttP95Ms: percentile(states.map(s => s.controlRttMs), .95), monitorRttP95Ms: percentile(states.map(s => s.monitorRttMs), .95),
      rttP50Ms: percentile(history.flatMap(s => s.rttMs ?? []), .5), rttP95Ms: percentile(history.flatMap(s => s.rttMs ?? []), .95), inputAckP95Ms: percentile(history.flatMap(s => s.ackMs ?? []), .95),
      generatorCpuSumP95: percentile(states.map(s => {
        const peers = byRoom.map(({ room }) => history.filter(h => h.room === room).reduce((nearest, h) => !nearest || Math.abs(h.at - s.at) < Math.abs(nearest.at - s.at) ? h : nearest, null))
        return peers.some(h => !h || Math.abs(h.at - s.at) > 1500) ? NaN : peers.reduce((sum, h) => sum + h.generatorCpuPct, 0)
      }), .95), byRoom }
    results.push(report); writeFileSync(`${out}/results.json`, JSON.stringify({ run: config.run, region: config.region, manifest, results }, null, 2)); console.log(JSON.stringify({ event: 'stage.end', ...report }))
    if (reason || interrupted) break
    await wait(2000)
  }
} finally { await stopWorkers(); loop.disable() }
