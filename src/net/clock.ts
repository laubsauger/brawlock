/**
 * Pulse source for the fixed-step loops (they step from an accumulator, so any pulse
 * rate of 60 Hz or more runs 60 ticks/s).
 *
 * Visible tab: one pulse per animation frame. No extra main-thread tasks (a 4 ms
 * timer posted ~250 per second); own commands do not wait for a frame because the
 * session wakes a pulse for the tick that applies them.
 * Hidden tab: rAF stops and main-thread timers are throttled to 1 Hz or worse, which
 * would freeze a hosting player's sim. Dedicated worker timers are not throttled that
 * way, so a tiny inline worker posts every PULSE_MS.
 * While visible the worker stays on as a slow watchdog (WATCHDOG_MS): if rAF stalls
 * without the page turning hidden (occluded windows in some browsers), it pulses.
 * Without document / rAF (tests, workers) it is the worker or a setInterval at PULSE_MS.
 */

export type StartClock = (onPulse: (now: number) => void) => () => void

const PULSE_MS = 4
const WATCHDOG_MS = 50

const WORKER_SRC = `let id=0;onmessage=(e)=>{clearInterval(id);if(e.data>0)id=setInterval(()=>postMessage(0),e.data)}`

/** A repeating timer whose rate can change: a worker if possible, else setInterval. */
function makeTimer(tick: () => void): { rate(ms: number): void; stop(): void } {
  if (typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL.createObjectURL === 'function') {
    try {
      const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }))
      const worker = new Worker(url)
      worker.onmessage = tick
      return {
        rate: (ms) => worker.postMessage(ms),
        stop: () => {
          worker.terminate()
          URL.revokeObjectURL(url)
        },
      }
    } catch (e) {
      console.warn('[net] worker clock unavailable, using setInterval (throttled in background tabs)', e)
    }
  }
  let id: ReturnType<typeof setInterval> | null = null
  return {
    rate: (ms) => {
      if (id !== null) clearInterval(id)
      id = setInterval(tick, ms)
    },
    stop: () => {
      if (id !== null) clearInterval(id)
      id = null
    },
  }
}

export const startClock: StartClock = (onPulse) => {
  let last = -Infinity
  const pulse = () => {
    last = performance.now()
    onPulse(last)
  }
  const visual = typeof document !== 'undefined' && typeof requestAnimationFrame === 'function'
  if (!visual) {
    const timer = makeTimer(pulse)
    timer.rate(PULSE_MS)
    return () => timer.stop()
  }
  const hidden = () => document.visibilityState === 'hidden'
  let raf = 0
  const frame = () => {
    raf = requestAnimationFrame(frame)
    pulse()
  }
  // hidden: every timer pulse; visible: only when no animation frame came for a while
  const timer = makeTimer(() => {
    if (hidden() || performance.now() - last > WATCHDOG_MS * 0.8) pulse()
  })
  const apply = () => {
    if (hidden()) {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      timer.rate(PULSE_MS)
    } else {
      if (!raf) raf = requestAnimationFrame(frame)
      timer.rate(WATCHDOG_MS)
    }
  }
  document.addEventListener('visibilitychange', apply)
  apply()
  return () => {
    document.removeEventListener('visibilitychange', apply)
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    timer.stop()
  }
}
