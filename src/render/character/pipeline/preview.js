// Standalone authoring viewer. No game loader, store, inventory or catalog imports.
import * as THREE from 'three/webgpu'
import { Fn, attribute, cross, max, mix, normalLocal, positionLocal, select, smoothstep, uniform, vec3 } from 'three/tsl'
import { ClothProxy } from './cloth-proxy.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js'

const $ = (id) => document.getElementById(id)
const assetBase = '/art/source/tripo-warlock-v1/'
const renderer = new THREE.WebGPURenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.4
document.body.append(renderer.domElement)
await renderer.init()
const scene = new THREE.Scene()
scene.background = new THREE.Color('#25262d')
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.05, 100)
camera.position.set(3.2, 2.2, 4.8)
const orbit = new OrbitControls(camera, renderer.domElement)
orbit.target.set(0, 0.9, 0)
orbit.enableDamping = true
scene.add(new THREE.HemisphereLight(0xdedcf5, 0x3b3033, 2.2))
for (const [position, color, intensity] of [[[3, 5, 4], 0xffe8d3, 3.5], [[-3, 2, 0], 0x9faee5, 2], [[0, 3, -4], 0xb88fc9, 3]]) {
  const light = new THREE.DirectionalLight(color, intensity)
  light.position.set(...position)
  scene.add(light)
}
const grid = new THREE.GridHelper(8, 32, 0x5b5468, 0x373640)
scene.add(grid)

const capsuleDefinitions = [
  ['thigh_l', 'calf_l', 0.125, 'leg'], ['calf_l', 'foot_l', 0.11, 'leg'], ['foot_l', 'ball_l', 0.13, 'leg'],
  ['thigh_r', 'calf_r', 0.125, 'leg'], ['calf_r', 'foot_r', 0.11, 'leg'], ['foot_r', 'ball_r', 0.13, 'leg'],
  ['upperarm_l', 'lowerarm_l', 0.065, 'arm'], ['lowerarm_l', 'hand_l', 0.06, 'arm'],
  ['upperarm_r', 'lowerarm_r', 0.065, 'arm'], ['lowerarm_r', 'hand_r', 0.06, 'arm'],
]
const clothEnabled = uniform(1)
let proxyData
let simulations = []
let physicsCost = 0

let model, mixer, skeletonHelper, currentAction, clips, meshes = [], bindings = [], markers = []
let actors = [], mixers = [], helpers = [], actions = []
let colliderViews = []
let playing = true
let clothSeconds = 0
let lastFrame = performance.now()
let loading = false
let loadSerial = 0
const world = new THREE.Vector3()
const inverse = new THREE.Matrix4()

function attachCloth(mesh, actor) {
  const imported = mesh.material
  const material = new THREE.MeshPhysicalNodeMaterial()
  material.color.copy(imported.color)
  material.map = imported.map
  mesh.userData.sourceMap = imported.map
  material.normalMap = imported.normalMap
  mesh.userData.bakedNormalMap = imported.normalMap
  material.roughness = imported.roughness
  material.metalness = imported.metalness
  material.specularIntensity = imported.specularIntensity ?? 1
  if (imported.specularColor) material.specularColor.copy(imported.specularColor)
  material.side = THREE.DoubleSide
  const simulation = simulations[actors.indexOf(actor)]
  material.positionNode = Fn(() => {
    const indices = attribute('_wl_proxy_indices', 'vec3')
    const weights = attribute('_wl_proxy_weights', 'vec3')
    const freedom = smoothstep(0, .12, attribute('_wl_proxy_freedom','float'))
    const offset = simulation.offsetNode.element(indices.x.toUint()).mul(weights.x)
      .add(simulation.offsetNode.element(indices.y.toUint()).mul(weights.y))
      .add(simulation.offsetNode.element(indices.z.toUint()).mul(weights.z))
    const q = simulation.rotationNode.element(indices.x.toUint()).mul(weights.x)
      .add(simulation.rotationNode.element(indices.y.toUint()).mul(weights.y))
      .add(simulation.rotationNode.element(indices.z.toUint()).mul(weights.z)).normalize()
    const rotated = normalLocal.add(cross(q.xyz,cross(q.xyz,normalLocal).add(normalLocal.mul(q.w))).mul(2))
    normalLocal.assign(mix(normalLocal,rotated,freedom).normalize())
    const anchor = simulation.targetNode.element(indices.x.toUint()).mul(weights.x)
      .add(simulation.targetNode.element(indices.y.toUint()).mul(weights.y))
      .add(simulation.targetNode.element(indices.z.toUint()).mul(weights.z))
    const residual = positionLocal.sub(anchor)
    const rotatedResidual = residual.add(cross(q.xyz,cross(q.xyz,residual).add(residual.mul(q.w))).mul(2))
    const deformed=mix(positionLocal,anchor.add(offset).add(rotatedResidual),freedom.mul(clothEnabled))
    // Fine hem details can extend below their coarse driver. Enforce the same
    // flat review floor on the final visible surface, including its tips.
    const aboveFloor=select(freedom.greaterThan(0),max(deformed.y,.012),deformed.y)
    return vec3(deformed.x,mix(deformed.y,aboveFloor,clothEnabled),deformed.z)
  })()
  mesh.userData.clothPosition = material.positionNode
  mesh.material = material

}

function setClip(name) {
  const clip = clips.find((clip) => clip.name === name)
  if (!clip) throw new Error('Unknown clip: ' + name)
  actions = mixers.map((instance) => {
    instance.stopAllAction()
    const action = instance.clipAction(clip)
    action.reset().play()
    return action
  })
  currentAction = actions[0]
  clothSeconds = 0
  $('timeline').max = clip.duration
  $('timeline').value = '0'
  for (const instance of mixers) instance.update(0)
  for (const simulation of simulations) simulation.reset()
}

async function loadAsset(file) {
  const serial = ++loadSerial
  loading = true
  $('error').textContent = ''
  window.reviewReady = false
  $('stats').textContent = 'Loading…'
  const gltf = await new GLTFLoader().loadAsync(assetBase + file)
  if (serial !== loadSerial) return
  if (model) {
    for (const view of colliderViews) { scene.remove(view.group); view.geometry.dispose(); view.material.dispose() }
    for (const actor of actors) scene.remove(actor)
    for (const helper of helpers) { scene.remove(helper); helper.dispose() }
    for (const instance of mixers) instance.stopAllAction()
    for (const geometry of new Set(meshes.map((mesh) => mesh.geometry))) geometry.dispose()
    for (const skeleton of new Set(meshes.map((mesh) => mesh.skeleton))) skeleton.dispose()
    for (const texture of new Set(meshes.flatMap((mesh) => [mesh.userData.sourceMap, mesh.userData.bakedNormalMap]).filter(Boolean))) texture.dispose()
    for (const mesh of meshes) mesh.material.dispose()
  }
  model = gltf.scene
  model.traverse(obj => {
    if (!obj.isSkinnedMesh) return
    const geometry=obj.geometry
    const indices=geometry.getAttribute('_wl_proxy_indices'),weights=geometry.getAttribute('_wl_proxy_weights')
    const faces=geometry.getAttribute('_wl_proxy_face'),motion=geometry.getAttribute('_wl_cloth')
    if (!indices || !weights || !faces || !motion) throw new Error('Cloth bindings are missing')
    // WebGPU guarantees eight vertex buffers. Share one buffer for the four
    // proxy fields instead of spending a separate binding on every attribute.
    const values=new Float32Array(indices.count*8)
    for(let i=0;i<indices.count;i++) values.set([indices.getX(i),indices.getY(i),indices.getZ(i),weights.getX(i),weights.getY(i),weights.getZ(i),faces.getX(i),motion.getX(i)],i*8)
    const buffer=new THREE.InterleavedBuffer(values,8)
    for(const [name,size,offset] of [['_wl_proxy_indices',3,0],['_wl_proxy_weights',3,3],['_wl_proxy_face',1,6],['_wl_proxy_freedom',1,7]]) geometry.setAttribute(name,new THREE.InterleavedBufferAttribute(buffer,size,offset))
  })
  colliderViews = capsuleDefinitions.filter(([, , , kind]) => kind === 'leg').map(([left, right, radius]) => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(26 * 3),3))
    const material = new THREE.LineBasicNodeMaterial({ color: left.endsWith('_l') ? 0xffdd44 : 0x44ccff, transparent:true, opacity:.38, depthTest:true })
    const group = new THREE.LineLoop(geometry,material)
    group.visible = $('colliders').checked; scene.add(group)
    return {group,geometry,material,radius,left:model.getObjectByName(left),right:model.getObjectByName(right)}
  })
  actors = [model]
  for (let i = 1; i < Number($('count').value); i++) actors.push(cloneSkeleton(model))
  for (let i = 0; i < actors.length; i++) {
    const actor = actors[i]
    if (actors.length > 1) actor.position.set((i % 4 - 1.5) * 1.7, 0, (Math.floor(i / 4) - 1) * 1.7)
    scene.add(actor)
    actor.updateMatrixWorld(true)
  }
  simulations = actors.map(actor => new ClothProxy(proxyData, actor, capsuleDefinitions))
  clips = gltf.animations
  if (clips.length !== 13) throw new Error('Expected all 13 original animation clips.')
  mixers = actors.map((actor) => new THREE.AnimationMixer(actor))
  mixer = mixers[0]
  meshes = []; bindings = []; markers = []
  for (const actor of actors) actor.traverse((obj) => {
      if (!obj.isSkinnedMesh) return
      if (!obj.geometry.hasAttribute('_wl_proxy_indices')) throw new Error('Cloth authoring attributes are missing.')
      if (obj.userData.cloth_proxy_id !== proxyData.id) throw new Error('Mesh and cloth proxy were built separately. Rebuild both, then reload this viewer.')
      meshes.push(obj)
      attachCloth(obj, actor)
    })
  if (!meshes.length) throw new Error('The asset contains no skinned meshes.')
  for (const side of ['l', 'r']) {
    const hand = model.getObjectByName('hand_' + side)
    const finger = model.getObjectByName('middle_01_' + side)
    if (!hand || !finger) throw new Error('Hand attachment joints are missing.')
    const midpoint = hand.getWorldPosition(new THREE.Vector3()).lerp(finger.getWorldPosition(new THREE.Vector3()), 0.6)
    const axes = new THREE.AxesHelper(0.14)
    hand.add(axes)
    axes.position.copy(hand.worldToLocal(midpoint))
    axes.visible = $('markers').checked
    markers.push(axes)
  }
  helpers = actors.map((actor) => {
    const helper = new THREE.SkeletonHelper(actor)
    helper.visible = $('bones').checked
    scene.add(helper)
    return helper
  })
  skeletonHelper = helpers[0]
  $('clip').replaceChildren(...clips.map((clip) => new Option(clip.name, clip.name)))
  $('clip').value = 'idle'
  setClip('idle')
  loading = false
  applyVisibility()
  setCamera($('camera').value)
  window.reviewReady = true
}

function applyVisibility() {
  for (const mesh of meshes) {
    mesh.material.wireframe = $('wire').checked
    const map=$('albedo').checked ? mesh.userData.sourceMap : null
    if(mesh.material.map!==map) {mesh.material.map=map;mesh.material.needsUpdate=true}
    const normal = $('normals').checked ? mesh.userData.bakedNormalMap : null
    if (mesh.material.normalMap !== normal) {
      mesh.material.normalMap = normal
      mesh.material.needsUpdate = true
    }
    const node = $('cloth').checked ? mesh.userData.clothPosition : null
    if (mesh.material.positionNode !== node) {
      mesh.material.positionNode = node
      mesh.material.needsUpdate = true
    }
    if (mesh.name.includes('Outer_Robe_Skirt')) mesh.visible = $('outer').checked
  }
  if (skeletonHelper) skeletonHelper.visible = $('bones').checked
  for (const helper of helpers) helper.visible = $('bones').checked
  for (const view of colliderViews) view.group.visible = $('colliders').checked
  for (const marker of markers) marker.visible = $('markers').checked
  clothEnabled.value = $('cloth').checked ? 1 : 0
  $('outer').disabled = !meshes.some((mesh) => mesh.name.includes('Outer_Robe_Skirt'))
  $('normals').disabled = !meshes.some(mesh=>mesh.userData.bakedNormalMap)
  $('normalLabel').textContent=$('normals').disabled ? 'Normal map · none in source' : 'Baked normal map'
}

function updateBindings() {
  for (const actor of actors) actor.updateMatrixWorld(true)
  const a = new THREE.Vector3(), b = new THREE.Vector3()
  for (const view of colliderViews) {
    view.left.getWorldPosition(a); view.right.getWorldPosition(b)
    view.group.position.copy(a).add(b).multiplyScalar(.5)
    world.copy(b).sub(a)
    const length = world.length()
    view.group.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),world.normalize())
    const points = view.geometry.attributes.position
    for (let i=0;i<26;i++) {
      const upper = i<13, angle=(upper ? i : i-13)/12*Math.PI + (upper ? 0 : Math.PI)
      points.setXYZ(i,view.radius*Math.cos(angle),(upper ? length/2 : -length/2)+view.radius*Math.sin(angle),0)
    }
    points.needsUpdate=true
  }
}

function advance(seconds) {
  const start=performance.now()
  // Sample moving bones at physics frequency. Fast knees cannot jump across a
  // panel between two display frames, including during timeline review.
  const count=Math.max(1,Math.ceil(seconds*60))
  for(let step=0;step<count;step++) {
    for(const instance of mixers) instance.update(seconds/count)
    for(const actor of actors) actor.updateMatrixWorld(true)
    if($('cloth').checked) for(const simulation of simulations) simulation.update(seconds/count)
  }
  physicsCost=performance.now()-start
}
function seek(time) {
  for(const action of actions) action.time=0
  for(const instance of mixers) instance.update(0)
  for(const simulation of simulations) simulation.reset()
  // Replay the contact history rather than placing cloth inside a posed leg.
  for(let t=0;t<time;t+=1/60) advance(Math.min(1/60,time-t))
  updateBindings()
}

$('clip').addEventListener('change', () => setClip($('clip').value))
$('play').addEventListener('click', () => { playing = !playing; $('play').textContent = playing ? 'Pause' : 'Play' })
$('timeline').addEventListener('input', () => {
  seek(Number($('timeline').value))
})
$('cloth').addEventListener('change',()=>{for(const simulation of simulations) simulation.reset()})
for (const id of ['cloth', 'wire', 'albedo', 'normals', 'bones', 'colliders', 'markers', 'outer']) $(id).addEventListener('change', applyVisibility)
$('asset').addEventListener('change', () => loadAsset($('asset').value).catch(reportError))
$('count').addEventListener('change', () => loadAsset($('asset').value).catch(reportError))
$('camera').addEventListener('change', () => setCamera($('camera').value))
function setCamera(name) {
  const presets = { threequarter: [2.5, 1.8, 3.8], front: [0, 1.3, 3.8], rear: [0, 1.3, -3.8], side: [3.8, 1.3, 0], arena: [2.6, 4.2, 3.2] }
  camera.position.set(...presets[name])
  if (actors.length > 1) camera.position.multiplyScalar(2.4)
  orbit.target.set(0, 0.9, 0)
  orbit.update()
}
window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})
function reportError(error) { $('error').textContent = error.message; console.error(error) }
window.review = {
  surfaceAudit() {
    const p=new THREE.Vector3(),anchor=new THREE.Vector3(),offset=new THREE.Vector3(),q=new THREE.Quaternion(),r=new THREE.Vector4(),sample=new THREE.Vector4()
    return meshes.filter(mesh=>mesh.parent && mesh.skeleton===meshes[0].skeleton).map(mesh=>{
      const simulation=simulations[0],attributes=mesh.geometry.attributes
      let minY=Infinity,maxDisplacement=0
      for(let i=0;i<attributes.position.count;i++) {
        if(attributes._wl_cloth.getX(i)<=0) continue
        p.fromBufferAttribute(attributes.position,i);mesh.applyBoneTransform(i,p)
        const original=p.clone()
        anchor.set(0,0,0);offset.set(0,0,0);r.set(0,0,0,0)
        for(let axis=0;axis<3;axis++) {
          const index=attributes._wl_proxy_indices.getComponent(i,axis),weight=attributes._wl_proxy_weights.getComponent(i,axis)
          anchor.addScaledVector(simulation.targets[index],weight);offset.addScaledVector(simulation.offsets[index],weight)
          sample.copy(simulation.rotations[index]).multiplyScalar(weight);r.add(sample)
        }
        r.normalize();q.set(r.x,r.y,r.z,r.w)
        p.sub(anchor).applyQuaternion(q).add(anchor).add(offset)
        const t=Math.min(1,attributes._wl_cloth.getX(i)/.12),freedom=t*t*(3-2*t)
        p.lerp(original,1-freedom)
        if(freedom>0) p.y=Math.max(.012,p.y)
        maxDisplacement=Math.max(maxDisplacement,p.distanceTo(original));minY=Math.min(minY,p.y)
      }
      return {mesh:mesh.name,minY,maxDisplacement}
    })
  },
  colliderAudit() {
    const p = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), delta = new THREE.Vector3(), nearest = new THREE.Vector3()
    const measurements = []
    for (const [left, right, radius, kind] of capsuleDefinitions) {
      if (kind !== 'leg') continue
      model.getObjectByName(left).getWorldPosition(a); model.getObjectByName(right).getWorldPosition(b)
      delta.copy(b).sub(a)
      const distances = []
      for (const mesh of meshes.filter((mesh) => mesh.name.includes('Trousers') || mesh.name.includes('Boot_'))) {
        const position = mesh.geometry.attributes.position
        for (let i = 0; i < position.count; i++) {
          p.fromBufferAttribute(position, i); mesh.applyBoneTransform(i, p); p.applyMatrix4(mesh.matrixWorld)
          const t = p.clone().sub(a).dot(delta) / delta.lengthSq()
          if (t < 0.15 || t > 0.85) continue
          nearest.copy(a).addScaledVector(delta, t)
          const distance = p.distanceTo(nearest)
          if (distance < 0.25) distances.push(distance)
        }
      }
      distances.sort((a,b) => a-b)
      measurements.push({left,right,radius,a:a.toArray(),b:b.toArray(),samples:distances.length,p95:distances[Math.floor(distances.length*.95)]})
    }
    return measurements
  },
  setClip(name, time = 0) {
    $('clip').value = name; setClip(name)
    seek(time)
    playing = false; $('play').textContent = 'Play'
  },
  physics() { return { cpuMs:physicsCost, actors:simulations.map(s=>s.inspect()) } },
  inspect() {
    for (const mesh of meshes) mesh.computeBoundingBox()
    const bounds = new THREE.Box3().setFromObject(model)
    return { clips: clips.map((clip) => clip.name), triangles: meshes.reduce((sum, mesh) => sum + mesh.geometry.index.count / 3, 0),
      meshes: meshes.length, actors: actors.length, cloth: clothEnabled.value, bones: meshes[0].skeleton.bones.length, currentTime: currentAction.time,
      calls: renderer.info.render.drawCalls, bounds: [bounds.min.toArray(), bounds.max.toArray()] }
  },
}
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = Math.min((now - lastFrame) / 1000, 0.05)
  lastFrame = now
  if (model && !loading) {
    if (playing) {
      const step = dt * Number($('speed').value)
      advance(step)
      clothSeconds += step
    }
    $('timeline').value = String(currentAction.time)
    updateBindings()
  }
  orbit.update()
  renderer.render(scene, camera)
  if (model && !loading) {
    const triangles = meshes.reduce((sum, mesh) => sum + (mesh.visible ? mesh.geometry.index.count / 3 : 0), 0)
    $('stats').textContent = `${Math.round(triangles).toLocaleString()} triangles · ${meshes.filter((mesh) => mesh.visible).length} meshes\n${actors.length} character${actors.length === 1 ? '' : 's'} · ${renderer.info.render.drawCalls} scene draws\n${currentAction.time.toFixed(2)} / ${currentAction.getClip().duration.toFixed(2)} seconds\n${proxyData.positions.length} cloth points / character · ${physicsCost.toFixed(2)} ms animation + cloth`
  }
})
const response = await fetch(assetBase + 'cloth-proxy.json')
if (!response.ok) throw new Error('Cloth proxy data could not be loaded')
proxyData = await response.json()
await loadAsset($('asset').value).catch(reportError)
