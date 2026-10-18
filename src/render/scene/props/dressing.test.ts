import * as THREE from 'three/webgpu'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { S } from '../../coords'
import { createArenaDressing, type ArenaDressing } from './dressing'

vi.mock('../textures', () => ({ loadSurface: async () => null }))

const created: ArenaDressing[] = []
afterEach(() => { for (const dressing of created.splice(0)) dressing.dispose() })

function make() {
  const dressing = createArenaDressing({ theme: 0, platformRadius: 1300 })
  created.push(dressing)
  dressing.object3d.updateMatrixWorld(true)
  return dressing
}

function meshes(dressing: ArenaDressing): THREE.Mesh[] {
  const result: THREE.Mesh[] = []
  dressing.object3d.traverse((object) => { if (object instanceof THREE.Mesh) result.push(object) })
  return result
}

function triangles(mesh: THREE.Mesh): number {
  return (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count) / 3
    * (mesh instanceof THREE.InstancedMesh ? mesh.count : 1)
}

function visibleTriangles(dressing: ArenaDressing, camera: THREE.PerspectiveCamera): number {
  camera.updateMatrixWorld()
  const projection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  const frustum = new THREE.Frustum().setFromProjectionMatrix(projection)
  return meshes(dressing).reduce((sum, mesh) => sum + (!mesh.frustumCulled || frustum.intersectsObject(mesh) ? triangles(mesh) : 0), 0)
}

describe('caldera dressing visibility', () => {
  it('keeps the authored geometry and crystal population while rejecting unseen sectors', () => {
    const dressing = make()
    const all = meshes(dressing)
    // The original full-ring arrangement's measured budget. No silhouettes or placements
    // are removed to obtain the culling improvement.
    expect(all.reduce((sum, mesh) => sum + triangles(mesh), 0)).toBe(47_250)
    expect(all.filter((mesh) => mesh.name.startsWith('rim-crystals-')).reduce((sum, mesh) => sum + (mesh as THREE.InstancedMesh).count, 0)).toBe(298)
    expect(all.filter((mesh) => mesh.name.startsWith('lava-fall-'))).toHaveLength(6)
    const menu = new THREE.PerspectiveCamera(35, 1440 / 900, 0.1, 300)
    menu.position.set(-423.2168 * S, 970 * S, -302.1383 * S)
    menu.lookAt(1046.4336 * S, 0, 255.2862 * S)
    expect(visibleTriangles(dressing, menu)).toBeLessThan(47_250 * 0.75)
    const gameplay = new THREE.PerspectiveCamera(35, 1440 / 900, 0.1, 300)
    gameplay.position.set(0, 1800 * S, 1300 * S)
    gameplay.lookAt(0, 0, 0)
    expect(visibleTriangles(dressing, gameplay)).toBeLessThan(47_250 * 0.75)
  })

  it('keeps every radially shifted vertex inside its culling sphere after radius changes', () => {
    const dressing = make()
    const matrix = new THREE.Matrix4()
    const point = new THREE.Vector3()
    for (const radius of [2000, 1000, 1800]) {
      dressing.setPlatformRadius(radius)
      const shift = radius - 1300
      let outside = 0
      for (const mesh of meshes(dressing)) {
        if (!mesh.name.startsWith('rim-') && !mesh.name.startsWith('lava-fall-')) continue
        const position = mesh.geometry.getAttribute('position')
        const instances = mesh instanceof THREE.InstancedMesh ? mesh.count : 1
        const bounds = mesh instanceof THREE.InstancedMesh ? mesh.boundingSphere! : mesh.geometry.boundingSphere!
        for (let instance = 0; instance < instances; instance++) {
          if (mesh instanceof THREE.InstancedMesh) mesh.getMatrixAt(instance, matrix)
          else matrix.identity()
          for (let vertex = 0; vertex < position.count; vertex++) {
            point.fromBufferAttribute(position, vertex).applyMatrix4(matrix)
            const radial = Math.hypot(point.x, point.z)
            point.x += point.x / radial * shift
            point.z += point.z / radial * shift
            if (point.distanceTo(bounds.center) > bounds.radius + 0.001) outside++
          }
        }
      }
      expect(outside, `platform radius ${radius}`).toBe(0)
    }
  })
})
