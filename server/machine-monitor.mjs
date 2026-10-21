import os from 'node:os'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

/** Linux steal time matters on shared droplets. Unsupported host metrics stay null. */
export function linuxCounters(stat, memory) {
  const fields = /^cpu\s+(.+)$/m.exec(stat)?.[1].trim().split(/\s+/).map(Number)
  const available = /^MemAvailable:\s+(\d+) kB$/m.exec(memory)
  if (!fields || fields.length < 8 || fields.some((v) => !Number.isFinite(v)) || !available) throw new Error('Invalid Linux host counters')
  // guest/guest_nice are already included in user/nice.
  return { total: fields.slice(0, 8).reduce((a, b) => a + b, 0), idle: fields[3] + fields[4], steal: fields[7], availableMb: Number(available[1]) / 1024 }
}
/** Anycast DNS resolvers: near every datacenter, and two operators so one outage stays visible. */
export const INTERNET_ANCHORS = Object.freeze([{ host: '1.1.1.1', port: 443 }, { host: '8.8.8.8', port: 443 }])

/** One TCP handshake: about one network round trip plus any event-loop delay on this host. */
export function tcpConnectMs({ host, port }, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const begin = performance.now()
    const socket = net.connect({ host, port })
    const done = (ms) => { socket.destroy(); resolve(ms) }
    socket.setTimeout(timeoutMs, () => done(null))
    socket.once('connect', () => done(performance.now() - begin))
    socket.once('error', () => done(null))
  })
}

/**
 * `anchors`: fixed public endpoints probed every 10 s. The fastest answer tracks this host's
 * internet path, independent of players: a spike here with a calm event loop is the network.
 */
export function createMachineMonitor({ perf, anchors = [], connect = tcpConnectMs, now = Date.now, read = () => linuxCounters(readFileSync('/proc/stat', 'utf8'), readFileSync('/proc/meminfo', 'utf8')) } = {}) {
  let previous = null
  let anchor = null
  const windows = []
  const probe = async () => {
    const results = await Promise.all(anchors.map((target) => connect(target)))
    const answered = results.filter((ms) => ms !== null)
    anchor = { at: now(), ms: answered.length ? Math.min(...answered) : null }
  }
  const probeTimer = anchors.length ? setInterval(() => void probe(), 10_000) : null
  probeTimer?.unref()
  if (anchors.length) void probe()
  const sample = () => {
    try {
      const counters = os.platform() === 'linux' ? read() : null
      const delta = counters && previous ? counters.total - previous.total : 0
      const host = { cpus: os.cpus().length, totalMb: os.totalmem() / 1048576, load1: os.loadavg()[0],
        cpuPct: delta > 0 ? 100 * (delta - (counters.idle - previous.idle)) / delta : null,
        stealPct: delta > 0 ? 100 * (counters.steal - previous.steal) / delta : null,
        availableMb: counters?.availableMb ?? null }
      previous = counters
      windows.push({ at: now(), host, perf: perf?.snapshot() ?? null })
      while (windows.length > 10) windows.shift()
    } catch {
      windows.push({ at: now(), host: null, perf: perf?.snapshot() ?? null })
      while (windows.length > 10) windows.shift()
    }
  }
  const timer = setInterval(sample, 1000); timer.unref()
  return {
    snapshot() {
      const recent = windows.filter((w) => now() - w.at <= 12_000)
      const max = (rows, key) => rows.length ? Math.max(...rows.map((v) => v[key])) : null
      const process = recent.flatMap((w) => w.perf ? [w.perf] : [])
      const hosts = recent.flatMap((w) => w.host?.cpuPct !== null && w.host !== null ? [w.host] : [])
      const fresh = anchor && now() - anchor.at <= 25_000 ? anchor : null
      return { host: recent.at(-1)?.host ?? null, hostCpuPeakPct: max(hosts, 'cpuPct'), stealPeakPct: max(hosts, 'stealPct'),
        perf: recent.at(-1)?.perf ?? null, processCpuPeakPct: max(process, 'processCpuPct'),
        loopPeakMs: max(process, 'eventLoopMaxMs'), stepPeakMs: max(process, 'simStepMaxMs'),
        ...(anchors.length ? { anchorMs: fresh?.ms ?? null } : {}) }
    },
    close() { clearInterval(timer); if (probeTimer) clearInterval(probeTimer) },
  }
}
