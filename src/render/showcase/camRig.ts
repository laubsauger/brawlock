/**
 * Showcase camera override. The match world positions its camera through
 * cameraRig.update() every frame (after projectiles, before the overlay and
 * the shadow-light follow). We wrap that one call on the shared rig instance
 * (no edit to the rig): the rig still runs, so hit shake and directional kicks
 * keep evolving, and their offset from the rig's nominal pose is carried onto
 * the cinematic pose at a reduced strength.
 */
import type * as THREE from 'three/webgpu'
import { cameraParams, cameraRig, devCamera } from '../cameraRig'
import { S, TILE_TOP_H } from '../coords'
import type { CamPose } from './cam'

export const camOverride = {
  pose: null as CamPose | null,
  /** share of the gameplay shake/kick carried onto the cinematic camera */
  shake: 0.7,
}

const D2R = Math.PI / 180
let installed = false

export function installCameraOverride(): void {
  if (installed) return
  installed = true
  const orig = cameraRig.update.bind(cameraRig)
  cameraRig.update = (camera: THREE.PerspectiveCamera, focusX: number, focusY: number, dt: number, aspect: number, shakeScale: number) => {
    orig(camera, focusX, focusY, dt, aspect, shakeScale)
    const pose = camOverride.pose
    if (!pose) return
    // the rig's shake + kick = where it put the camera minus its nominal pose
    const d = cameraRig.dist
    const pitch = cameraParams.pitch * D2R
    const ahead = d * cameraParams.centerOffset
    const nx = cameraRig.fx * S
    const ny = TILE_TOP_H * S + Math.sin(pitch) * d * S
    const nz = -(cameraRig.fy + ahead) * S + Math.cos(pitch) * d * S
    const k = camOverride.shake
    const ox = (camera.position.x - nx) * k
    const oy = (camera.position.y - ny) * k
    const oz = (camera.position.z - nz) * k
    camera.position.set(pose.x * S + ox, pose.h * S + oy, -pose.y * S + oz)
    camera.up.set(0, 1, 0)
    camera.lookAt(pose.tx * S + ox * 0.5, pose.th * S + oy * 0.5, -pose.ty * S + oz * 0.5)
    if (Math.abs(camera.fov - pose.fov) > 1e-4) {
      camera.fov = pose.fov
      camera.updateProjectionMatrix()
    }
  }
}

/** Keep the rig (shadow frustum, audio listener) centred on what the cinematic camera looks at. */
export function setRigFocus(x: number, y: number): void {
  devCamera.focus = { x, y }
}
