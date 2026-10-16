import * as THREE from 'three/webgpu'

/**
 * Per-frame scene preparation that cuts CPU cost without touching any owner's
 * logic:
 *
 * 1. Visible-only matrix update. three's scene.updateMatrixWorld() composes
 *    and multiplies EVERY object every frame (~1200 here, incl. hidden pools
 *    of pillar shapes and VFX batches). Hidden subtrees are never drawn and
 *    their matrices are recomputed the frame they become visible, so they are
 *    skipped (and flagged dirty so a parent move while hidden is not lost).
 *    Objects whose class overrides updateMatrixWorld (cameras, skinned
 *    meshes) still use their own method.
 * 2. Empty-batch skip. Instanced meshes / sprites with count 0 still cost a
 *    full render-object pass and an empty draw (40+ idle VFX batches); they
 *    are hidden for the duration of the render only and restored after, so
 *    the owners never observe the change.
 * 3. Staged warm-up (hidden prewarm only). The first draw of each material
 *    builds its shader (TSL node build, WGSL validation, pipeline): all at
 *    once that is one 300-500 ms task. While staging, drawables are let in a
 *    few per frame, with the count adapted to the measured frame cost, so
 *    the builds spread over many short frames. Not-yet-admitted drawables
 *    are hidden for the render only, like empty batches.
 */

const baseUpdate = THREE.Object3D.prototype.updateMatrixWorld

/** dev/perf switch: false = three's default full update, no batch hiding */
export const cullFlags = { enabled: true }

function updateVisible(o: THREE.Object3D, force: boolean): void {
  if (!o.visible) {
    if (force) o.matrixWorldNeedsUpdate = true
    return
  }
  if (o.updateMatrixWorld !== baseUpdate) {
    o.updateMatrixWorld(force)
    return
  }
  if (o.matrixAutoUpdate) o.updateMatrix()
  if (o.matrixWorldNeedsUpdate || force) {
    if (o.matrixWorldAutoUpdate) {
      if (o.parent === null) o.matrixWorld.copy(o.matrix)
      else o.matrixWorld.multiplyMatrices(o.parent.matrixWorld, o.matrix)
    }
    o.matrixWorldNeedsUpdate = false
    force = true
  }
  const ch = o.children
  for (let i = 0; i < ch.length; i++) updateVisible(ch[i], force)
}

const hidden: THREE.Object3D[] = []
/**
 * Objects that have been drawn (and so had their pipeline built) at least
 * once. An empty batch is only skipped after that, so every VFX material
 * still compiles at startup instead of hitching on its first cast.
 */
const compiled = new WeakSet<THREE.Object3D>()

/**
 * Drawables given a temporary `count = 0` for their compile frame: three then
 * builds the pipeline but skips the draw (a draw with an empty draw range is
 * a WebGPU validation warning). Restored after the render.
 */
const zeroed: THREE.Object3D[] = []
const zeroedPrev: (number | undefined)[] = []

function hideEmpty(o: THREE.Object3D): void {
  if (!o.visible) return
  const c = (o as unknown as { count?: number }).count
  // an empty batch: instance count 0, or a geometry draw range of 0
  const range = (o as THREE.Mesh).geometry?.drawRange
  const emptyRange = range !== undefined && range.count === 0
  if ((c === 0 || emptyRange) && ((o as THREE.InstancedMesh).isInstancedMesh || (o as THREE.Sprite).isSprite || (o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine)) {
    if (!compiled.has(o)) {
      compiled.add(o)
      if (c !== 0) {
        ;(o as unknown as { count?: number }).count = 0
        zeroed.push(o)
        zeroedPrev.push(c)
      }
      return
    }
    o.visible = false
    hidden.push(o)
    return
  }
  const ch = o.children
  for (let i = 0; i < ch.length; i++) hideEmpty(ch[i])
}

interface Stage {
  admitted: WeakSet<THREE.Object3D>
  /** drawables to admit per frame (adapted to the measured frame cost) */
  budget: number
  admittedNow: number
  /** drawables held back this frame */
  held: number
  t0: number
}

const stages = new WeakMap<THREE.Scene, Stage>()
/** frame cost targets for the staged warm-up (ms of render submit) */
const STAGE_SLOW_MS = 30
const STAGE_FAST_MS = 12
const STAGE_MAX = 4

/** Start (or stop) the staged warm-up for a scene. */
export function setStaging(scene: THREE.Scene, on: boolean): void {
  if (!on) stages.delete(scene)
  else if (!stages.has(scene)) stages.set(scene, { admitted: new WeakSet(), budget: 2, admittedNow: 0, held: 1, t0: 0 })
}

/** true when staging is off, or the last frame drew everything (nothing held back). */
export function stagingDone(scene: THREE.Scene): boolean {
  const st = stages.get(scene)
  return !st || st.held === 0
}

function isDrawable(o: THREE.Object3D): boolean {
  const m = o as THREE.Mesh
  return !!(m.isMesh || (o as THREE.Sprite).isSprite || (o as THREE.Points).isPoints || (o as THREE.Line).isLine)
}

function stageHold(o: THREE.Object3D, st: Stage): void {
  if (!o.visible) return
  if (isDrawable(o) && !st.admitted.has(o)) {
    // lit PBR materials (standard / physical) build the biggest shaders:
    // each gets a frame of its own
    const heavy = !!((o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined)?.isMeshStandardMaterial
    if (heavy ? st.admittedNow === 0 : st.admittedNow < st.budget) {
      if (heavy) st.admittedNow = st.budget
      st.admitted.add(o)
      st.admittedNow++
    } else {
      o.visible = false
      hidden.push(o)
      st.held++
      return
    }
  }
  const ch = o.children
  for (let i = 0; i < ch.length; i++) stageHold(ch[i], st)
}

/** Take over the scene's matrix update (call once per scene). */
export function adoptScene(scene: THREE.Scene): void {
  scene.matrixWorldAutoUpdate = false
}

export function releaseScene(scene: THREE.Scene): void {
  scene.matrixWorldAutoUpdate = true
}

/** Before render: visible-only matrices, hide empty batches. */
export function beginFrame(scene: THREE.Scene): void {
  const st = stages.get(scene)
  if (!cullFlags.enabled) {
    scene.updateMatrixWorld()
    if (st) st.held = 0
    return
  }
  updateVisible(scene, false)
  hidden.length = 0
  // staging first: held-back drawables are invisible to hideEmpty, so an
  // empty batch is only marked compiled in the frame it is really drawn
  if (st) {
    st.admittedNow = 0
    st.held = 0
    stageHold(scene, st)
    st.t0 = performance.now()
  }
  hideEmpty(scene)
  current = st ?? null
}

let current: Stage | null = null

/** After render: restore the batches hidden by beginFrame. */
export function endFrame(): void {
  for (let i = 0; i < hidden.length; i++) hidden[i].visible = true
  hidden.length = 0
  for (let i = 0; i < zeroed.length; i++) {
    const o = zeroed[i] as unknown as { count?: number }
    if (zeroedPrev[i] === undefined) delete o.count
    else o.count = zeroedPrev[i]
  }
  zeroed.length = 0
  zeroedPrev.length = 0
  const st = current
  current = null
  if (st && st.admittedNow > 0) {
    // adapt: halve after an expensive frame, grow slowly after a cheap one
    // (a batch of new shaders costs ~3-10 ms each, so the cap stays small)
    const ms = performance.now() - st.t0
    if (ms > STAGE_SLOW_MS) st.budget = Math.max(1, st.budget >> 1)
    else if (ms < STAGE_FAST_MS) st.budget = Math.min(STAGE_MAX, st.budget + 1)
  }
}
