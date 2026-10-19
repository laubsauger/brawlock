export interface LocalFrameSample {
  windowMs: number
  fps: number
  frameAvgMs: number
  frameMaxMs: number
  framesOver50Ms: number
}

/** One-second frame windows, driven by the existing HUD rAF, with no extra timer. */
export class FrameWindow {
  private last: number | null = null
  private elapsed = 0
  private frames = 0
  private worst = 0
  private slow = 0

  reset(): void {
    this.last = null
    this.elapsed = this.frames = this.worst = this.slow = 0
  }

  push(now: number): LocalFrameSample | null {
    if (!Number.isFinite(now) || (this.last !== null && now < this.last)) throw new Error('Frame clock must be finite and monotonic')
    if (this.last === null) { this.last = now; return null }
    const dt = now - this.last
    this.last = now
    this.elapsed += dt
    this.frames++
    this.worst = Math.max(this.worst, dt)
    if (dt > 50) this.slow++
    if (this.elapsed < 1000) return null
    const sample = { windowMs: this.elapsed, fps: 1000 * this.frames / this.elapsed, frameAvgMs: this.elapsed / this.frames, frameMaxMs: this.worst, framesOver50Ms: this.slow }
    this.elapsed = this.frames = this.worst = this.slow = 0
    return sample
  }
}
import { decodeServerPerf, type ServerPerfSnapshot } from '../../net/serverPerf'


export interface ServerProbe {
  state: 'waiting' | 'ready' | 'unavailable'
  sample: ServerPerfSnapshot | null
  fetchMs: number | null
  receivedAt: number | null
}

/** Only called while diagnostics is open; one non-overlapping request per 3s. */
export function watchServerPerf(base: string, publish: (value: ServerProbe) => void): () => void {
  let stopped = false
  let busy = false
  let current: AbortController | null = null
  const refresh = async () => {
    if (stopped || busy || document.visibilityState !== 'visible') return
    busy = true
    const controller = new AbortController()
    current = controller
    const timeout = setTimeout(() => controller.abort(), 2500)
    const start = performance.now()
    try {
      const response = await fetch(`${base}/health`, { signal: controller.signal, cache: 'no-store' })
      if (!response.ok) throw new Error('Server diagnostics request failed')
      const body: unknown = await response.json()
      if (!body || typeof body !== 'object' || !('ok' in body) || body.ok !== true) throw new Error('Invalid server health response')
      const sample = decodeServerPerf('perf' in body ? body.perf : undefined)
      if (!stopped) publish({ state: sample ? 'ready' : 'waiting', sample, fetchMs: performance.now() - start, receivedAt: Date.now() })
    } catch {
      if (!stopped) publish({ state: 'unavailable', sample: null, fetchMs: null, receivedAt: null })
    } finally {
      clearTimeout(timeout)
      if (current === controller) current = null
      busy = false
    }
  }
  const visible = () => { if (document.visibilityState === 'visible') void refresh() }
  void refresh()
  const interval = setInterval(() => void refresh(), 3000)
  document.addEventListener('visibilitychange', visible)
  return () => {
    stopped = true
    clearInterval(interval)
    document.removeEventListener('visibilitychange', visible)
    current?.abort()
  }
}
