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

function hideEmpty(o: THREE.Object3D): void {
  if (!o.visible) return
  const c = (o as unknown as { count?: number }).count
  if (c === 0 && ((o as THREE.InstancedMesh).isInstancedMesh || (o as THREE.Sprite).isSprite || (o as THREE.Mesh).isMesh)) {
    if (!compiled.has(o)) {
      compiled.add(o)
      return
    }
    o.visible = false
    hidden.push(o)
    return
  }
  const ch = o.children
  for (let i = 0; i < ch.length; i++) hideEmpty(ch[i])
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
  if (!cullFlags.enabled) {
    scene.updateMatrixWorld()
    return
  }
  updateVisible(scene, false)
  hidden.length = 0
  hideEmpty(scene)
}

/** After render: restore the batches hidden by beginFrame. */
export function endFrame(): void {
  for (let i = 0; i < hidden.length; i++) hidden[i].visible = true
  hidden.length = 0
}
