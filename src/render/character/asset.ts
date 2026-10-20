import * as THREE from 'three/webgpu'
import { assetUrl } from '../../lib/assets'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { KIND, buildCloth, buildStaff, buildVoid, setCalfRadiusHint, type RigRest, type StaffGeometry, type StaffVariant } from './geometry'
import { clothParams, createClothMaterial, createOutfitMaterial, createStaffMaterial, createTrinketMaterial } from './materials'
import { buildOutfit, type Outfit } from './wardrobe'

/**
 * Loads public/models/warlock/warlock.glb (CC0 Quaternius rig + outfit parts +
 * clips, see docs/ASSETS.md) once and turns it into a shared template:
 * de-quantized, outfit parts merged into one skinned draw, the custom cloth
 * and hood void added, our TSL materials assigned, clips split into
 * lower / upper body halves for layered playback.
 */

export const WARLOCK_URL = assetUrl('models/warlock/warlock.glb')

/** finger bones (animated only by the cast clips) */
const FINGER = /^(index|middle|ring|pinky|thumb)_0[1-4](_leaf)?_[lr]$/
const FINGER_CLIPS = new Set(['castEnter', 'castLoop', 'castShoot', 'castExit'])

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
  /** worn cosmetic shapes (wardrobe.ts): merged geometry per outfit, built on first use */
  outfit(o: Outfit): THREE.BufferGeometry | null
  trinketMaterial: THREE.Material
  /** rest-pose positions (model metres) used by the runtime */
  rest: {
    height: number
    palmL: THREE.Vector3
    palmR: THREE.Vector3
    /** staff hand (left): centre of the closed fist and the shaft direction through it (unit, thumb side) */
    gripL: THREE.Vector3
    gripAxisL: THREE.Vector3
    /** left-hand finger curl axis (unit): +angle closes the fingers toward the palm */
    curlAxisL: THREE.Vector3
    eyes: THREE.Vector3
  }
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
  // the hands share the outfit draw: aGlove picks their texture set in the shader
  const flag = (g: THREE.BufferGeometry, v: number) => g.setAttribute('aGlove', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(v), 1))
  for (const g of outfitGeos) flag(g, 0)
  if (gloveGeo) {
    flag(gloveGeo, 1)
    outfitGeos.push(gloveGeo)
  }
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
  const headBones = new Set(['Head', 'neck_01'].map((nm) => boneIndex.get(nm)!))
  let domAll = new Int32Array(0)
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
    domAll = dom
    const hidden = new Set(['pelvis', 'thigh_l', 'thigh_r', 'spine_01'].map((nm) => boneIndex.get(nm)!))
    const calfIdx = new Set(['calf_l', 'calf_r'].map((nm) => boneIndex.get(nm)!))
    const kneeY = bonePos('calf_l').y
    const idx = outfitGeo.index!
    const keep: number[] = []
    for (let t = 0; t < idx.count; t += 3) {
      const a = idx.getX(t)
      const b = idx.getX(t + 1)
      const c = idx.getX(t + 2)
      const ya = pos.getY(a)
      const yb = pos.getY(b)
      const yc = pos.getY(c)
      // thighs / hips under the coat (any corner), and the pants around the knee
      // above the boot tops: the underlayer trousers replace both
      const thigh = (hidden.has(dom[a]) || hidden.has(dom[b]) || hidden.has(dom[c])) && Math.max(ya, yb, yc) < beltY
      const kneePants = calfIdx.has(dom[a]) && calfIdx.has(dom[b]) && calfIdx.has(dom[c]) && Math.min(ya, yb, yc) > kneeY - 0.1
      if (!thigh && !kneePants) keep.push(a, b, c)
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
    // two channels (x = must hide, y = legit through the split) so interpolation
    // between flagged and unflagged corners never fakes the other class
    const cover = new Float32Array(n * 2)
    const calves = new Set(['calf_l', 'calf_r'].map((nm) => boneIndex.get(nm)!))
    for (let v = 0; v < n; v++) {
      const y = pos.getY(v)
      if (y < 0.22) continue
      // above the sash the tunic is meant to show
      if (hidden.has(dom[v]) && y < beltY + 0.02) cover[v * 2] = 1
      else if (calves.has(dom[v])) cover[v * 2 + 1] = 1
    }
    outfitGeo.setAttribute('aCover', new THREE.BufferAttribute(cover, 2))
  }
  clothParams.calfR.value = calfR + 0.012
  setCalfRadiusHint(calfR + 0.004)
  clothParams.armR.value = shoulderR + 0.012

  const opos = outfitGeo.getAttribute('position')
  const rig: RigRest = {
    pos: bonePos,
    index: (n) => {
      const i = boneIndex.get(n)
      if (i === undefined) throw new Error(`warlock rig: no bone ${n}`)
      return i
    },
    slice: (y0, y1, part) => {
      const r = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 }
      for (let i = 0; i < opos.count; i++) {
        const y = opos.getY(i)
        if (y < y0 || y > y1) continue
        if (part) {
          const isHead = headBones.has(domAll[i])
          if ((part === 'head') !== isHead) continue
        }
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
  addSkinned(outfitGeo, createOutfitMaterial(outfitSrc, gloveSrc, rig.pos('hand_l').x), 'WarlockOutfit')
  const palmL = rig.pos('hand_l').add(new THREE.Vector3(0.085, -0.025, 0.01))
  const palmR = rig.pos('hand_r').add(new THREE.Vector3(-0.085, -0.025, 0.01))
  // staff fist (bind pose: T-pose, palms down, thumbs forward): the shaft runs
  // through the curled fingers along the knuckle line (pinky -> index)
  const fingersL = rig.pos('middle_01_l').sub(rig.pos('hand_l')).normalize()
  const palmDown = new THREE.Vector3(0, -1, 0)
  const gripL = rig.pos('hand_l').addScaledVector(fingersL, 0.1).addScaledVector(palmDown, 0.032)
  const gripAxisL = rig.pos('index_01_l').sub(rig.pos('pinky_01_l')).normalize()
  const curlAxisL = new THREE.Vector3().crossVectors(fingersL, palmDown).normalize()
  // ---- cloth + the hood void / eyes (skinned 100 % to the Head bone) in one draw
  {
    const vg = buildVoid(rig.pos('Head'))
    const n = vg.getAttribute('position').count
    const part = vg.getAttribute('aPart')
    const cl = new Float32Array(n * 4)
    const si = new Uint16Array(n * 4)
    const sw = new Float32Array(n * 4)
    const headI = rig.index('Head')
    for (let i = 0; i < n; i++) {
      cl[i * 4 + 2] = KIND.void
      cl[i * 4 + 3] = part.getX(i) > 0.5 ? 1 : 0
      si[i * 4] = headI
      sw[i * 4] = 1
    }
    vg.deleteAttribute('aPart')
    vg.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2))
    vg.setAttribute('aCloth', new THREE.BufferAttribute(cl, 4))
    vg.setAttribute('aDim', new THREE.BufferAttribute(new Float32Array(n * 2), 2))
    vg.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4))
    vg.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4))
    const clothGeo = mergeGeometries([buildCloth(rig), vg])
    if (!clothGeo) throw new Error('warlock: cloth + void merge failed')
    addSkinned(clothGeo, createClothMaterial(rig.pos('neck_01').z), 'WarlockCloth')
  }

  // ---- clips: lower / upper halves for layered playback, additive hits
  const clips: Record<string, ClipPair> = {}
  const additive: Record<string, THREE.AnimationClip> = {}
  const boneOf = (track: THREE.KeyframeTrack) => track.name.slice(0, track.name.lastIndexOf('.'))
  // Fingers are 30 of the 65 bones but a few pixels on screen: they stay in a
  // relaxed pose (the idle clip's first frame, baked into the rest pose) and
  // only the cast clips animate them (open palm). Halves the mixer's work.
  {
    const idle = gltf.animations.find((c) => c.name === 'idle')
    if (idle) {
      for (const t of idle.tracks) {
        const b = boneOf(t)
        if (!FINGER.test(b) || !t.name.endsWith('.quaternion')) continue
        const bone = bones[boneIndex.get(b) ?? -1]
        if (bone) bone.quaternion.fromArray(t.values as unknown as number[], 0)
      }
    }
  }
  for (const clip of gltf.animations) {
    const keepFingers = FINGER_CLIPS.has(clip.name)
    const tracks = keepFingers ? clip.tracks : clip.tracks.filter((t) => !FINGER.test(boneOf(t)))
    const full = keepFingers ? clip : new THREE.AnimationClip(clip.name, clip.duration, tracks)
    const lo = new THREE.AnimationClip(`${clip.name}_lo`, clip.duration, tracks.filter((t) => LOWER.test(boneOf(t))))
    const up = new THREE.AnimationClip(`${clip.name}_up`, clip.duration, tracks.filter((t) => !LOWER.test(boneOf(t))))
    clips[clip.name] = { full, lo, up }
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
  const outfits = new Map<string, THREE.BufferGeometry | null>()
  return {
    outfit(o) {
      const key = `${o.head ?? ''}|${o.back ?? ''}`
      if (!outfits.has(key)) outfits.set(key, buildOutfit(rig, o))
      return outfits.get(key)!
    },
    trinketMaterial: createTrinketMaterial(),
    template,
    clips,
    additive,
    staffs,
    staffMaterial: createStaffMaterial(),
    rest: { height: box.max.y, palmL, palmR, gripL, gripAxisL, curlAxisL, eyes: rig.pos('Head').add(new THREE.Vector3(0, 0.068, 0.068)) },
    triangles,
  }
}
