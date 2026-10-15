/**
 * Bridge to the render workstream (src/render/index.ts): MenuBackdrop,
 * MatchView, recenterCamera, renderStats. Loaded with a dynamic import so
 * three.js lands in its own chunk and the menu never waits for it; the
 * splash warms it up. A crashing 3D layer is contained and the UI keeps
 * working on top of the CSS backdrop.
 */
import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from 'react'

type RenderModule = typeof import('../render')

let mod: RenderModule | null = null
let pending: Promise<RenderModule | null> | null = null

/** Start loading the render module (the splash calls this to warm the chunk). */
export function loadRender(): Promise<RenderModule | null> {
  pending ??= import('../render')
    .then((m) => (mod = m))
    .catch((e) => {
      console.error('[ui] render module failed to load', e)
      return null
    })
  return pending
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

const LazyMatch = lazy(async () => {
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

export function MatchViewSlot() {
  return (
    <RenderBoundary name="MatchView">
      <Suspense fallback={null}>
        <LazyMatch />
      </Suspense>
    </RenderBoundary>
  )
}
