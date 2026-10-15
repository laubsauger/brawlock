/**
 * Pulse source for the fixed-step loops. Background tabs throttle main-thread
 * setInterval / rAF to 1 Hz or worse, which would freeze a hosting player's sim.
 * Dedicated worker timers are not throttled that way, so a tiny inline worker
 * posts a message every few ms and the main thread steps from an accumulator.
 * Falls back to setInterval where Worker / Blob URLs are unavailable (tests, CSP).
 */

export type StartClock = (onPulse: (now: number) => void) => () => void

const PULSE_MS = 4

const WORKER_SRC = `let id=0;onmessage=(e)=>{clearInterval(id);if(e.data>0)id=setInterval(()=>postMessage(0),e.data)}`

export const startClock: StartClock = (onPulse) => {
  if (typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL.createObjectURL === 'function') {
    try {
      const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }))
      const worker = new Worker(url)
      worker.onmessage = () => onPulse(performance.now())
      worker.postMessage(PULSE_MS)
      return () => {
        worker.terminate()
        URL.revokeObjectURL(url)
      }
    } catch (e) {
      console.warn('[net] worker clock unavailable, using setInterval (throttled in background tabs)', e)
    }
  }
  const id = setInterval(() => onPulse(performance.now()), PULSE_MS)
  return () => clearInterval(id)
}
