import * as THREE from 'three/webgpu'
import { uniform } from 'three/tsl'
import type { NodeFrame } from 'three/webgpu'

/**
 * Per-warlock values the shared materials read. Every mesh of one warlock
 * points `userData.wl` at the same instance; the uniforms below pull from it
 * per draw (onObjectUpdate), so all warlocks share one set of materials and
 * pipelines while still getting their own colour, cloth and fx state.
 */
export class WarlockGpu {
  /** player colour (linear) */
  readonly team = new THREE.Color()
  /** colour of the current cast (defaults to the team colour; render may set a spell colour) */
  readonly castColor = new THREE.Color()
  /** 0..1 over the cast point, 0 when idle / released / cancelled */
  castCharge = 0
  /** 1 on release, decays fast */
  castFlare = 0
  /** 1 on cancel, decays: flickers the charge out */
  castFizzle = 0
  /** casting hand: +1 left, -1 right */
  castSide = 1
  /** white hit flash 0..1 */
  flash = 0
  /** lava burn 0..1 */
  burn = 0
  /** invulnerability shimmer 0..1 */
  invuln = 0
  /** death burn-up 0..1 */
  dissolve = 0
  /** colour of the dissolve edge */
  readonly dissolveColor = new THREE.Color(4.5, 1.3, 0.25)
  /** charred: blackened with glowing ember cracks 0..1 */
  char = 0
  /** frozen: ice tint and frost rim 0..1 */
  freeze = 0
  /** x-ray / silhouette flash 0..1 (lightning) */
  xray = 0
  /** withered: drained grey 0..1 */
  wither = 0
  /** rune breathing / victory boost (1 = normal) */
  runeBoost = 1
  /** cloth spring offsets (model space, metres): coat/tabard/sleeves and the slower cape */
  readonly swayCoat = new THREE.Vector3()
  readonly swayCape = new THREE.Vector3()
  /** 0..1 fast-movement flutter */
  flutter = 0
  /** per-instance phase so robes do not ripple in sync */
  phase = 0
  /** collision capsule joints, model space (metres), refreshed from bones each frame */
  readonly hipL = new THREE.Vector3()
  readonly kneeL = new THREE.Vector3()
  readonly footL = new THREE.Vector3()
  readonly hipR = new THREE.Vector3()
  readonly kneeR = new THREE.Vector3()
  readonly footR = new THREE.Vector3()
  readonly pelvis = new THREE.Vector3()
  readonly chest = new THREE.Vector3()
  readonly armL0 = new THREE.Vector3()
  readonly armL1 = new THREE.Vector3()
  readonly armR0 = new THREE.Vector3()
  readonly armR1 = new THREE.Vector3()
  /** between the eyes (model space), for the glow spill inside the hood */
  readonly eyes = new THREE.Vector3()
}

const st = (f: NodeFrame): WarlockGpu | undefined => f.object?.userData.wl as WarlockGpu | undefined

function u3(get: (s: WarlockGpu) => THREE.Vector3) {
  return uniform(new THREE.Vector3()).onObjectUpdate((f) => {
    const s = st(f)
    return s ? get(s) : undefined
  })
}
function uc(get: (s: WarlockGpu) => THREE.Color) {
  return uniform(new THREE.Color()).onObjectUpdate((f) => {
    const s = st(f)
    return s ? get(s) : undefined
  })
}
function uf(get: (s: WarlockGpu) => number) {
  return uniform(0).onObjectUpdate((f) => {
    const s = st(f)
    return s ? get(s) : undefined
  })
}

/** Shared per-object uniforms (created once, used by every warlock material). */
export const U = {
  team: uc((s) => s.team),
  castColor: uc((s) => s.castColor),
  castCharge: uf((s) => s.castCharge),
  castFlare: uf((s) => s.castFlare),
  castFizzle: uf((s) => s.castFizzle),
  castSide: uf((s) => s.castSide),
  flash: uf((s) => s.flash),
  burn: uf((s) => s.burn),
  invuln: uf((s) => s.invuln),
  dissolve: uf((s) => s.dissolve),
  dissolveColor: uc((s) => s.dissolveColor),
  char: uf((s) => s.char),
  freeze: uf((s) => s.freeze),
  xray: uf((s) => s.xray),
  wither: uf((s) => s.wither),
  runeBoost: uf((s) => s.runeBoost),
  swayCoat: u3((s) => s.swayCoat),
  swayCape: u3((s) => s.swayCape),
  flutter: uf((s) => s.flutter),
  phase: uf((s) => s.phase),
  hipL: u3((s) => s.hipL),
  kneeL: u3((s) => s.kneeL),
  footL: u3((s) => s.footL),
  hipR: u3((s) => s.hipR),
  kneeR: u3((s) => s.kneeR),
  footR: u3((s) => s.footR),
  pelvis: u3((s) => s.pelvis),
  chest: u3((s) => s.chest),
  armL0: u3((s) => s.armL0),
  armL1: u3((s) => s.armL1),
  armR0: u3((s) => s.armR0),
  armR1: u3((s) => s.armR1),
  eyes: u3((s) => s.eyes),
}
