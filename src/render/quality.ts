import type { Quality } from '../game/store'

/**
 * Quality tiers (docs/PLAN.md §5.5). One table, read by canvas, post and VFX.
 * The WebGL2 fallback backend is forced to 'low' (plan §4.1).
 */
export interface TierConfig {
  /** multiplier on window.devicePixelRatio */
  dprScale: number
  /** hard cap on the final pixel ratio */
  dprMax: number
  /** RenderPipeline with bloom + vignette; false = direct render, tone map only */
  post: boolean
  bloom: boolean
  /** bloom strength before fxIntensity */
  bloomStrength: number
  /** screen-space heat shimmer over the lava (post) */
  heatHaze: boolean
  /** MSAA samples on the scene pass (0 = off) */
  msaa: number
  /** particle budget multiplier */
  particles: number
  /** lava shader detail: extra crack octave + shore turbulence */
  lavaDetail: boolean
  /** texture anisotropy for authored PBR maps */
  anisotropy: number
  /** directional shadow map size from the key light; 0 = contact/blob shadows only */
  shadowMap: number
  /** screen-space ambient occlusion (GTAO) in post */
  ao: boolean
}

export const TIERS: Record<Quality, TierConfig> = {
  low: { dprScale: 0.75, dprMax: 1, post: false, bloom: false, bloomStrength: 0, heatHaze: false, msaa: 0, particles: 0.25, lavaDetail: false, anisotropy: 1, shadowMap: 0, ao: false },
  medium: { dprScale: 1, dprMax: 1.5, post: true, bloom: true, bloomStrength: 0.5, heatHaze: false, msaa: 0, particles: 0.5, lavaDetail: true, anisotropy: 4, shadowMap: 0, ao: false },
  high: { dprScale: 1, dprMax: 2, post: true, bloom: true, bloomStrength: 0.6, heatHaze: true, msaa: 4, particles: 1, lavaDetail: true, anisotropy: 8, shadowMap: 2048, ao: true },
  ultra: { dprScale: 1, dprMax: 3, post: true, bloom: true, bloomStrength: 0.7, heatHaze: true, msaa: 4, particles: 1.5, lavaDetail: true, anisotropy: 16, shadowMap: 4096, ao: true },
}

export function tierConfig(q: Quality): TierConfig {
  return TIERS[q] ?? TIERS.high
}

export function tierDpr(q: Quality): number {
  const t = tierConfig(q)
  const dev = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  return Math.min(t.dprMax, dev * t.dprScale)
}
