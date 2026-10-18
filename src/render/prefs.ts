import { useSyncExternalStore } from 'react'

/**
 * Display preferences the render layer reads (plan 5.7 settings): screen
 * shake, fps cap and resolution scale. The UI owns the persisted settings and
 * pushes them here with setRenderPrefs whenever they change.
 */
export interface RenderPrefs {
  /** camera shake and hit kick, 0..1 (independent of fx intensity) */
  shake: number
  /** frame rate cap in Hz; 0 = uncapped (display refresh) */
  fpsCap: number
  /** factor on the tier's pixel ratio and the dynamic-resolution cap, 0.5..1 */
  resolutionScale: number
  /** how far edge pan / peek may look away from the warlock */
  cameraReach: 'short' | 'normal' | 'far'
  /** edge-pan speed factor, 0.25..2 (1 = default) */
  edgePanSpeed: number
}

export const renderPrefs: RenderPrefs = { shake: 1, fpsCap: 0, resolutionScale: 1, cameraReach: 'normal', edgePanSpeed: 1 }

const listeners = new Set<() => void>()

function clamp(v: number, lo: number, hi: number, fallback: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback
}

/** Update any subset of the render preferences. Out-of-range values are clamped. */
export function setRenderPrefs(p: Partial<RenderPrefs>): void {
  let changed = false
  if (p.shake !== undefined) {
    const v = clamp(p.shake, 0, 1, 1)
    changed ||= v !== renderPrefs.shake
    renderPrefs.shake = v
  }
  if (p.fpsCap !== undefined) {
    const v = p.fpsCap > 0 ? clamp(p.fpsCap, 20, 1000, 0) : 0
    changed ||= v !== renderPrefs.fpsCap
    renderPrefs.fpsCap = v
  }
  if (p.resolutionScale !== undefined) {
    const v = clamp(p.resolutionScale, 0.5, 1, 1)
    changed ||= v !== renderPrefs.resolutionScale
    renderPrefs.resolutionScale = v
  }
  if (p.cameraReach !== undefined) {
    const v = p.cameraReach === 'short' || p.cameraReach === 'far' ? p.cameraReach : 'normal'
    changed ||= v !== renderPrefs.cameraReach
    renderPrefs.cameraReach = v
  }
  if (p.edgePanSpeed !== undefined) {
    const v = clamp(p.edgePanSpeed, 0.25, 2, 1)
    changed ||= v !== renderPrefs.edgePanSpeed
    renderPrefs.edgePanSpeed = v
  }
  if (changed) for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** React read of one preference (re-renders only when it changes). */
export function useRenderPref<K extends keyof RenderPrefs>(key: K): RenderPrefs[K] {
  return useSyncExternalStore(subscribe, () => renderPrefs[key])
}
