// Standalone authoring viewer. No game loader, store, inventory or catalog imports.
import * as THREE from 'three/webgpu'
import { float, mix, pass, renderOutput, uniform, vec4 } from 'three/tsl'
import { ClothProxy, MAX_CLOTH_STEP } from './cloth-proxy.js'
import { attachClothMaterial, prepareClothAttributes } from './cloth-material.js'
import { deformClothVertex } from './cloth-deformation.js'
import { createPlayerLookControls } from './preview-player-look.js'
import { WarlockGpu } from '../gpuState.ts'
import { attachTripoCape } from '../tripoCape.ts'
import { emblemIndex } from '../emblems.ts'
import { COSMETICS } from '../../../game/progressionCatalog.ts'
import { attachTripoAccessories } from '../tripoAccessories.ts'
import { attachPreviewFace } from './preview-face.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js'
import { ao } from 'three/addons/tsl/display/GTAONode.js'
import { fxaa } from 'three/addons/tsl/display/FXAANode.js'

const $ = (id) => document.getElementById(id)
const playerLook=createPlayerLookControls()
for(const item of COSMETICS)if(item.slot==='emblem')$('emblem').add(new Option(item.name,item.id))
$('emblem').value='emblem-moon'
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

// Match the game's depth-derived, half-resolution GTAO without importing its
// renderer or changing its quality settings. Off keeps the direct render path.
const aoScenePass=pass(scene,camera,{samples:0})
const aoEffect=ao(aoScenePass.getTextureNode('depth'),null,camera)
aoEffect.resolutionScale=.5
aoEffect.radius.value=.6
aoEffect.thickness.value=1
aoEffect.distanceExponent.value=1.5
const aoPipeline=new THREE.RenderPipeline(renderer)
// Schedule the producer nodes explicitly instead of relying on their output
// textures' metadata to keep the scene and occlusion renders in the graph.
const aoOutput=vec4(aoScenePass.rgb.mul(mix(float(1),aoEffect,.75)),aoScenePass.a)
if(renderer.getPixelRatio()<1.5) {
  aoPipeline.outputNode=fxaa(renderOutput(aoOutput))
  aoPipeline.outputColorTransform=false
} else aoPipeline.outputNode=aoOutput

let capsuleDefinitions

const clothEnabled = uniform(1)
let proxyData
let simulations = []
let physicsCost = 0

let model, mixer, skeletonHelper, currentAction, clips, meshes = [], bindings = [], markers = []
let actors = [], mixers = [], helpers = [], actions = []
let colliderViews = []
let faces=[]
let regalia=[],regaliaStates=[],capes=[]
let playing = true
let clothSeconds = 0
let lastFrame = performance.now()
let loading = false
let loadSerial = 0
const world = new THREE.Vector3()
const inverse = new THREE.Matrix4()


function setClip(name) {
  const clip = clips.find((clip) => clip.name === name)
  if (!clip) throw new Error('Unknown clip: ' + name)
  actions = mixers.map((instance) => {
    instance.stopAllAction()
    const action = instance.clipAction(clip)
    action.reset()
    const looping=['idle','walk','run','castLoop'].includes(name)
    action.setLoop(looping?THREE.LoopRepeat:THREE.LoopOnce,looping?Infinity:1)
    action.clampWhenFinished=!looping
    action.play()
    return action
  })
  currentAction = actions[0]
  if(['hit','hitHead'].includes(name))for(const face of faces)face.blink()
  clothSeconds = 0
  $('timeline').max = clip.duration
  $('timeline').value = '0'
  for (const instance of mixers) instance.update(0)
  for (const simulation of simulations) simulation.reset()
  for (const cape of capes) cape.reset()
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
    for(const cape of capes)cape.dispose()
    for(const ornament of regalia) ornament.dispose()
    for(const face of faces) face.dispose()
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
  prepareClothAttributes(model)
  colliderViews = capsuleDefinitions.filter(([, , , kind]) => kind === 'leg').map(([left, right, radius]) => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(104 * 3),3))
    const material = new THREE.LineBasicNodeMaterial({ color: left.endsWith('_l') ? 0xffdd44 : 0x44ccff, transparent:true, opacity:.85, depthTest:false,depthWrite:false })
    const group = new THREE.LineSegments(geometry,material)
    group.frustumCulled=false;group.renderOrder=1000
    group.visible = $('colliders').checked; scene.add(group)
    return {group,geometry,material,radius,leftName:left,rightName:right}
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
  faces=actors.map((actor,index)=>attachPreviewFace(actor,$('eyeColor').value,index))
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
      attachClothMaterial(obj, simulations[actors.indexOf(actor)], clothEnabled, (material, source) => playerLook.attach(material, source, actors.indexOf(actor)))
    })
  if (!meshes.length) throw new Error('The asset contains no skinned meshes.')
  regaliaStates=actors.map((_,i)=>{const state=new WarlockGpu();state.phase=i*.73;return state})
  regalia=actors.map((actor,i)=>attachTripoAccessories(actor,regaliaStates[i]))
  capes=actors.map((actor,i)=>attachTripoCape(actor,regaliaStates[i],simulations[i]))
  updateRegalia()
  updateCapes()
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

function updateCapes() {
  for(const cape of capes)cape.mesh.visible=$('cape').checked
  for(const state of regaliaStates)state.emblem=emblemIndex($('emblem').value||null)
}
for(const id of ['cape','emblem'])$(id).addEventListener('change',updateCapes)

function updateRegalia() {
  const sigils=$('sigils').checked
  for(const ornament of regalia)ornament.setLoadout({shoulders:$('regalia').value,hood:sigils,chest:sigils,belt:sigils,wrists:sigils})
}
for(const id of ['regalia','sigils'])$(id).addEventListener('change',updateRegalia)

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
  playerLook.refresh(faces)
}

function updateBindings() {
  for (const actor of actors) actor.updateMatrixWorld(true)
  const a = new THREE.Vector3(), b = new THREE.Vector3()
  if(!$('colliders').checked) return
  for (const view of colliderViews) {
    const cap=simulations[0].capsules.find(cap=>cap.left.name===view.leftName&&cap.right.name===view.rightName)
    a.copy(cap.a).applyMatrix4(model.matrixWorld);b.copy(cap.b).applyMatrix4(model.matrixWorld)
    view.group.position.copy(a).add(b).multiplyScalar(.5)
    world.copy(b).sub(a)
    const segmentLength=world.length()
    view.group.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),world.normalize())
    const points=view.geometry.attributes.position
    let index=0
    for(let plane=0;plane<2;plane++) for(let i=0;i<26;i++) for(const j of [i,(i+1)%26]) {
      const upper=j<13,angle=(upper ? j : j-13)/12*Math.PI+(upper ? 0 : Math.PI)
      const radial=view.radius*Math.cos(angle),y=(upper ? segmentLength/2 : -segmentLength/2)+view.radius*Math.sin(angle)
      points.setXYZ(index++,plane===0 ? radial : 0,y,plane===1 ? radial : 0)
    }
    points.needsUpdate=true
  }

}

function advance(seconds) {
  const start=performance.now()
  // Sample moving bones at physics frequency. Fast knees cannot jump across a
  // panel between two display frames, including during timeline review.
  const count=Math.max(1,Math.ceil(seconds/MAX_CLOTH_STEP))
  for(let step=0;step<count;step++) {
    for(const instance of mixers) instance.update(seconds/count)
    for(const actor of actors) actor.updateMatrixWorld(true)
    if($('cloth').checked) for(const simulation of simulations) simulation.update(seconds/count)
    clothSeconds += seconds/count
    for(let i=0;i<capes.length;i++) {
      const state=regaliaStates[i]
      const thighs=simulations[i].capsules.filter(cap=>cap.kind==='leg'&&cap.left.name.startsWith('thigh_'))
      const activity=THREE.MathUtils.clamp((Math.max(...thighs.map(cap=>Math.abs(cap.b.z-cap.a.z)))-.025)/.28,0,1)
      state.flutter=activity
      state.swayCape.set(Math.sin(clothSeconds*8+i)*activity*.025,0,-activity*.12)
      capes[i].update(seconds/count)
    }
  }
  physicsCost=performance.now()-start
}
function seek(time) {
  for(const action of actions) action.reset().play()
  for(const instance of mixers) instance.update(0)
  for(const simulation of simulations) simulation.reset()
  clothSeconds = 0
  for(const cape of capes) cape.reset()
  // Replay the contact history rather than placing cloth inside a posed leg.
  for(let t=0;t<time;t+=1/60) advance(Math.min(1/60,time-t))
  clothSeconds = time
  updateBindings()
}

$('clip').addEventListener('change', () => setClip($('clip').value))
$('restart').addEventListener('click',()=>{setClip($('clip').value);playing=true;$('play').textContent='Pause'})
$('play').addEventListener('click', () => { playing = !playing; $('play').textContent = playing ? 'Pause' : 'Play' })
$('timeline').addEventListener('input', () => {
  seek(Number($('timeline').value))
})
$('cloth').addEventListener('change',()=>{for(const simulation of simulations) simulation.reset()})
$('eyeColor').addEventListener('input',()=>playerLook.refresh(faces))
for (const id of ['cloth', 'wire', 'albedo', 'normals', 'bones', 'colliders', 'markers', 'outer']) $(id).addEventListener('change', applyVisibility)
for(const id of ['playerLook','playerCustom','playerTint','playerHighlights','playerCoat','playerGlow','playerEyes'])$(id).addEventListener('input',()=>{
  playerLook.refresh(faces)
  if(id==='playerLook'&&$('playerLook').value==='palette'&&$('count').value!=='10') {
    $('count').value='10'
    loadAsset($('asset').value).catch(reportError)
  }
})
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
  view(position,target) {camera.position.fromArray(position);orbit.target.fromArray(target);orbit.update()},
  isolate(name=null) {
    if(name!==null&&!meshes.some(mesh=>mesh.name===name))throw new Error('Unknown review part: '+name)
    for(const mesh of meshes)mesh.visible=name===null||mesh.name===name
  },
  parts() {return meshes.map(mesh=>mesh.name)},
  surfaceAudit() {
    const p=new THREE.Vector3()
    return meshes.filter(mesh=>mesh.parent && mesh.skeleton===meshes[0].skeleton).map(mesh=>{
      const simulation=simulations[0],attributes=mesh.geometry.attributes
      let minY=Infinity,maxDisplacement=0,penetrations=0,maxDepth=0
      for(let i=0;i<attributes.position.count;i++) {
        if(attributes._wl_cloth.getX(i)<=0) continue
        p.fromBufferAttribute(attributes.position,i);mesh.applyBoneTransform(i,p)
        const original=p.clone()
        deformClothVertex(mesh,i,simulation,p)
        maxDisplacement=Math.max(maxDisplacement,p.distanceTo(original));minY=Math.min(minY,p.y)
        for(const cap of simulation.capsules) {
          const sleeve=attributes._wl_cloth.getZ(i)===4
          if(cap.kind==='arm' && (!sleeve || cap.left.name.endsWith('_l')!==(attributes.position.getX(i)>0))) continue
          const segment=new THREE.Vector3().subVectors(cap.b,cap.a)
          const t=Math.max(0,Math.min(1,new THREE.Vector3().subVectors(p,cap.a).dot(segment)/segment.lengthSq()))
          const nearest=cap.a.clone().addScaledVector(segment,t),depth=cap.radius-p.distanceTo(nearest)
          if(depth>.003){penetrations++;maxDepth=Math.max(maxDepth,depth)}
        }
      }
      return {mesh:mesh.name,minY,maxDisplacement,penetrations,maxDepth}
    })
  },
  colliderAudit() {
    const p = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), delta = new THREE.Vector3(), nearest = new THREE.Vector3()
    const measurements = []
    for (const cap of simulations[0].capsules) {
      if (cap.kind !== 'leg') continue
      const left=cap.left.name,right=cap.right.name,radius=cap.radius
      a.copy(cap.a).applyMatrix4(model.matrixWorld);b.copy(cap.b).applyMatrix4(model.matrixWorld)
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
  timing() { return {cpuMs:physicsCost,simulationMs:simulations.reduce((sum,s)=>sum+s.lastCost,0),actors:simulations.length,time:currentAction.time} },
  physics(details=false) { return { cpuMs:physicsCost, actors:simulations.map(s=>s.inspect(details)) } },
  inspect() {
    for (const mesh of meshes) mesh.computeBoundingBox()
    const bounds = new THREE.Box3().setFromObject(model)
    return { clips: clips.map((clip) => clip.name), triangles: meshes.reduce((sum, mesh) => sum + mesh.geometry.index.count / 3, 0),
      meshes: meshes.length, actors: actors.length, cloth: clothEnabled.value, bones: meshes[0].skeleton.bones.length, currentTime: currentAction.time,
      capeTriangles: capes.reduce((sum,c)=>sum+(c.mesh.visible?c.mesh.geometry.index.count/3:0),0),
      capePhysics: capes.map(c=>c.inspect()),
      accessoryTriangles: regalia.reduce((sum,r)=>sum+(r.mesh.visible?r.mesh.geometry.attributes.position.count/3:0),0),
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
    }
    for(let i=0;i<faces.length;i++) {
      faces[i].update(dt)
      const state=regaliaStates[i]
      state.team.set(playerLook.color(i))
    }
    $('timeline').value = String(currentAction.time)
    updateBindings()
  }
  orbit.update()
  if($('ao').checked)aoPipeline.render()
  else renderer.render(scene, camera)
  if (model && !loading) {
    const triangles = meshes.reduce((sum, mesh) => sum + (mesh.visible ? mesh.geometry.index.count / 3 : 0), 0)
    const accessoryTriangles=regalia.reduce((sum,r)=>sum+(r.mesh.visible?r.mesh.geometry.attributes.position.count/3:0),0)
    const capeTriangles=capes.reduce((sum,c)=>sum+(c.mesh.visible?c.mesh.geometry.index.count/3:0),0)
    $('stats').textContent = `${Math.round(triangles).toLocaleString()} garment + ${Math.round(accessoryTriangles).toLocaleString()} ornament + ${capeTriangles} cape triangles · ${meshes.filter((mesh) => mesh.visible).length} meshes\n${actors.length} character${actors.length === 1 ? '' : 's'} · ${renderer.info.render.drawCalls} scene draws\n${currentAction.time.toFixed(2)} / ${currentAction.getClip().duration.toFixed(2)} seconds\n${proxyData.positions.length} cloth points / character · ${physicsCost.toFixed(2)} ms animation + cloth`
  }
})
const response = await fetch(assetBase + 'cloth-proxy.json')
if (!response.ok) throw new Error('Cloth proxy data could not be loaded')
proxyData = await response.json()
capsuleDefinitions=proxyData.colliders
if(!capsuleDefinitions) throw new Error('Fitted body colliders are missing; rebuild the authoring proxy')
await loadAsset($('asset').value).catch(reportError)
