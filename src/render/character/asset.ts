import * as THREE from 'three/webgpu'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { buildCloth, buildStaff, buildVoid, type RigRest, type StaffGeometry, type StaffVariant } from './geometry'
import { clothParams, createClothMaterial, createGloveMaterial, createOutfitMaterial, createStaffMaterial, createVoidMaterial } from './materials'

/**
 * Loads public/models/warlock/warlock.glb (CC0 Quaternius rig + outfit parts +
 * clips, see docs/ASSETS.md) once and turns it into a shared template:
 * de-quantized, outfit parts merged into one skinned draw, the custom cloth
 * and hood void added, our TSL materials assigned, clips split into
 * lower / upper body halves for layered playback.
 */

export const WARLOCK_URL = `${import.meta.env.BASE_URL}models/warlock/warlock.glb`

/** Bones that belong to the lower-body layer; everything else is upper body. */
const LOWER = /^(root|pelvis|spine_01|thigh_[lr]|calf_[lr]|foot_[lr]|ball_[lr]|ball_leaf_[lr])$/

export interface ClipPair {
  full: THREE.AnimationClip
  lo: THREE.AnimationClip
  up: THREE.AnimationClip
}

export interface WarlockAsset {
  /** cloned per warlock (SkeletonUtils.clone) */
  template: THREE.Group
  clips: Record<string, ClipPair>
  /** additive (relative to frame 0) hit reactions */
  additive: Record<string, THREE.AnimationClip>
  staffs: Record<StaffVariant, StaffGeometry>
  staffMaterial: THREE.Material
  /** rest-pose positions (model metres) used by the runtime */
  rest: { height: number; palmL: THREE.Vector3; palmR: THREE.Vector3; gripR: THREE.Vector3; eyes: THREE.Vector3 }
  /** triangles per warlock (for the budget readout) */
  triangles: number
}

let pending: Promise<WarlockAsset> | null = null
let loaded: WarlockAsset | null = null

export function loadWarlockAsset(url = WARLOCK_URL): Promise<WarlockAsset> {
  if (!pending) {
    pending = build(url).then((a) => (loaded = a))
    pending.catch(() => (pending = null))
  }
  return pending
}

export function getWarlockAsset(): WarlockAsset | null {
  return loaded
}

/** Float copy of a (possibly quantized / normalized) attribute. */
function toFloat(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute {
  const n = a.count
  const s = a.itemSize
  const out = new Float32Array(n * s)
  for (let i = 0; i < n; i++) for (let k = 0; k < s; k++) out[i * s + k] = a.getComponent(i, k)
  return new THREE.BufferAttribute(out, s)
}

const KEEP = ['position', 'normal', 'uv', 'skinIndex', 'skinWeight']

/** Geometry in plain float rest-space metres (undo meshopt quantization folded into the skin). */
function restGeometry(mesh: THREE.SkinnedMesh): THREE.BufferGeometry {
  const src = mesh.geometry
  const g = new THREE.BufferGeometry()
  for (const name of KEEP) {
    const a = src.getAttribute(name)
    if (!a) continue
    if (name === 'skinIndex') {
      const out = new Uint16Array(a.count * 4)
      for (let i = 0; i < a.count; i++) for (let k = 0; k < 4; k++) out[i * 4 + k] = a.getComponent(i, k)
      g.setAttribute(name, new THREE.BufferAttribute(out, 4))
    } else g.setAttribute(name, toFloat(a))
  }
  if (src.index) g.setIndex(Array.from(src.index.array))
  // quantization lives in the inverse bind matrices: T = boneWorld(rest) * boneInverse
  const sk = mesh.skeleton
  const T = new THREE.Matrix4().multiplyMatrices(sk.bones[0].matrixWorld, sk.boneInverses[0])
  const check = new THREE.Matrix4()
  let dev = 0
  for (let i = 1; i < sk.bones.length; i += 7) {
    check.multiplyMatrices(sk.bones[i].matrixWorld, sk.boneInverses[i])
    for (let k = 0; k < 16; k++) dev = Math.max(dev, Math.abs(check.elements[k] - T.elements[k]))
  }
  if (dev > 1e-3) console.warn(`warlock: rest pose differs from bind pose (${dev.toFixed(4)})`)
  g.applyMatrix4(T)
  const nrm = g.getAttribute('normal')
  if (nrm) {
    const v = new THREE.Vector3()
    for (let i = 0; i < nrm.count; i++) {
      v.fromBufferAttribute(nrm, i).normalize()
      nrm.setXYZ(i, v.x, v.y, v.z)
    }
  }
  return g
}

async function build(url: string): Promise<WarlockAsset> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
  const gltf = await loader.loadAsync(url)
  const scene = gltf.scene
  scene.updateMatrixWorld(true)
  const armature = scene.getObjectByName('Armature') ?? scene
  const skinned: THREE.SkinnedMesh[] = []
  scene.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(o as THREE.SkinnedMesh)
  })
  if (skinned.length === 0) throw new Error('warlock.glb: no skinned meshes')
  const bones = skinned[0].skeleton.bones
  const skeleton = new THREE.Skeleton(bones)
  skeleton.calculateInverses()

  // ---- outfit: every ranger-atlas primitive in one draw; the hands separately (glove material)
  const outfitGeos: THREE.BufferGeometry[] = []
  let outfitSrc: THREE.MeshStandardMaterial | null = null
  let gloveGeo: THREE.BufferGeometry | null = null
  let gloveSrc: THREE.MeshStandardMaterial | null = null
  for (const m of skinned) {
    const mat = m.material as THREE.MeshStandardMaterial
    const g = restGeometry(m)
    if (/Regular_Male|Skin/i.test(mat.name)) {
      gloveGeo = gloveGeo ? mergeGeometries([gloveGeo, g])! : g
      gloveSrc = mat
    } else {
      outfitGeos.push(g)
      outfitSrc = mat
    }
    m.removeFromParent()
  }
  if (!outfitSrc || outfitGeos.length === 0) throw new Error('warlock.glb: outfit material missing')
  const outfitGeo = mergeGeometries(outfitGeos)
  if (!outfitGeo) throw new Error('warlock.glb: outfit merge failed')

  // ---- rig measurements for the procedural parts
  const restPos = new Map<string, THREE.Vector3>()
  const boneIndex = new Map<string, number>()
  bones.forEach((b, i) => {
    restPos.set(b.name, new THREE.Vector3().setFromMatrixPosition(b.matrixWorld))
    boneIndex.set(b.name, i)
  })
  const bonePos = (n: string) => {
    const v = restPos.get(n)
    if (!v) throw new Error(`warlock rig: no bone ${n}`)
    return v.clone()
  }

  // ---- body under the robe: drop the pants / tunic skirt above the knees
  // (always covered by the coat, and the first thing to poke through it), and
  // measure the lower legs (boots) for the cloth capsules
  const beltY = bonePos('pelvis').y + 0.04
  let calfR = 0.07
  let shoulderR = 0.08
  {
    const pos = outfitGeo.getAttribute('position')
    const si = outfitGeo.getAttribute('skinIndex')
    const sw = outfitGeo.getAttribute('skinWeight')
    const n = pos.count
    const dom = new Int32Array(n)
    for (let v = 0; v < n; v++) {
      let best = 0
      let bw = -1
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(v, k)
        if (w > bw) {
          bw = w
          best = si.getComponent(v, k)
        }
      }
      dom[v] = best
    }
    const hidden = new Set(['pelvis', 'thigh_l', 'thigh_r', 'spine_01'].map((nm) => boneIndex.get(nm)!))
    const idx = outfitGeo.index!
    const keep: number[] = []
    for (let t = 0; t < idx.count; t += 3) {
      const a = idx.getX(t)
      const b = idx.getX(t + 1)
      const c = idx.getX(t + 2)
      const under = hidden.has(dom[a]) && hidden.has(dom[b]) && hidden.has(dom[c])
      const low = Math.max(pos.getY(a), pos.getY(b), pos.getY(c)) < beltY - 0.04
      if (!(under && low)) keep.push(a, b, c)
    }
    outfitGeo.setIndex(keep)
    // boot / lower-leg radius around knee -> ankle (98th percentile), for the cloth capsules
    const seg = new THREE.Line3()
    const cp = new THREE.Vector3()
    const pv = new THREE.Vector3()
    const radii = (bone: string, from: string, to: string) => {
      const bi = boneIndex.get(bone)!
      seg.set(bonePos(from), bonePos(to))
      const r: number[] = []
      for (let v = 0; v < n; v++) {
        if (dom[v] !== bi) continue
        pv.fromBufferAttribute(pos, v)
        seg.closestPointToPoint(pv, true, cp)
        r.push(pv.distanceTo(cp))
      }
      r.sort((x, y) => x - y)
      return r.length ? r[Math.floor(r.length * 0.98)] : 0
    }
    calfR = Math.max(calfR, radii('calf_l', 'calf_l', 'foot_l'), radii('calf_r', 'calf_r', 'foot_r'))
    shoulderR = Math.max(shoulderR, radii('upperarm_l', 'upperarm_l', 'lowerarm_l'))
    // debug tint for the clipping check: 1 = hips / thighs / lower spine, the robe
    // must always cover them; 2 = lower legs above the hem, legitimately seen
    // through the front split while striding
    const cover = new Float32Array(n)
    const calves = new Set(['calf_l', 'calf_r'].map((nm) => boneIndex.get(nm)!))
    for (let v = 0; v < n; v++) {
      if (pos.getY(v) < 0.22) continue
      if (hidden.has(dom[v])) cover[v] = 1
      else if (calves.has(dom[v])) cover[v] = 2
    }
    outfitGeo.setAttribute('aCover', new THREE.BufferAttribute(cover, 1))
  }
  clothParams.calfR.value = calfR + 0.012
  clothParams.armR.value = shoulderR + 0.012

  const opos = outfitGeo.getAttribute('position')
  const rig: RigRest = {
    pos: bonePos,
    index: (n) => {
      const i = boneIndex.get(n)
      if (i === undefined) throw new Error(`warlock rig: no bone ${n}`)
      return i
    },
    slice: (y0, y1) => {
      const r = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 }
      for (let i = 0; i < opos.count; i++) {
        const y = opos.getY(i)
        if (y < y0 || y > y1) continue
        const x = opos.getX(i)
        if (Math.abs(x) > 0.3) continue // T-pose arms
        const z = opos.getZ(i)
        r.minX = Math.min(r.minX, x)
        r.maxX = Math.max(r.maxX, x)
        r.minZ = Math.min(r.minZ, z)
        r.maxZ = Math.max(r.maxZ, z)
      }
      return r
    },
  }

  const bindIdentity = new THREE.Matrix4()
  const addSkinned = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string) => {
    const mesh = new THREE.SkinnedMesh(geo, mat)
    mesh.name = name
    mesh.castShadow = true
    mesh.receiveShadow = true
    armature.add(mesh)
    mesh.bind(skeleton, bindIdentity)
    mesh.frustumCulled = false
    return mesh
  }
  addSkinned(outfitGeo, createOutfitMaterial(outfitSrc), 'WarlockOutfit')
  const palmL = rig.pos('hand_l').add(new THREE.Vector3(0.085, -0.025, 0.01))
  const palmR = rig.pos('hand_r').add(new THREE.Vector3(-0.085, -0.025, 0.01))
  if (gloveGeo && gloveSrc) addSkinned(gloveGeo, createGloveMaterial(gloveSrc, rig.pos('hand_l').x), 'WarlockGloves')
  const clothGeo = buildCloth(rig)
  addSkinned(clothGeo, createClothMaterial(), 'WarlockCloth')

  // ---- hood void + eyes, rigid on the Head bone
  {
    const head = bones[rig.index('Head')]
    const g = buildVoid(rig.pos('Head'))
    g.applyMatrix4(new THREE.Matrix4().copy(head.matrixWorld).invert())
    const mesh = new THREE.Mesh(g, createVoidMaterial())
    mesh.name = 'WarlockVoid'
    head.add(mesh)
  }

  // ---- clips: lower / upper halves for layered playback, additive hits
  const clips: Record<string, ClipPair> = {}
  const additive: Record<string, THREE.AnimationClip> = {}
  const boneOf = (track: THREE.KeyframeTrack) => track.name.slice(0, track.name.lastIndexOf('.'))
  for (const clip of gltf.animations) {
    const lo = new THREE.AnimationClip(`${clip.name}_lo`, clip.duration, clip.tracks.filter((t) => LOWER.test(boneOf(t))))
    const up = new THREE.AnimationClip(`${clip.name}_up`, clip.duration, clip.tracks.filter((t) => !LOWER.test(boneOf(t))))
    clips[clip.name] = { full: clip, lo, up }
  }
  for (const name of ['hit', 'hitHead']) {
    const c = clips[name]?.full
    if (!c) continue
    // translation would shove the whole body; keep rotations only
    const rot = new THREE.AnimationClip(`${name}_add`, c.duration, c.tracks.filter((t) => t.name.endsWith('.quaternion')).map((t) => t.clone()))
    additive[name] = THREE.AnimationUtils.makeClipAdditive(rot)
  }

  const template = new THREE.Group()
  template.name = 'WarlockTemplate'
  template.add(armature)
  let triangles = 0
  template.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    const g = m.geometry
    triangles += (g.index ? g.index.count : g.getAttribute('position').count) / 3
  })

  const staffs = { gnarled: buildStaff('gnarled'), iron: buildStaff('iron'), bone: buildStaff('bone') }
  const box = new THREE.Box3().setFromBufferAttribute(opos as THREE.BufferAttribute)
  return {
    template,
    clips,
    additive,
    staffs,
    staffMaterial: createStaffMaterial(),
    rest: { height: box.max.y, palmL, palmR, gripR: rig.pos('hand_r').add(new THREE.Vector3(-0.05, -0.03, 0.0)), eyes: rig.pos('Head').add(new THREE.Vector3(0, 0.068, 0.068)) },
    triangles,
  }
}
