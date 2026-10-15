import { uniform } from 'three/tsl'

/**
 * Live look-dev switches. Material variants stay selectable instead of being
 * deleted; the Inspector exposes them (Arena group) next to the camera.
 */
export type TileMaterialMode = 'auto' | 'procedural' | 'textured'

export const tweaks = {
  /** 'auto' = authored PBR set when it exists, else procedural */
  tileMaterial: 'auto' as TileMaterialMode,
  /** bumped whenever a switch needs a material rebuild */
  version: 0,
  /** lava bounce / edge heat on tiles near the shore */
  uEdgeGlow: uniform(1),
  /** falloff width of that glow into the platform, game units */
  uEdgeWidth: uniform(45),
}

/** Inspector-friendly accessors (plain properties over the uniforms). */
export const tweakParams = {
  get tileMaterial(): TileMaterialMode {
    return tweaks.tileMaterial
  },
  set tileMaterial(v: TileMaterialMode) {
    if (v === tweaks.tileMaterial) return
    tweaks.tileMaterial = v
    tweaks.version++
  },
  get edgeGlow(): number {
    return tweaks.uEdgeGlow.value
  },
  set edgeGlow(v: number) {
    tweaks.uEdgeGlow.value = v
  },
  get edgeWidth(): number {
    return tweaks.uEdgeWidth.value
  },
  set edgeWidth(v: number) {
    tweaks.uEdgeWidth.value = v
  },
}
