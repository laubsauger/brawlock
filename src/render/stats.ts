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
  /** GPU time of the last resolved frame (timestamp queries), ms; -1 = unavailable */
  gpuMs: number
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
  drawCalls: 0,
  triangles: 0,
}

/** Internal: performance.now() when this frame's scene update began. */
export const perfMark = { start: 0 }

/** Dev-only: slow motion for VFX review (preview ?slow=0.25). 1 = real time. */
export const devTime = { scale: 1 }
