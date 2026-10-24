import { FrameWindow, type LocalFrameSample } from './diagnostics'
import { onTick, usePolled } from './ticker'

const TIMER_MS = 100
const RECENT_MS = 5000
const STALL_MS = 50

export interface ClientPerformanceSnapshot {
  frames: LocalFrameSample | null
  /** Timer scheduling delay, independent of requestAnimationFrame/GPU cadence. */
  mainThreadStallMs: number
  /** A slow animation frame alone does not prove a main-thread scheduling stall. */
  frameGapMs: number
}

/** Local observations only. Never subtract these values from measured RTT. */
export class ClientPerformance {
  private frames = new FrameWindow()
  private sample: LocalFrameSample | null = null
  private lastFrame: number | null = null
  private lastTimer: number | null = null
  private stalls: { at: number; ms: number }[] = []
  private gaps: { at: number; ms: number }[] = []

  reset(): void {
    this.frames.reset()
    this.sample = null
    this.lastFrame = this.lastTimer = null
    this.stalls = []
    this.gaps = []
  }

  frame(now: number): void {
    const sample = this.frames.push(now)
    if (sample) this.sample = sample
    if (this.lastFrame !== null && now - this.lastFrame > STALL_MS) this.gaps.push({ at: now, ms: now - this.lastFrame })
    this.lastFrame = now
    this.prune(now)
  }

  timer(now: number): void {
    if (this.lastTimer !== null) {
      const delayed = now - this.lastTimer - TIMER_MS
      if (delayed > STALL_MS) this.stalls.push({ at: now, ms: delayed })
    }
    this.lastTimer = now
    this.prune(now)
  }

  snapshot(now: number): ClientPerformanceSnapshot {
    this.prune(now)
    return { frames: this.sample,
      mainThreadStallMs: Math.max(0, ...this.stalls.map((s) => s.ms)),
      frameGapMs: Math.max(0, ...this.gaps.map((s) => s.ms)) }
  }

  private prune(now: number): void {
    while (this.stalls.length && now - this.stalls[0].at >= RECENT_MS) this.stalls.shift()
    while (this.gaps.length && now - this.gaps[0].at >= RECENT_MS) this.gaps.shift()
  }
}

const performanceSamples = new ClientPerformance()
export const clientPerformance = (): ClientPerformanceSnapshot => performanceSamples.snapshot(performance.now())

/** Shared app-lifetime sampler: the existing HUD rAF plus one lightweight 10 Hz timer. */
export function startClientPerformance(): () => void {
  performanceSamples.reset()
  const visible = () => document.visibilityState === 'visible'
  const stopFrames = onTick((now) => { if (visible()) performanceSamples.frame(now) })
  const timer = setInterval(() => { if (visible()) performanceSamples.timer(performance.now()) }, TIMER_MS)
  const reset = () => performanceSamples.reset()
  document.addEventListener('visibilitychange', reset)
  return () => {
    stopFrames()
    clearInterval(timer)
    document.removeEventListener('visibilitychange', reset)
    performanceSamples.reset()
  }
}

export function useClientPerformance(): ClientPerformanceSnapshot {
  return usePolled(clientPerformance, (s) => `${s.frames?.fps}|${s.frames?.frameMaxMs}|${s.mainThreadStallMs}|${s.frameGapMs}`, 4)
}
