import { describe, expect, it } from 'vitest'
import { Bone, Group, Matrix4, MeshStandardNodeMaterial, PlaneGeometry, Skeleton, SkinnedMesh } from 'three/webgpu'
import { buildTripoAccessories, type TripoAccessoryLoadout } from './tripoAccessories'

function reference() {
  const root = new Group()
  const positions: Record<string, number[]> = {
    Head: [0, 1.628, .026], spine_03: [0, 1.369, .0455], spine_01: [0, 1.13, .04],
    upperarm_l: [.19425, 1.48, .03], upperarm_r: [-.19425, 1.48, .03],
    lowerarm_l: [.4403, 1.46, .0339], lowerarm_r: [-.4403, 1.46, .0339],
    hand_l: [.74, 1.45, .07], hand_r: [-.74, 1.45, .07],
  }
  const bones = Object.entries(positions).map(([name, position]) => {
    const bone = new Bone(); bone.name = name; bone.position.fromArray(position); root.add(bone); return bone
  })
  root.updateMatrixWorld(true)
  const mesh = new SkinnedMesh(new PlaneGeometry(2, 2).translate(0, 1, .2), new MeshStandardNodeMaterial())
  root.add(mesh)
  mesh.bind(new Skeleton(bones), new Matrix4())
  return mesh
}

const full: TripoAccessoryLoadout = { shoulders: 'crescent', hood: true, chest: true, belt: true, wrists: true }

describe('fitted Tripo accessories', () => {
  it('has explicit independently removable slots', () => {
    const mesh = reference()
    expect(buildTripoAccessories(mesh, { shoulders: 'none', hood: false, chest: false, belt: false, wrists: false })).toBeNull()
    const fittings = buildTripoAccessories(mesh, { ...full, shoulders: 'none' })!
    const shoulders = buildTripoAccessories(mesh, { shoulders: 'crescent', hood: false, chest: false, belt: false, wrists: false })!
    const all = buildTripoAccessories(mesh, full)!
    expect(all.attributes.position.count).toBe(fittings.attributes.position.count + shoulders.attributes.position.count)
    expect(all.attributes.position.count / 3).toBeLessThan(4500)
    fittings.dispose(); shoulders.dispose(); all.dispose()
  })

  it('keeps bind-space geometry unchanged when equipment is changed during animation', () => {
    const mesh = reference(), before = buildTripoAccessories(mesh, full)!
    mesh.skeleton.bones.find(b => b.name === 'upperarm_l')!.rotation.z = 1.4
    mesh.skeleton.bones.find(b => b.name === 'lowerarm_r')!.rotation.y = -.8
    mesh.parent!.updateMatrixWorld(true)
    const after = buildTripoAccessories(mesh, full)!
    expect(Array.from(after.attributes.position.array)).toEqual(Array.from(before.attributes.position.array))
    expect(Array.from(after.attributes.skinIndex.array)).toEqual(Array.from(before.attributes.skinIndex.array))
    before.dispose(); after.dispose()
  })

  it.each(['crescent', 'thorn'] as const)('has finite curved geometry and valid rigid skin weights: %s', shoulders => {
    const mesh = reference(), geometry = buildTripoAccessories(mesh, { ...full, shoulders })!
    for (const name of ['position', 'normal']) expect(Array.from(geometry.attributes[name].array).every(Number.isFinite)).toBe(true)
    const weights = geometry.attributes.skinWeight, joints = geometry.attributes.skinIndex
    for (let i = 0; i < weights.count; i++) {
      expect(weights.getX(i)).toBe(1)
      expect(weights.getY(i) + weights.getZ(i) + weights.getW(i)).toBe(0)
      expect(joints.getX(i)).toBeLessThan(mesh.skeleton.bones.length)
    }
    const shoulderJoint = mesh.skeleton.bones.findIndex(b => b.name === 'upperarm_l')
    const z = Array.from({ length: joints.count }, (_, i) => i).filter(i => joints.getX(i) === shoulderJoint).map(i => geometry.attributes.position.getZ(i))
    expect(Math.max(...z) - Math.min(...z)).toBeGreaterThan(.1)
    geometry.dispose()
  })
})
