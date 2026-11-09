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

/**
 * Server: one PULSE_MS timer pulses every running match. A timer per match woke the process
 * 250 times a second per room although only 60 of those pulses have a tick to run.
 */
export function sharedClock(): StartClock {
  const pulses = new Set<() => void>()
  let timer: ReturnType<typeof setInterval> | null = null
  return (onPulse) => {
    const pulse = () => onPulse(performance.now())
    pulses.add(pulse)
    timer ??= setInterval(() => {
      for (const p of pulses) p()
    }, PULSE_MS)
    return () => {
      pulses.delete(pulse)
      if (pulses.size === 0 && timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }
  }
}

/** the pulses of the running clocks on a page, for pulseNow */
const pagePulses = new Set<(at: number) => void>()

/**
 * The current animation frame's time: the timestamp every callback of this frame shares
 * (document.timeline), else now. The clock's frame pulses and the renderer's interpolation both
 * use it, so where a warlock is drawn depends only on the frame, not on how long the work before
 * the read took: read at performance.now(), a frame that first stepped a tick (ten bots
 * deciding) read milliseconds later than one that did not, and the warlock's steps on screen
 * went uneven under the follow camera. Outside a frame it is stale, so timers use performance.now().
 */
export function frameTime(): number {
  const t = typeof document !== 'undefined' ? document.timeline?.currentTime : null
  return typeof t === 'number' ? t : performance.now()
}

/**
 * Pulse every running clock at this frame's time. The match view calls this before the world
 * reads the frame buffer: the renderer's animation frame runs before the clock's own in the same
 * frame (it was requested first), so without this every frame showed the sim as of the frame
 * before. The interpolation then ran past the newest state on frames with no new tick (every
 * other frame at 30 Hz on 60 Hz) and held the warlocks still, then jumped: a judder the follow
 * camera made plain. A pulse with no tick due steps nothing, and the clock's own frame pulse then
 * has nothing left.
 */
export function pulseNow(at = frameTime()): void {
  for (const pulse of pagePulses) pulse(at)
}

export const startClock: StartClock = (onPulse) => {
  let last = -Infinity
  // never backwards: a timer pulse can come later in a frame than that frame's timestamp
  const pulse = (at = performance.now()) => {
    last = Math.max(last, at)
    onPulse(last)
  }
  const visual = typeof document !== 'undefined' && typeof requestAnimationFrame === 'function'
  if (!visual) {
    const timer = makeTimer(() => pulse())
    timer.rate(PULSE_MS)
    return () => timer.stop()
  }
  pagePulses.add(pulse)
  const hidden = () => document.visibilityState === 'hidden'
  let raf = 0
  const frame = (ts: number) => {
    raf = requestAnimationFrame(frame)
    pulse(ts)
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
    pagePulses.delete(pulse)
    document.removeEventListener('visibilitychange', apply)
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    timer.stop()
  }
}
