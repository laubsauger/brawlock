import { describe, expect, it } from 'vitest'
import { Bone, BufferGeometry, Group, Matrix4, MeshBasicMaterial, Skeleton, SkinnedMesh, Vector3 } from 'three/webgpu'
import { buildTripoCape, poseCapeGuides } from './tripoCape'
import { CapeDrape } from './tripoCapeDrape'

function reference() {
  const parent = new Group()
  const bones = ['spine_03', 'spine_02', 'spine_01', 'pelvis', 'thigh_l'].map(name => {
    const bone = new Bone(); bone.name = name; parent.add(bone); return bone
  })
  parent.updateMatrixWorld(true)
  const mesh = new SkinnedMesh(new BufferGeometry(), new MeshBasicMaterial())
  parent.add(mesh); mesh.bind(new Skeleton(bones), new Matrix4())
  return mesh
}

describe('long fitted emblem cape', () => {
  it('reaches below the knees with a flared hem and a single 576-triangle draw', () => {
    const g = buildTripoCape(reference())
    expect(g.index!.count / 3).toBe(576)
    expect(g.boundingBox!.min.y).toBeGreaterThan(.35)
    expect(g.boundingBox!.min.y).toBeLessThan(.5)
    expect(g.boundingBox!.max.x - g.boundingBox!.min.x).toBeLessThan(.65)
    expect(Array.from(g.attributes.position.array).every(Number.isFinite)).toBe(true)
    g.dispose()
  })

  it('pins the shoulder row to the chest and never takes leg weights', () => {
    const mesh = reference(), g = buildTripoCape(mesh)
    const joints = g.attributes.skinIndex, weights = g.attributes.skinWeight
    for (let i = 0; i < weights.count; i++) {
      expect(weights.getX(i) + weights.getY(i) + weights.getZ(i) + weights.getW(i)).toBeCloseTo(1)
      for (let k = 0; k < 4; k++) expect(joints.getComponent(i, k)).toBeLessThan(4)
    }
    for (let i = 0; i <= 12; i++) expect(weights.getX(i)).toBe(1)
    g.dispose()
  })

  it('faces the back and orients the emblem UV for text read from behind', () => {
    const g = buildTripoCape(reference()), uv = g.attributes.uv, normal = g.attributes.normal
    expect(uv.getX(0)).toBe(1)
    expect(uv.getX(12)).toBe(0)
    expect(uv.getY(0)).toBe(0)
    const meanZ = Array.from({ length: normal.count }, (_, i) => normal.getZ(i)).reduce((a, b) => a + b) / normal.count
    expect(meanZ).toBeLessThan(-.8)
    g.dispose()
  })

  it('keeps the hem asymmetric and uses bind geometry regardless of current pose', () => {
    const mesh = reference(), a = buildTripoCape(mesh)
    mesh.skeleton.bones[0].rotation.x = .8; mesh.parent!.updateMatrixWorld(true)
    const b = buildTripoCape(mesh)
    expect(Array.from(a.attributes.position.array)).toEqual(Array.from(b.attributes.position.array))
    const p = a.attributes.position, start = 24 * 13
    expect(p.getY(start + 3)).not.toBeCloseTo(p.getY(start + 9), 3)
    a.dispose(); b.dispose()
  })

  it('keeps attachment guides in model space when a pawn translates, turns and scales', () => {
    const mesh = reference(), g = buildTripoCape(mesh)
    const skin = new SkinnedMesh(g, mesh.material); skin.bind(mesh.skeleton, mesh.bindMatrix)
    const rest = Array.from({ length: g.attributes.position.count }, (_, i) => new Vector3().fromBufferAttribute(g.attributes.position, i))
    const targets = rest.map(p => p.clone())
    for (const scale of [1, .01, 100]) {
      mesh.parent!.position.set(12, 3, -8); mesh.parent!.rotation.set(0, 1.2, 0); mesh.parent!.scale.setScalar(scale)
      mesh.parent!.updateWorldMatrix(true, true)
      poseCapeGuides(skin, mesh.matrixWorld, rest, targets)
      // Float32 skin weights retain sub-millimetre precision at game scale.
      for (let i = 0; i < rest.length; i++) expect(targets[i].distanceTo(rest[i])).toBeLessThan(1e-4)
    }
    g.dispose()
  })
})

describe('cape gravity and fibres', () => {
  const gravity = new Vector3(0, -9.81, 0), still = new Vector3()
  const noContact = () => {}

  it('keeps its shoulders attached while the hem hangs below a leaning torso', () => {
    const g = buildTripoCape(reference()), cloth = new CapeDrape(g, 12)
    const lean = new Matrix4().makeRotationX(.6)
    const targets = cloth.rest.map(p => p.clone().sub(new Vector3(0, 1.47, 0)).applyMatrix4(lean).add(new Vector3(0, 1.47, 0)))
    cloth.reset(targets)
    for (let frame = 0; frame < 120; frame++) cloth.update(1 / 60, targets, cloth.rest, gravity, still, noContact)
    for (let i = 0; i <= 12; i++) expect(cloth.points[i].distanceTo(targets[i])).toBeLessThan(1e-6)
    const hem = cloth.points.length - 7
    expect(cloth.points[hem].y).toBeLessThan(targets[hem].y - .10)
    expect(cloth.points[hem].z).toBeGreaterThan(targets[hem].z + .20)
    g.dispose()
  })

  it('resists rubber-like stretching under movement and freezes with playback', () => {
    const g = buildTripoCape(reference()), cloth = new CapeDrape(g, 12)
    const targets = cloth.rest.map(p => p.clone()), wind = new Vector3(0, 0, -2)
    for (let frame = 0; frame < 120; frame++) {
      for (let i = 0; i < targets.length; i++) targets[i].copy(cloth.rest[i]).add(new Vector3(Math.sin(frame / 30) * .03, 0, Math.sin(frame / 40) * .1))
      cloth.update(1 / 60, targets, targets, gravity, wind, noContact)
    }
    let maxStretch = 1
    for (let i = 13; i < cloth.points.length; i++) maxStretch = Math.max(maxStretch, cloth.points[i].distanceTo(cloth.points[i - 13]) / cloth.rest[i].distanceTo(cloth.rest[i - 13]))
    expect(maxStretch).toBeLessThan(1.15)
    const pose = cloth.points.map(p => p.toArray())
    cloth.update(0, targets, targets, gravity, wind, noContact)
    expect(cloth.points.map(p => p.toArray())).toEqual(pose)
    cloth.reset(targets)
    expect(cloth.points.map(p => p.toArray())).toEqual(targets.map(p => p.toArray()))
    g.dispose()
  })

  it('limits slow-frame work to two steps instead of accumulating catch-up work', () => {
    const g = buildTripoCape(reference()), cloth = new CapeDrape(g, 12)
    let contacts = 0
    cloth.update(10, cloth.rest, cloth.rest, gravity, still, () => { contacts++ })
    expect(cloth.lastSteps).toBe(2)
    expect(contacts).toBeLessThanOrEqual((cloth.points.length - 13) * 2)
    cloth.update(1 / 60, cloth.rest, cloth.rest, gravity, still, noContact)
    expect(cloth.lastSteps).toBe(1)
    g.dispose()
  })

  it('lifts the hem when a contact takes up fabric instead of stretching its fibres', () => {
    const g = buildTripoCape(reference()), cloth = new CapeDrape(g, 12)
    for (let frame = 0; frame < 120; frame++) cloth.update(1 / 60, cloth.rest, cloth.rest, gravity, still, (p, i) => {
      if (Math.floor(i / 13) === 8) p.z -= .3
    })
    for (let i = 13; i < cloth.points.length; i++) {
      const length = cloth.rest[i].distanceTo(cloth.rest[i - 13])
      expect(cloth.points[i].distanceTo(cloth.points[i - 13])).toBeLessThanOrEqual(length + 1e-6)
    }
    const hem = cloth.points.length - 7
    expect(cloth.points[hem].y).toBeGreaterThan(cloth.rest[hem].y + .03)
    g.dispose()
  })

  it('retains a long drape through sustained gusts and intermittent frame hitches', () => {
    const g = buildTripoCape(reference()), cloth = new CapeDrape(g, 12)
    const goals = cloth.rest.map(p => p.clone()), wind = new Vector3()
    for (let frame = 0; frame < 1200; frame++) {
      wind.set(Math.sin(frame / 30) * 2, 0, -4)
      cloth.update(frame % 120 === 0 ? .2 : 1 / 60, goals, goals, gravity, wind, (p, i) => {
        p.z = Math.min(p.z, goals[i].z + .002)
      })
    }
    for (let i = 0; i < cloth.points.length; i++) {
      expect(Number.isFinite(cloth.points[i].lengthSq())).toBe(true)
      expect(cloth.points[i].distanceTo(goals[i])).toBeLessThan(.15)
    }
    g.computeBoundingBox()
    expect(g.boundingBox!.max.y - g.boundingBox!.min.y).toBeGreaterThan(.9)
    g.dispose()
  })
})
