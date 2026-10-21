// Standalone authoring viewer. No game loader, store, inventory or catalog imports.
import * as THREE from 'three/webgpu'
import { Fn, If, attribute, clamp, cross, dot, exp, float, length, max, min, mix, normalLocal, pass, positionLocal, renderOutput, select, smoothstep, sqrt, texture, uniform, vec2, vec3, vec4 } from 'three/tsl'
import { ClothProxy, MAX_CLOTH_STEP, clothPrimaryFreedom } from './cloth-proxy.js'
import { REAR_CONTACT } from './cloth-leg-contact.js'
import { deformClothVertex } from './cloth-deformation.js'
import { attachPreviewFace } from './preview-face.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js'
import { ao } from 'three/addons/tsl/display/GTAONode.js'
import { fxaa } from 'three/addons/tsl/display/FXAANode.js'

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
let playing = true
let clothSeconds = 0
let lastFrame = performance.now()
let loading = false
let loadSerial = 0
const world = new THREE.Vector3()
const inverse = new THREE.Matrix4()

// GPU counterpart of clearRearCloth, using the same contact profile constants.
function clearRearClothNode(position,capsules,direction,weight) {
  const {edge,radius:padding,gap,layer,release}=REAR_CONTACT
  for(const {a,b,radius:bodyRadius} of capsules) {
    const axis=b.sub(a),offset=position.sub(a).toVar()
    const axisLength=dot(axis,axis),axisAlong=dot(axis,direction),offsetAlong=dot(offset,direction)
    const planeAxis=axis.sub(direction.mul(axisAlong)),planeOffset=offset.sub(direction.mul(offsetAlong))
    const t=clamp(dot(planeOffset,planeAxis).div(max(dot(planeAxis,planeAxis),1e-12)),0,1)
    const distance=length(planeOffset.sub(planeAxis.mul(t))),radius=bodyRadius+padding
    If(distance.lessThan(radius+edge),()=>{
      const support=float(1).sub(smoothstep(radius,radius+edge,distance))
      const far=t.mul(axisAlong).sub(offsetAlong).toVar()
      const axisOffset=dot(axis,offset),coefA=axisLength.sub(axisAlong.mul(axisAlong))
      const coefB=axisLength.mul(offsetAlong).sub(axisOffset.mul(axisAlong))
      const coefC=axisLength.mul(dot(offset,offset)).sub(axisOffset.mul(axisOffset)).sub(axisLength.mul(radius*radius))
      const discriminant=coefB.mul(coefB).sub(coefA.mul(coefC))
      If(coefA.greaterThan(axisLength.mul(1e-8)).and(discriminant.greaterThanEqual(0)),()=>{
        const root=coefB.negate().add(sqrt(discriminant)).div(coefA)
        const along=axisOffset.add(root.mul(axisAlong))
        If(along.greaterThanEqual(0).and(along.lessThanEqual(axisLength)),()=>far.assign(max(far,root)))
      })
      for(const center of [a,b]) {
        const relative=position.sub(center),along=dot(relative,direction)
        const discriminant=along.mul(along).sub(dot(relative,relative)).add(radius*radius)
        If(discriminant.greaterThanEqual(0),()=>far.assign(max(far,along.negate().add(sqrt(discriminant)))))
      }
      const correction=float(0).toVar()
      If(far.greaterThanEqual(0),()=>correction.assign(far.add(gap).add(float(layer).div(float(1).add(far.div(layer))))))
        .Else(()=>correction.assign(exp(far.div(release)).mul(gap+layer)))
      position.assign(position.add(direction.mul(correction.mul(support).mul(weight))))
    })
  }
}

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
  if(imported.name.startsWith('Tripo_Fabric')) {
    const albedo=texture(imported.map)
    const trim=smoothstep(.06,.20,albedo.r.sub(max(albedo.g,albedo.b)))
    material.roughnessNode=mix(.96,.75,trim)
    material.specularIntensityNode=mix(.17,.32,trim)
    material.sheen=.22;material.sheenColor.set('#342a3a');material.sheenRoughness=.9
  }
  material.side = THREE.DoubleSide
  const simulation = simulations[actors.indexOf(actor)]
  const legCloth=simulation.legCloth[0]
  const hemFrame=uniform(legCloth.hemFrame)
  const legCapsules=simulation.capsules.filter(cap=>cap.kind==='leg').map(cap=>({a:uniform(cap.a),b:uniform(cap.b),radius:cap.radius}))
  const limbs=legCloth.thighs.map(({cap,matrix,hangingMatrix,hip,knee,calfLength,rearCarry})=>({
    thigh:uniform(matrix),hanging:uniform(hangingMatrix),rearCarry:uniform(rearCarry),calfLength,hip:hip.y,knee:knee.y,hipX:hip.x,hipZ:hip.z,radius:cap.radius+.025
  }))
  material.positionNode = Fn(() => {
    const indices = attribute('_wl_proxy_indices', 'vec3')
    const weights = attribute('_wl_proxy_weights', 'vec3')
    const freedom = smoothstep(0, .12, attribute('_wl_proxy_freedom','float'))
    const primaryFreedom=attribute('_wl_proxy_primary','float')
    const skirt=attribute('_wl_proxy_skirt','float')
    const source=attribute('position','vec3')
    const sourceNormal=attribute('normal','vec3')
    const primaryLegs=limbs.map(({thigh,hanging,hip,knee,hipX,hipZ,radius,rearCarry,calfLength})=>{
      const upper=thigh.mul(vec4(source,1)).xyz
      const radialOffset=vec2(source.x.sub(hipX),source.z.sub(hipZ))
      const radial=min(1,float(radius).div(max(length(radialOffset),.000001)))
      const carriedRadial=radialOffset.mul(radial),freeRadial=radialOffset.mul(float(1).sub(radial))
      const lower=hanging.mul(vec4(float(hipX).add(carriedRadial.x),knee,float(hipZ).add(carriedRadial.y),1)).xyz
        .add(hemFrame.mul(vec4(freeRadial.x,0,freeRadial.y,0)).xyz).sub(vec3(0,float(knee).sub(source.y),0))
        .add(rearCarry.mul(float(1).sub(smoothstep(0,.08,source.z))).mul(clamp(float(knee).sub(source.y).div(calfLength),0,1)))
      const bend=float(1).sub(smoothstep(knee-.07,knee+.07,source.y))
      const attachment=float(1).sub(smoothstep(hip-.14,hip+.04,source.y))
      const position=mix(positionLocal,mix(upper,lower,bend),attachment)
      const limbNormal=mix(thigh.mul(vec4(sourceNormal,0)).xyz,hemFrame.mul(vec4(sourceNormal,0)).xyz,bend).normalize()
      return {position,normal:mix(normalLocal,limbNormal,attachment).normalize()}
    })
    const leftWeight=smoothstep(-.08,.08,source.x)
    const legPosition=mix(primaryLegs[1].position,primaryLegs[0].position,leftWeight)
    const legNormal=mix(primaryLegs[1].normal,primaryLegs[0].normal,leftWeight).normalize()
    const offset = simulation.offsetNode.element(indices.x.toUint()).mul(weights.x)
      .add(simulation.offsetNode.element(indices.y.toUint()).mul(weights.y))
      .add(simulation.offsetNode.element(indices.z.toUint()).mul(weights.z))
    const primary=simulation.primaryOffsetNode.element(indices.x.toUint()).mul(weights.x)
      .add(simulation.primaryOffsetNode.element(indices.y.toUint()).mul(weights.y))
      .add(simulation.primaryOffsetNode.element(indices.z.toUint()).mul(weights.z))
    const qa=simulation.rotationNode.element(indices.x.toUint())
    const qb=simulation.rotationNode.element(indices.y.toUint())
    const qc=simulation.rotationNode.element(indices.z.toUint())
    const q=qa.mul(weights.x)
      .add(qb.mul(weights.y).mul(select(dot(qa,qb).lessThan(0),-1,1)))
      .add(qc.mul(weights.z).mul(select(dot(qa,qc).lessThan(0),-1,1))).normalize()
    const rotated = normalLocal.add(cross(q.xyz,cross(q.xyz,normalLocal).add(normalLocal.mul(q.w))).mul(2))
    normalLocal.assign(mix(normalLocal,mix(rotated,legNormal,skirt),primaryFreedom.mul(clothEnabled)).normalize())
    const anchor = simulation.targetNode.element(indices.x.toUint()).mul(weights.x)
      .add(simulation.targetNode.element(indices.y.toUint()).mul(weights.y))
      .add(simulation.targetNode.element(indices.z.toUint()).mul(weights.z))
    const residual = positionLocal.sub(anchor)
    const rotatedResidual = residual.add(cross(q.xyz,cross(q.xyz,residual).add(residual.mul(q.w))).mul(2))
    const primaryDeformation=mix(primary.add(rotatedResidual.sub(residual)),legPosition.sub(positionLocal),skirt)
    const deformation=offset.sub(primary).mul(freedom).add(primaryDeformation.mul(primaryFreedom))
    const deformed=positionLocal.add(deformation.mul(clothEnabled)).toVar()
    If(skirt.mul(primaryFreedom).mul(clothEnabled).greaterThan(0),()=>{
      const conformed=deformed.toVar()
      for(const {a,b,radius} of legCapsules) {
        const axis=b.sub(a),t=clamp(dot(conformed.sub(a),axis).div(dot(axis,axis)),0,1)
        const nearest=a.add(axis.mul(t)),radial=conformed.sub(nearest).toVar(),distance=length(radial).toVar()
        const mapped=select(distance.lessThan(radius),float(radius+.003).add(distance.mul(.1)),distance.add(exp(distance.sub(radius).negate().div(.05)).mul(.003+.1*radius)))
        conformed.assign(nearest.add(radial.mul(mapped.div(distance))))
      }
      deformed.assign(mix(deformed,conformed,primaryFreedom.mul(clothEnabled)))
      const rearWeight=float(1).sub(smoothstep(0,.08,source.z))
        .mul(float(1).sub(smoothstep(limbs[0].knee,limbs[0].knee+REAR_CONTACT.heightBlend,source.y)))
        .mul(primaryFreedom)
      If(rearWeight.greaterThan(0),()=>clearRearClothNode(deformed,legCapsules,hemFrame.mul(vec4(0,0,-1,0)).xyz.normalize(),rearWeight))
    })
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
  model.traverse(obj => {
    if (!obj.isSkinnedMesh) return
    const geometry=obj.geometry
    const indices=geometry.getAttribute('_wl_proxy_indices'),weights=geometry.getAttribute('_wl_proxy_weights')
    const faces=geometry.getAttribute('_wl_proxy_face'),motion=geometry.getAttribute('_wl_cloth')
    if (!indices || !weights || !faces || !motion) throw new Error('Cloth bindings are missing')
    // WebGPU guarantees eight vertex buffers. Share one buffer for the four
    // proxy fields instead of spending a separate binding on every attribute.
    const values=new Float32Array(indices.count*10)
    for(let i=0;i<indices.count;i++) values.set([indices.getX(i),indices.getY(i),indices.getZ(i),weights.getX(i),weights.getY(i),weights.getZ(i),faces.getX(i),motion.getX(i),clothPrimaryFreedom(motion.getX(i),motion.getZ(i)),[1,2].includes(motion.getZ(i))?1:0],i*10)
    const buffer=new THREE.InterleavedBuffer(values,10)
    for(const [name,size,offset] of [['_wl_proxy_indices',3,0],['_wl_proxy_weights',3,3],['_wl_proxy_face',1,6],['_wl_proxy_freedom',1,7],['_wl_proxy_primary',1,8],['_wl_proxy_skirt',1,9]]) geometry.setAttribute(name,new THREE.InterleavedBufferAttribute(buffer,size,offset))
  })
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
  }
  physicsCost=performance.now()-start
}
function seek(time) {
  for(const action of actions) action.reset().play()
  for(const instance of mixers) instance.update(0)
  for(const simulation of simulations) simulation.reset()
  // Replay the contact history rather than placing cloth inside a posed leg.
  for(let t=0;t<time;t+=1/60) advance(Math.min(1/60,time-t))
  updateBindings()
}

$('clip').addEventListener('change', () => setClip($('clip').value))
$('restart').addEventListener('click',()=>{setClip($('clip').value);playing=true;$('play').textContent='Pause'})
$('play').addEventListener('click', () => { playing = !playing; $('play').textContent = playing ? 'Pause' : 'Play' })
$('timeline').addEventListener('input', () => {
  seek(Number($('timeline').value))
})
$('cloth').addEventListener('change',()=>{for(const simulation of simulations) simulation.reset()})
$('eyeColor').addEventListener('input',()=>{for(const face of faces) face.setColor($('eyeColor').value)})
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
      calls: renderer.info.render.drawCalls, bounds: [bounds.min.toArray(), bounds.max.toArray()] }
  },
}
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = Math.min((now - lastFrame) / 1000, 0.05)
  lastFrame = now
  if (model && !loading) {
    for(const face of faces)face.update(dt)
    if (playing) {
      const step = dt * Number($('speed').value)
      advance(step)
      clothSeconds += step
    }
    $('timeline').value = String(currentAction.time)
    updateBindings()
  }
  orbit.update()
  if($('ao').checked)aoPipeline.render()
  else renderer.render(scene, camera)
  if (model && !loading) {
    const triangles = meshes.reduce((sum, mesh) => sum + (mesh.visible ? mesh.geometry.index.count / 3 : 0), 0)
    $('stats').textContent = `${Math.round(triangles).toLocaleString()} triangles · ${meshes.filter((mesh) => mesh.visible).length} meshes\n${actors.length} character${actors.length === 1 ? '' : 's'} · ${renderer.info.render.drawCalls} scene draws\n${currentAction.time.toFixed(2)} / ${currentAction.getClip().duration.toFixed(2)} seconds\n${proxyData.positions.length} cloth points / character · ${physicsCost.toFixed(2)} ms animation + cloth`
  }
})
const response = await fetch(assetBase + 'cloth-proxy.json')
if (!response.ok) throw new Error('Cloth proxy data could not be loaded')
proxyData = await response.json()
capsuleDefinitions=proxyData.colliders
if(!capsuleDefinitions) throw new Error('Fitted body colliders are missing; rebuild the authoring proxy')
await loadAsset($('asset').value).catch(reportError)
