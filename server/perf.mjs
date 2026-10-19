// Cached process-only diagnostics. Native histogram samples use nanoseconds;
// process.cpuUsage() uses microseconds. CPU 100% means one fully occupied core.
// https://nodejs.org/api/perf_hooks.html#perf_hooksmonitoreventloopdelayoptions
// https://nodejs.org/api/process.html#processcpuusagepreviousvalue
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

/** One fixed-size window, independent of HTTP polling and the number of rooms. */
export function createServerPerf({
  now = () => performance.now(),
  wallNow = Date.now,
  cpuUsage = () => process.cpuUsage(),
  rss = () => process.memoryUsage.rss(),
  eventLoop = monitorEventLoopDelay({ resolution: 20 }),
  schedule = (sample, ms) => setInterval(sample, ms),
  cancel = (timer) => clearInterval(timer),
} = {}) {
  let from = now()
  let previousCpu = cpuUsage()
  let steps = 0
  let stepTotal = 0
  let stepMax = 0
  let latest = null
  let closed = false
  eventLoop.enable()

  function sample() {
    if (closed) return
    const at = now()
    const windowMs = at - from
    // No histogram observations yet is unsampled, rather than a claim of zero delay.
    if (windowMs <= 0 || eventLoop.count === 0) return
    const cpu = cpuUsage()
    latest = Object.freeze({
      sampleAt: wallNow(),
      windowMs,
      processCpuPct: (cpu.user - previousCpu.user + cpu.system - previousCpu.system) / (windowMs * 10),
      eventLoopP95Ms: eventLoop.percentile(95) / 1e6,
      eventLoopMaxMs: eventLoop.max / 1e6,
      simStepAvgMs: steps > 0 ? stepTotal / steps : 0,
      simStepMaxMs: stepMax,
      simStepsPerSec: steps * 1000 / windowMs,
      rssMb: rss() / (1024 * 1024),
    })
    from = at
    previousCpu = cpu
    steps = 0
    stepTotal = 0
    stepMax = 0
    eventLoop.reset()
  }

  const timer = schedule(sample, 1000)
  timer.unref()
  return {
    snapshot: () => latest,
    /** Preserve the synchronous simulation's arguments, receiver, return value and errors. */
    wrapStep(step) {
      return function measuredStep(...args) {
        if (closed) return step.apply(this, args)
        const begin = now()
        try { return step.apply(this, args) }
        finally {
          const elapsed = now() - begin
          steps += 1
          stepTotal += elapsed
          if (elapsed > stepMax) stepMax = elapsed
        }
      }
    },
    close() {
      if (closed) return
      closed = true
      cancel(timer)
      eventLoop.disable()
      latest = null
    },
  }
}
