/**
 * Bridge to the render workstream (src/render/index.ts): MenuBackdrop,
 * MatchView, recenterCamera, renderStats. Loaded with a dynamic import so
 * three.js lands in its own chunk and the menu never waits for it; the
 * splash warms it up. A crashing 3D layer is contained and the UI keeps
 * working on top of the CSS backdrop.
 */
import { Component, lazy, Suspense, type ComponentType, type ErrorInfo, type ReactNode } from 'react'
import { recoverFromChunkError } from '../lib/staleBuild'
import { useGame, type Settings } from '../game/store'

type RenderModule = typeof import('../render')
export type MatchViewProps = import('../render').MatchViewProps

let mod: RenderModule | null = null
let pending: Promise<RenderModule | null> | null = null
let failed = false

/** Start loading the render module (the splash calls this to warm the chunk). */
export function loadRender(): Promise<RenderModule | null> {
  pending ??= import('../render')
    .then((m) => {
      mod = m
      syncRenderPrefs(m)
      return m
    })
    .catch((e) => {
      console.error('[ui] render module failed to load', e)
      pending = null
      failed = true
      recoverFromChunkError(e)
      return null
    })
  return pending
}

/**
 * True once the mounted MatchView has compiled its materials and uploaded its
 * textures (render's isMatchRenderReady). Also true when the render module
 * failed to load, so nothing waits on a 3D layer that will never come.
 */
export function matchRenderReady(): boolean {
  if (!mod) return failed
  try {
    return mod.isMatchRenderReady()
  } catch {
    return true
  }
}

/**
 * Push the display settings render reads (shake, fps cap, resolution scale):
 * once when the module loads (render starts on its defaults), then on every
 * change. Module-level in render, so it covers both canvases and remounts.
 */
function syncRenderPrefs(m: RenderModule): void {
  const push = (s: Settings) => {
    try {
      m.setRenderPrefs({
        shake: s.screenShake ?? 1,
        fpsCap: s.fpsCap ?? 0,
        resolutionScale: s.resolutionScale ?? 1,
        cameraReach: s.cameraReach ?? 'normal',
        edgePanSpeed: s.edgePanSpeed ?? 1,
      })
    } catch (e) {
      console.error('[ui] setRenderPrefs failed', e)
    }
  }
  push(useGame.getState().settings)
  useGame.subscribe((s, prev) => {
    const a = s.settings
    const b = prev.settings
    if (a.screenShake !== b.screenShake || a.fpsCap !== b.fpsCap || a.resolutionScale !== b.resolutionScale || a.cameraReach !== b.cameraReach || a.edgePanSpeed !== b.edgePanSpeed) push(a)
  })
}

export function recenterCamera(): void {
  try {
    mod?.recenterCamera()
  } catch (e) {
    console.error('[ui] recenterCamera failed', e)
  }
}

export interface RenderPerf {
  backend: string
  tier: string
  gpuMs: number
  cpuMs: number
  drawCalls: number
  triangles: number
  dpr: number
  /** frames the scene renders per second (lower than the page rate under an fps cap) */
  fps?: number
}

/** Live render numbers (mutated in place by the render loop), or null before render loads. */
export function renderPerf(): RenderPerf | null {
  return mod?.renderStats ?? null
}

/** Keeps a crashing 3D layer from taking the UI with it. */
class RenderBoundary extends Component<{ children: ReactNode; name: string }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ui] ${this.props.name} crashed`, error, info.componentStack)
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

const Nothing = () => null

const LazyBackdrop = lazy(async () => {
  const m = await loadRender()
  return { default: m?.MenuBackdrop ?? Nothing }
})

const LazyMatch = lazy<ComponentType<MatchViewProps>>(async () => {
  const m = await loadRender()
  return { default: m?.MatchView ?? Nothing }
})

export function MenuBackdropSlot() {
  return (
    <RenderBoundary name="MenuBackdrop">
      <Suspense fallback={null}>
        <LazyBackdrop />
      </Suspense>
    </RenderBoundary>
  )
}

/** The match scene. Props pass through (prewarm, onReady): keep ONE instance mounted from lobby to match. */
export function MatchViewSlot(props: MatchViewProps) {
  return (
    <RenderBoundary name="MatchView">
      <Suspense fallback={null}>
        <LazyMatch {...props} />
      </Suspense>
    </RenderBoundary>
  )
}
