/**
 * Live render numbers for the UI perf HUD. Mutated in place every frame by the
 * render loop; read it from rAF, never put it in React state.
 */
export interface RenderStats {
  /** 'webgpu' | 'webgl2' once the renderer is up, '' before */
  backend: '' | 'webgpu' | 'webgl2'
  /** effective tier after backend clamping */
  tier: string
  /** current pixel ratio */
  dpr: number
  /** smoothed frames per second (render loop) */
  fps: number
  /** smoothed frame interval, ms */
  frameMs: number
  /** smoothed main-thread time of scene update + render submit, ms */
  cpuMs: number
  /**
   * GPU time per frame from timestamp queries, ms; -1 = unavailable or
   * implausible. On tile-based GPUs (Apple) per-pass timestamps overlap and
   * their sum can exceed the frame interval; such readings are rejected here
   * (raw value kept in gpuMsRaw). Use perfProbe.bench() for a real number.
   */
  gpuMs: number
  gpuMsRaw: number
  drawCalls: number
  triangles: number
}

export const renderStats: RenderStats = {
  backend: '',
  tier: '',
  dpr: 1,
  fps: 0,
  frameMs: 0,
  cpuMs: 0,
  gpuMs: -1,
  gpuMsRaw: -1,
  drawCalls: 0,
  triangles: 0,
}

/** Internal: performance.now() when this frame's scene update began. */
export const perfMark = { start: 0 }

/** Dev-only: slow motion for VFX review (preview ?slow=0.25). 1 = real time. */
export const devTime = { scale: 1 }

/**
 * Real GPU cost probe (dev / perf HUD on demand): renders `frames` frames
 * back to back and waits for the GPU queue to drain, returning ms per frame
 * (throughput, so it includes CPU encode if that is the bottleneck).
 * Set by the active render loop; null when no WebGPU canvas is mounted.
 */
export const perfProbe: {
  bench: ((frames?: number) => Promise<number>) | null
  /** CPU-only bench: world update + render submit, N frames back to back (ms/frame) */
  benchCpu: ((frames?: number) => number) | null
  /** set by the match scene: one world update step (dt seconds) */
  worldStep: ((dt: number) => void) | null
} = { bench: null, benchCpu: null, worldStep: null }
