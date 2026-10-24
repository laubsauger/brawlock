import * as THREE from 'three/webgpu'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { applyFx } from './materials'
import { abs, attribute, float, mix, step, vec3 } from 'three/tsl'
import { U } from './gpuState'
import { PART } from './wardrobe'
import type { WarlockGpu } from './gpuState'

export type TripoShoulders = 'none' | 'crescent' | 'thorn'
export interface TripoAccessoryLoadout {
  shoulders: TripoShoulders
  hood: boolean
  chest: boolean
  belt: boolean
  wrists: boolean
}

const diamond = (w: number, h: number): [number, number][] => [[0, h], [-w, 0], [0, -h], [w, 0]]
let material: THREE.MeshStandardNodeMaterial | null = null

/** Curved metal fittings in bind space; ornaments move with their attachment joint. */
export function buildTripoAccessories(reference: THREE.SkinnedMesh, loadout: TripoAccessoryLoadout): THREE.BufferGeometry | null {
  const bones = reference.skeleton.bones
  const index = (name: string) => {
    const i = bones.findIndex(b => b.name === name)
    if (i < 0) throw new Error(`Tripo accessory attachment joint missing: ${name}`)
    return i
  }
  const rest = (name: string) => new THREE.Vector3().setFromMatrixPosition(reference.skeleton.boneInverses[index(name)].clone().invert())
  if (!reference.parent) throw new Error('Accessory fitting requires the source garment hierarchy')
  const surfaces: THREE.BufferGeometry[] = []
  reference.parent.traverse(o => {
    const mesh = o as THREE.SkinnedMesh
    if (mesh.isSkinnedMesh && mesh.name !== 'TripoRegalia' && mesh.geometry.attributes.position) surfaces.push(mesh.geometry)
  })
  const ray = new THREE.Ray(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3()
  const front = (x: number, y: number) => {
    ray.set(new THREE.Vector3(x, y, 2), new THREE.Vector3(0, 0, -1))
    let depth = -Infinity
    for (const geometry of surfaces) {
      const p = geometry.attributes.position, ids = geometry.index, count = ids?.count ?? p.count
      for (let i = 0; i < count; i += 3) {
        a.fromBufferAttribute(p, ids ? ids.getX(i) : i)
        b.fromBufferAttribute(p, ids ? ids.getX(i + 1) : i + 1)
        c.fromBufferAttribute(p, ids ? ids.getX(i + 2) : i + 2)
        if (ray.intersectTriangle(a, b, c, false, hit)) depth = Math.max(depth, hit.z)
      }
    }
    if (!Number.isFinite(depth)) throw new Error(`No garment surface under accessory at ${x}, ${y}`)
    return depth
  }
  const pieces: THREE.BufferGeometry[] = []
  const add = (geometry: THREE.BufferGeometry, bone: string, part: number) => {
    const g = geometry.index ? geometry.toNonIndexed() : geometry
    if (g !== geometry) geometry.dispose()
    g.deleteAttribute('uv')
    const count = g.attributes.position.count
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(count).fill(part), 1))
    g.setAttribute('aT', new THREE.Float32BufferAttribute(new Float32Array(count), 1))
    g.setAttribute('aFlop', new THREE.Float32BufferAttribute(new Float32Array(count), 1))
    const indices = new Uint16Array(count * 4), weights = new Float32Array(count * 4)
    const joint = index(bone)
    for (let i = 0; i < count; i++) { indices[i * 4] = joint; weights[i * 4] = 1 }
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4))
    pieces.push(g)
  }
  const wire = (points: THREE.Vector3[], radius: number, bone: string, part: number, closed = false) => {
    add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points, closed), Math.max(8, points.length), radius, 4, closed), bone, part)
  }
  const extrude = (points: [number, number][], depth: number, hole?: [number, number][]) => {
    const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)))
    if (hole) shape.holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))))
    return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSize: .0012, bevelThickness: .0012, bevelSegments: 2, steps: 1, curveSegments: 6 })
  }
  const jewel = (bone: string, p: THREE.Vector3, width: number, height: number, tilt = -.2, roll = 0) => {
    p = p.clone().setZ(front(p.x, p.y) + .005)
    const m = new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, 0, roll)), new THREE.Vector3(1, 1, 1))
    // A narrow open bezel surrounds a real faceted stone. No stacked badge plates.
    add(extrude(diamond(width * 1.2, height * 1.1), .004, diamond(width * .9, height * .88)).applyMatrix4(m), bone, PART.bronze)
    const gem = new THREE.OctahedronGeometry(1, 0).scale(width, height, width * .5).translate(0, 0, .003).applyMatrix4(m)
    add(gem, bone, PART.glow)
    for (const y of [-height * .8, height * .8]) {
      const prong = new THREE.CylinderGeometry(.0015, .002, .01, 5).rotateX(Math.PI / 2).translate(0, y, .005).applyMatrix4(m)
      add(prong, bone, PART.iron)
    }
  }
  if (loadout.hood) jewel('Head', new THREE.Vector3(0, 1.805, .145), .011, .02, -.35)
  if (loadout.chest) {
    const p = rest('spine_03').setZ(.182).add(new THREE.Vector3(0, .06, 0))
    jewel('spine_03', p, .022, .044, -.15)
    for (const side of [-1, 1]) wire([
      p.clone().add(new THREE.Vector3(side * .018, .025, -.005)),
      p.clone().add(new THREE.Vector3(side * .045, .035, -.01)),
      p.clone().add(new THREE.Vector3(side * .085, .055, -.035)),
    ].map(v => v.setZ(front(v.x, v.y) + .004)), .002, 'spine_03', PART.bronze)
  }
  if (loadout.belt) jewel('spine_01', new THREE.Vector3(0, 1.164, .211), .021, .032, -.1)
  for (const side of [-1, 1]) {
    const suffix = side > 0 ? 'l' : 'r'
    if (loadout.wrists) {
      const bone = 'lowerarm_' + suffix, wrist = rest('hand_' + suffix)
      // The cuff follows the forearm's elliptical cross-section, with an inset
      // stone on its front. Two slim bands leave the source glove visible.
      for (const along of [.075, .11]) {
        const points = Array.from({ length: 24 }, (_, i) => {
          const a = i / 24 * Math.PI * 2
          return new THREE.Vector3(wrist.x - side * along, wrist.y + Math.cos(a) * .038, wrist.z + Math.sin(a) * .051)
        })
        wire(points, .0025, bone, PART.bronze, true)
      }
      jewel(bone, wrist.clone().add(new THREE.Vector3(-side * .092, 0, .055)), .015, .026, 0, Math.PI / 2)
    }
    if (loadout.shoulders === 'none') continue
    const bone = 'upperarm_' + suffix, origin = rest(bone)
    // A domed shell wraps the upper/front shoulder. Its curved border is actual
    // metal geometry; the crescent is inlaid into the same surface.
    const surface = (u: number, theta: number, lift = 0) => new THREE.Vector3(
      origin.x + side * (-.045 + u * .18),
      origin.y + (.098 * (1 - .25 * u) + lift) * Math.cos(theta),
      origin.z + (.123 * (1 - .18 * u) + lift) * Math.sin(theta),
    )
    const positions: number[] = [], indices: number[] = []
    const rows = 5, columns = 16
    for (let i = 0; i <= rows; i++) for (let j = 0; j <= columns; j++) {
      const u = i / rows, theta = -.9 + j / columns * (2.4 + .23 * Math.sin(u * Math.PI))
      positions.push(...surface(u, theta).toArray())
      if (i < rows && j < columns) {
        const a = i * (columns + 1) + j, b = a + columns + 1
        indices.push(a, b, a + 1, a + 1, b, b + 1)
      }
    }
    const shell = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)).setIndex(indices)
    shell.computeVertexNormals()
    add(shell, bone, PART.iron)
    for (const u of [0, 1]) wire(Array.from({ length: 18 }, (_, j) => surface(u, -.9 + j / 17 * 2.4, .002)), .002, bone, PART.bronze)
    wire(Array.from({ length: 10 }, (_, i) => surface(i / 9, 1.5 + .23 * Math.sin(i / 9 * Math.PI), .002)), .002, bone, PART.bronze)
    // Curved ornament coordinates: local X runs along the arm, Y over the cap.
    const inlay = (x: number, y: number, lift: number) => surface(.48 + x / .18, 1.04 - y / .078, lift)
    if (loadout.shoulders === 'crescent') {
      const points: [number, number][] = []
      for (let i = 0; i <= 18; i++) {
        const a = Math.PI * (.25 + i / 18 * 1.5)
        points.push([Math.cos(a) * .029, Math.sin(a) * .029])
      }
      for (let i = 18; i >= 0; i--) {
        const t = i / 18, a = Math.PI * (.25 + t * 1.5), r = .029 * (1 - .38 * Math.sin(t * Math.PI))
        points.push([Math.cos(a) * r, Math.sin(a) * r])
      }
      const g = extrude(points, .0015), p = g.attributes.position
      for (let i = 0; i < p.count; i++) { const v = inlay(p.getX(i), p.getY(i), .002 + p.getZ(i)); p.setXYZ(i, v.x, v.y, v.z) }
      g.computeVertexNormals(); add(g, bone, PART.glow)
    } else {
      for (const x of [-.022, 0, .022]) wire([inlay(x, -.022, .003), inlay(x * .5, 0, .004), inlay(x, .027, .003)], .0016, bone, PART.glow)
    }
  }
  if (!pieces.length) return null
  const geometry = mergeGeometries(pieces, false)
  for (const piece of pieces) piece.dispose()
  if (!geometry) throw new Error('Tripo accessories could not be merged')
  geometry.computeBoundingBox(); geometry.computeBoundingSphere()
  return geometry
}

function regaliaMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide })
  const part = attribute('aPart', 'float')
  const metal = step(.5, abs(part.sub(PART.glow)))
  const edge = float(1).sub(step(.5, abs(part.sub(PART.bronze))))
  const gem = float(1).sub(metal)
  const base = mix(vec3(.065, .07, .085), vec3(.22, .19, .135), edge).mul(metal).add(U.team.mul(.12).mul(gem))
  m.metalnessNode = metal.mul(.88)
  m.roughnessNode = mix(.21, .42, metal)
  const emissive = U.team.mul(gem).mul(float(.65).add(U.castCharge.mul(.4)).add(U.castFlare.mul(.5)))
  applyFx(m, base, emissive, attribute('position', 'vec3').y)
  return m
}

/** One additional skinned draw, sharing the game's player-color and state FX. */
export function attachTripoAccessories(actor: THREE.Object3D, gpu: WarlockGpu) {
  let reference: THREE.SkinnedMesh | undefined
  actor.traverse(o => { if (!reference && (o as THREE.SkinnedMesh).isSkinnedMesh) reference = o as THREE.SkinnedMesh })
  if (!reference?.parent) throw new Error('Tripo accessories require the fitted skinned model')
  const ref = reference
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), material ??= regaliaMaterial())
  mesh.name = 'TripoRegalia'
  mesh.userData.wl = gpu
  mesh.castShadow = mesh.receiveShadow = true
  mesh.frustumCulled = false
  ref.parent!.add(mesh)
  mesh.bind(ref.skeleton, ref.bindMatrix)
  return {
    mesh,
    setLoadout(loadout: TripoAccessoryLoadout) {
      const geometry = buildTripoAccessories(ref, loadout)
      mesh.geometry.dispose()
      mesh.visible = geometry !== null
      mesh.geometry = geometry ?? new THREE.BufferGeometry()
    },
    dispose() { mesh.removeFromParent(); mesh.geometry.dispose() },
  }
}
