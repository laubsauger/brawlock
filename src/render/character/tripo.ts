import * as THREE from 'three/webgpu'
import { attribute, float, texture, uniform, vec3 } from 'three/tsl'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { assetUrl } from '../../lib/assets'
import { loadWarlockAsset, prepareWarlockClips, relaxWarlockFingers, type WarlockAsset } from './asset'
import { attachTripoCape } from './tripoCape'
import { attachTripoAccessories } from './tripoAccessories'
import { warlockParams } from './config'
import { U } from './gpuState'
import { applyFx } from './materials'
import { ClothProxy } from './pipeline/cloth-proxy.js'
import { attachClothMaterial, prepareClothAttributes } from './pipeline/cloth-material.js'
import { attachPlayerLook } from './pipeline/player-look-material.js'
import { attachPreviewFace } from './pipeline/preview-face.js'

// An explicit look-dev selection. The default character and inventory stay under
// their existing owners; only fitted starter geometry ships in this candidate.
export const TRIPO_URL = assetUrl('models/warlock/tripo/warlock-10k.glb')
const PROXY_URL = assetUrl('models/warlock/tripo/cloth-proxy.json')
let pending: Promise<WarlockAsset> | null = null
let loaded: WarlockAsset | null = null

export function getTripoAsset(): WarlockAsset | null { return loaded }

export function loadTripoAsset(): Promise<WarlockAsset> {
  if (!pending) {
    pending = build().then(asset => (loaded = asset))
    pending.catch(() => { pending = null })
  }
  return pending
}

async function build(): Promise<WarlockAsset> {
  const [gltf, response, canonical] = await Promise.all([
    new GLTFLoader().loadAsync(TRIPO_URL), fetch(PROXY_URL), loadWarlockAsset(),
  ])
  if (!response.ok) throw new Error(`Tripo cloth data: HTTP ${response.status}`)
  const proxy = await response.json() as { id: string; colliders: unknown[] }
  if (!proxy.id || !Array.isArray(proxy.colliders)) throw new Error('Tripo cloth data is missing its build identity or fitted colliders')
  const model = gltf.scene
  model.updateMatrixWorld(true)
  prepareClothAttributes(model)
  const bones = new Map<string, THREE.Bone>()
  let triangles = 0
  model.traverse(o => {
    if ((o as THREE.Bone).isBone) bones.set(o.name, o as THREE.Bone)
    const mesh = o as THREE.SkinnedMesh
    if (!mesh.isSkinnedMesh) return
    if (mesh.userData.cloth_proxy_id !== proxy.id) throw new Error('Tripo mesh and cloth proxy build identities differ')
    mesh.frustumCulled = false
    mesh.castShadow = mesh.receiveShadow = true
    triangles += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3
  })
  if (!triangles) throw new Error('Tripo model has no skinned geometry')
  const inverse = model.matrixWorld.clone().invert()
  const pos = (name: string): THREE.Vector3 => {
    const bone = bones.get(name)
    if (!bone) throw new Error(`Tripo rig has no ${name} socket joint`)
    return bone.getWorldPosition(new THREE.Vector3()).applyMatrix4(inverse)
  }
  for (const name of ['idle', 'walk', 'run', 'castEnter', 'castLoop', 'castShoot', 'castExit', 'throw', 'slam', 'death', 'knockback', 'hit', 'hitHead']) {
    if (!gltf.animations.some(clip => clip.name === name)) throw new Error(`Tripo rig has no ${name} animation`)
  }
  const hand = pos('hand_l'), middle = pos('middle_01_l')
  const fingers = middle.clone().sub(hand).normalize(), down = new THREE.Vector3(0, -1, 0)
  relaxWarlockFingers(model, gltf.animations)
  return {
    ...canonical,
    style: 'tripo', handScale: 1,
    template: model,
    ...prepareWarlockClips(gltf.animations),
    triangles,
    // Legacy head/back shapes were fitted to the other robe. They require their
    // own fitting pass; staffs already attach through measured hand sockets.
    outfit: () => null,
    rest: {
      height: 1.85,
      palmL: hand.clone().lerp(middle, .65),
      palmR: pos('hand_r').lerp(pos('middle_01_r'), .65),
      gripL: hand.clone().lerp(middle, .65).addScaledVector(down, .022),
      gripAxisL: pos('index_01_l').sub(pos('pinky_01_l')).normalize(),
      curlAxisL: fingers.clone().cross(down).normalize(),
      eyes: new THREE.Vector3(0, 1.675, .19),
    },
    createVisual(actor, gpu) {
      const simulation = new ClothProxy(proxy, actor, proxy.colliders)
      const face = attachPreviewFace(actor, gpu.team, gpu.phase)
      face.mesh.userData.wl = gpu
      const clothEnabled = uniform(1)
      const look = {
        enabled: uniform(1), albedo: uniform(1), tint: uniform(.35),
        highlights: uniform(.35), coat: uniform(.03), glow: uniform(.45), team: uniform(gpu.team), charge: U.castCharge.add(U.castFlare.mul(2)),
      }
      const materials: THREE.MeshPhysicalNodeMaterial[] = []
      const skeletons = new Set<THREE.Skeleton>()
      actor.traverse(o => {
        const mesh = o as THREE.SkinnedMesh
        if (!mesh.isSkinnedMesh) return
        skeletons.add(mesh.skeleton)
        attachClothMaterial(mesh, simulation, clothEnabled, (material, source) => {
          attachPlayerLook(material, source, look)
          const sourceColor = vec3(source.color.r, source.color.g, source.color.b)
          const color = material.colorNode ?? (source.map ? texture(source.map).rgb.mul(sourceColor) : sourceColor)
          const emissive = material.emissiveNode ?? vec3(0)
          applyFx(material, color as THREE.Node<'vec3'>, emissive as THREE.Node<'vec3'>, attribute('position', 'vec3').y)
          materials.push(material)
        })
      })
      // The opaque void must dissolve with the wearer, without the surface's
      // flash/fill brightening the black face. Its coordinates are model metres.
      const faceFx = new THREE.MeshStandardNodeMaterial()
      applyFx(faceFx, vec3(0), vec3(0), attribute('position', 'vec3').y, undefined, float(0))
      face.mesh.material.opacityNode = faceFx.opacityNode
      face.mesh.material.alphaTest = faceFx.alphaTest
      faceFx.dispose()
      const accessories = attachTripoAccessories(actor, gpu)
      const cape = attachTripoCape(actor, gpu, simulation)
      let accessoryKey = ''
      let lastFlash = 0
      return {
        update(dt) {
          cape.mesh.visible = warlockParams.tripoCape
          const key = `${warlockParams.tripoShoulders}|${warlockParams.tripoSigils}`
          if (key !== accessoryKey) {
            const sigils = warlockParams.tripoSigils
            accessories.setLoadout({ shoulders: warlockParams.tripoShoulders, hood: sigils, chest: sigils, belt: sigils, wrists: sigils })
            accessoryKey = key
          }
          // Pose and staff wrist corrections have finished before contacts run.
          actor.updateWorldMatrix(true, true)
          simulation.update(dt)
          cape.update(dt)
          face.setColor(gpu.team)
          if (gpu.flash > lastFlash) face.blink()
          lastFlash = gpu.flash
          face.update(dt)
        },
        reset() { simulation.reset(); cape.reset() },
        dispose() {
          cape.dispose()
          accessories.dispose()
          face.dispose()
          for (const material of materials) material.dispose()
          for (const skeleton of skeletons) skeleton.dispose()
        },
      }
    },
  }
}
