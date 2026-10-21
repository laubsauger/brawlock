import os from 'node:os'
import { readFileSync } from 'node:fs'

/** Linux steal time matters on shared droplets. Unsupported host metrics stay null. */
export function linuxCounters(stat, memory) {
  const fields = /^cpu\s+(.+)$/m.exec(stat)?.[1].trim().split(/\s+/).map(Number)
  const available = /^MemAvailable:\s+(\d+) kB$/m.exec(memory)
  if (!fields || fields.length < 8 || fields.some((v) => !Number.isFinite(v)) || !available) throw new Error('Invalid Linux host counters')
  // guest/guest_nice are already included in user/nice.
  return { total: fields.slice(0, 8).reduce((a, b) => a + b, 0), idle: fields[3] + fields[4], steal: fields[7], availableMb: Number(available[1]) / 1024 }
}
export function createMachineMonitor({ perf, now = Date.now, read = () => linuxCounters(readFileSync('/proc/stat', 'utf8'), readFileSync('/proc/meminfo', 'utf8')) } = {}) {
  let previous = null
  const windows = []
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
      return { host: recent.at(-1)?.host ?? null, hostCpuPeakPct: max(hosts, 'cpuPct'),
        perf: recent.at(-1)?.perf ?? null, processCpuPeakPct: max(process, 'processCpuPct'),
        loopPeakMs: max(process, 'eventLoopMaxMs'), stepPeakMs: max(process, 'simStepMaxMs') }
    },
    close() { clearInterval(timer) },
  }
}
