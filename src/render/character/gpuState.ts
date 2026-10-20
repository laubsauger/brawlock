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
  /** Account cloth tint; neutral leaves the starter robe unchanged. */
  readonly clothTint = new THREE.Color(1, 1, 1)
  /** robe cut (wardrobe.ts ROBE_STYLE): 0 plain, 1 tattered hem, 2 tattered with ember veins */
  robeStyle = 0
  /** cape emblem atlas cell (emblems.ts), -1 = plain cape */
  emblem = -1
  clothBlend = 0
  /** colour of the current cast (defaults to the team colour; render may set a spell colour) */
  readonly castColor = new THREE.Color()
  /** 0..1 over the cast point, 0 when idle / released / cancelled */
  castCharge = 0
  /** 1 on release, decays fast */
  castFlare = 0
  /** 1 on cancel, decays: flickers the charge out */
  castFizzle = 0
  /** casting hand(s): +1 left, -1 right, 0 both */
  castSide = 1
  /** hit flash 1 -> 0 (white rim core for the first ~12 %, then crimson over the body) */
  flash = 0
  /** strength of the current hit flash (from damage / knockback) */
  flashK = 1
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
  /** shadow-eaten: darkened to a black-violet void 0..1 (Scourge death) */
  shadow = 0
  /** dissolve order: 0 feet -> hood, 1 silhouette edges inward, 2 uniform smoke noise */
  dissolveMode = 0
  /** rune breathing / victory boost (1 = normal) */
  runeBoost = 1
  /**
   * build reading (visual progression): accent colour per shop column 1..6
   * (black = column not owned), shown as a secondary rune band at a fixed
   * garment location per column (progression.ts)
   */
  readonly accents = [new THREE.Color(0), new THREE.Color(0), new THREE.Color(0), new THREE.Color(0), new THREE.Color(0), new THREE.Color(0)]
  /** 0..1 idle "ready" pose: hands held in front with a faint glow (facing cue) */
  idleHands = 0
  /** 0..1 in steps from total spell levels: rune density / brightness, eye glow, hem aura */
  power = 0
  /** level-up burst: sweep height (model metres, feet -> hood) and strength */
  levelSweep = -1
  levelFlash = 0
  readonly levelColor = new THREE.Color()
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
  /**
   * front drape envelope per leg (model space, smoothed on the CPU): x = knee
   * height, y = z the robe front must clear at the knee, z = z it must clear at
   * the hem, w unused
   */
  readonly frontL = new THREE.Vector4(0.5, 0, 0, 0)
  readonly frontR = new THREE.Vector4(0.5, 0, 0, 0)
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
function u4(get: (s: WarlockGpu) => THREE.Vector4) {
  return uniform(new THREE.Vector4()).onObjectUpdate((f) => {
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
  clothTint: uc((s) => s.clothTint),
  clothBlend: uf((s) => s.clothBlend),
  robeStyle: uf((s) => s.robeStyle),
  emblem: uf((s) => s.emblem),
  castColor: uc((s) => s.castColor),
  castCharge: uf((s) => s.castCharge),
  castFlare: uf((s) => s.castFlare),
  castFizzle: uf((s) => s.castFizzle),
  castSide: uf((s) => s.castSide),
  flash: uf((s) => s.flash),
  flashK: uf((s) => s.flashK),
  burn: uf((s) => s.burn),
  invuln: uf((s) => s.invuln),
  dissolve: uf((s) => s.dissolve),
  dissolveColor: uc((s) => s.dissolveColor),
  char: uf((s) => s.char),
  freeze: uf((s) => s.freeze),
  xray: uf((s) => s.xray),
  wither: uf((s) => s.wither),
  shadow: uf((s) => s.shadow),
  dissolveMode: uf((s) => s.dissolveMode),
  runeBoost: uf((s) => s.runeBoost),
  accent1: uc((s) => s.accents[0]),
  accent2: uc((s) => s.accents[1]),
  accent3: uc((s) => s.accents[2]),
  accent4: uc((s) => s.accents[3]),
  accent5: uc((s) => s.accents[4]),
  accent6: uc((s) => s.accents[5]),
  power: uf((s) => s.power),
  idleHands: uf((s) => s.idleHands),
  levelSweep: uf((s) => s.levelSweep),
  levelFlash: uf((s) => s.levelFlash),
  levelColor: uc((s) => s.levelColor),
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
  frontL: u4((s) => s.frontL),
  frontR: u4((s) => s.frontR),
}
