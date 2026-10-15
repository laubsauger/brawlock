import * as THREE from 'three/webgpu'
import { PROJECTILE_H, S } from '../coords'
import { warlockParams } from './config'

/**
 * Proportion check (warlockParams.debugFootprint): the sim's collision circle
 * (r = 30 units) on the ground and a Fireball-sized sphere (r = 25 units) at
 * projectile height beside the warlock. Shared geometry / materials.
 */
let shared: { ring: THREE.BufferGeometry; ball: THREE.BufferGeometry; ringMat: THREE.Material; ballMat: THREE.Material } | null = null

function make(): THREE.Group {
  shared ??= {
    ring: new THREE.RingGeometry(29 * S, 31 * S, 64).rotateX(-Math.PI / 2),
    ball: new THREE.SphereGeometry(25 * S, 20, 14),
    ringMat: new THREE.MeshBasicNodeMaterial({ color: 0xffe066, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.9 }),
    ballMat: new THREE.MeshBasicNodeMaterial({ color: 0xff7a1a, wireframe: true }),
  }
  const g = new THREE.Group()
  g.name = 'WarlockFootprint'
  const ring = new THREE.Mesh(shared.ring, shared.ringMat)
  ring.position.y = 0.01
  ring.renderOrder = 10
  const ball = new THREE.Mesh(shared.ball, shared.ballMat)
  ball.position.set(60 * S, PROJECTILE_H * S, 0)
  g.add(ring, ball)
  return g
}

/** Adds / removes the overlay under `root` to follow the flag. */
export function syncFootprint(root: THREE.Object3D, current: THREE.Object3D | null): THREE.Object3D | null {
  if (warlockParams.debugFootprint && !current) {
    const g = make()
    root.add(g)
    return g
  }
  if (!warlockParams.debugFootprint && current) {
    current.removeFromParent()
    return null
  }
  return current
}
