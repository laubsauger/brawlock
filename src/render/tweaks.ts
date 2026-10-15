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
  /** engraved floor sigils on some tiles (0 off, 1 on) */
  uSigils: uniform(0),
  /** debug: colour tile faces by class (top red, bevel green, wall blue) */
  uDebugFaces: uniform(0),
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
  get sigils(): boolean {
    return tweaks.uSigils.value > 0.5
  },
  set sigils(v: boolean) {
    tweaks.uSigils.value = v ? 1 : 0
  },
  /** 0 off, 1 face classes, 2 lighting only */
  get debugFaces(): number {
    return tweaks.uDebugFaces.value
  },
  set debugFaces(v: number) {
    tweaks.uDebugFaces.value = v
  },
  get edgeWidth(): number {
    return tweaks.uEdgeWidth.value
  },
  set edgeWidth(v: number) {
    tweaks.uEdgeWidth.value = v
  },
}
