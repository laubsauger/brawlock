// Independent inspection of exported GLB data, rather than Blender scene state.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { Matrix4, Quaternion, Vector3, Ray, Triangle } from 'three'

const directory = resolve(process.argv[2] ?? 'art/source/tripo-warlock-v1')
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const preparation = JSON.parse(readFileSync(join(directory, 'preparation.json'), 'utf8'))
const rigging = JSON.parse(readFileSync(join(directory, 'rigging.json'), 'utf8'))
const bakeRecords = process.argv.includes('--include-bake-studies') ? JSON.parse(readFileSync(join(directory, 'lods.json'), 'utf8')).lods : []
const rearCut=JSON.parse(readFileSync(join(directory,'rear-cut.json'),'utf8'))
assert.equal(rearCut.removedTriangles,53,'Rear opening selection changed')
assert.equal(rearCut.workingTriangles,20077-rearCut.removedTriangles)
assert.equal(rearCut.removedFaceIds.length,53)
assert.equal(new Set(rearCut.removedFaceIds).size,53)
assert(rearCut.removedBounds[0][0]>=-.09&&rearCut.removedBounds[0][1]<=.09&&rearCut.removedBounds[2][1]<=.34,'Rear cut escaped the small central tip')
assert.equal(rearCut.retainedOuterTriangles,rearCut.sourceOuterTriangles-rearCut.removedTriangles)
assert.match(rearCut.retainedGeometryHash,/^[0-9a-f]{64}$/)
const waistFit=JSON.parse(readFileSync(join(directory,'waist-fit.json'),'utf8'))
const proxy = JSON.parse(readFileSync(join(directory, 'cloth-proxy.json'), 'utf8'))
assert.deepEqual(proxy.rearVent,{version:1,seamEdges:40,top:1.13},'Rebuild matching rear-vent meshes and proxy data')
assert.deepEqual(waistFit.profile,{start:.55,end:1,gap:.008,skinStart:1.05,skinEnd:1.15,binding:'torso'})
assert.deepEqual(proxy.waistFit,{...waistFit.profile,panels:waistFit.panels.map(({name,shift})=>({name,shift}))})
assert.equal(waistFit.panels.length,3)
assert(waistFit.panels.every(({name,shift,samples,bound})=>bound>0&&(name==='Tripo_Front_Tabard'?shift===0:shift>0&&shift<.03&&samples>0)))
const sourceLods=JSON.parse(readFileSync(join(directory,'source-lods.json'),'utf8'))
assert(proxy.positions.length <= 512)
assert(proxy.garments.every(garment=>garment.pinned>0),'Every garment needs an attachment band')
for(const field of ['contact','drape']) {
  assert.equal(proxy[field].length,proxy.positions.length)
  assert(proxy[field].every(v=>v.length===3&&v.every(Number.isFinite)))
}
assert.equal(proxy.clearance.length,proxy.positions.length)
assert(proxy.clearance.every(gap=>Number.isFinite(gap)&&gap>=0&&gap<.15))
assert(Array.isArray(proxy.legCloth)&&proxy.legCloth.length>0)
const clothNodes=new Set()
for(const {name,nodes,padding,motion} of proxy.legCloth) {
  assert.equal(motion,({'Tripo_Front_Tabard':1,'Tripo_Hip_Overlays':2})[name]??0,'Garment motion profile is required')
  const garment=proxy.garments.find(garment=>garment.name===name)
  assert(garment&&padding>0&&padding<.03)
  assert.equal(nodes.length,garment.count)
  for(const node of nodes) {
    assert(Number.isInteger(node)&&node>=garment.start&&node<garment.start+garment.count&&!clothNodes.has(node))
    clothNodes.add(node)
  }
}
assert(Array.isArray(proxy.layers))
for(const [i,a,b,c,u,v,w,side,gap] of proxy.layers) {
  assert([i,a,b,c].every(index=>Number.isInteger(index)&&index>0&&index<proxy.positions.length))
  assert([u,v,w].every(value=>Number.isFinite(value)&&value>=-1e-5&&value<=1.00001))
  assert(Math.abs(u+v+w-1)<1e-5&&Math.abs(side)===1&&gap>0&&gap<=.015)
}
assert(Array.isArray(proxy.sleeves)&&proxy.sleeves.length>0)
for(const [i,left,right,along,drop,across,radius] of proxy.sleeves) {
  assert(Number.isInteger(i)&&i>0&&i<proxy.positions.length)
  assert(typeof left==='string'&&typeof right==='string')
  assert(along>=0&&along<=1&&[drop,across].every(Number.isFinite)&&radius>0&&radius<.1)
}
assert(Array.isArray(proxy.garmentEnvelopes)&&proxy.garmentEnvelopes.length>0,'Clothing clearance envelopes are required')
for(const envelope of proxy.garmentEnvelopes) {
  assert(typeof envelope.joint==='string'&&envelope.planes.length===26)
  assert(envelope.restWitnesses.length===envelope.planes.length)
  assert(envelope.center.length===3&&envelope.center.every(Number.isFinite))
  for(const [x,y,z,d]of envelope.planes)assert(new Vector3(...envelope.center).dot(new Vector3(x,y,z))<d,'Envelope center must be strictly inside')
  assert(envelope.gap>0&&envelope.gap<.05)
  for(const [x,y,z,constant]of envelope.planes) {
    assert([x,y,z,constant].every(Number.isFinite))
    assert(Math.abs(Math.hypot(x,y,z)-1)<1e-6,'Envelope normals must have unit length')
  }
}
assert(proxy.colliders.length===11)
assert(Array.isArray(proxy.colliderRest),'Rebuild cloth data with exported collision reference points')
assert.equal(proxy.colliderRest.length,proxy.colliders.length)
for(const [left,right,radius,kind,a,b,driverA,driverB] of proxy.colliders) {
  assert(typeof left==='string'&&typeof right==='string')
  assert.deepEqual([driverA,driverB],left.startsWith('thigh_')?['pelvis',left]:[left,right],'Invalid collision endpoint attachments')
  assert(['leg','arm','body'].includes(kind)&&radius>.01&&radius<.25)
  assert(a.length===3&&b.length===3&&[...a,...b].every(Number.isFinite))
}
assert.equal(hash('public/models/warlock/warlock.glb'), preparation.shipped_asset_sha256)
for (const item of preparation.originals) assert.equal(hash(join(directory, 'originals', item.file)), item.sha256)

function load(name) {
  const bytes = readFileSync(join(directory, name))
  assert.equal(bytes.readUInt32LE(0), 0x46546c67)
  assert.equal(bytes.readUInt32LE(4), 2)
  assert.equal(bytes.readUInt32LE(8), bytes.length)
  const jsonLength = bytes.readUInt32LE(12)
  const doc = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength))
  const binAt = 20 + jsonLength
  assert.equal(bytes.readUInt32LE(binAt + 4), 0x004e4942)
  const binary = bytes.subarray(binAt + 8)
  function accessor(index) {
    const a = doc.accessors[index]
    assert(!a.sparse, 'Unexpected sparse accessor in this pipeline')
    const sizes = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }
    const methods = { 5120: ['getInt8', 1], 5121: ['getUint8', 1], 5122: ['getInt16', 2],
      5123: ['getUint16', 2], 5125: ['getUint32', 4], 5126: ['getFloat32', 4] }
    const [method, size] = methods[a.componentType]
    const width = sizes[a.type]
    const buffer = doc.bufferViews[a.bufferView]
    const stride = buffer.byteStride ?? width * size
    const start = (buffer.byteOffset ?? 0) + (a.byteOffset ?? 0)
    const view = new DataView(binary.buffer, binary.byteOffset, binary.length)
    const result = []
    for (let i = 0; i < a.count; i++) {
      const value = []
      for (let j = 0; j < width; j++) {
        let number = view[method](start + i * stride + j * size, true)
        if (a.normalized) {
          assert([5121, 5123].includes(a.componentType), 'Unexpected normalized component type')
          number /= a.componentType === 5121 ? 255 : 65535
        }
        assert(Number.isFinite(number), 'Non-finite accessor value')
        value.push(number)
      }
      result.push(value)
    }
    return result
  }
  return { bytes, doc, binary, accessor }
}

function imageSize(data, mime) {
  if (mime === 'image/png') return [data.readUInt32BE(16), data.readUInt32BE(20)]
  assert.equal(mime, 'image/jpeg')
  let offset = 2
  while (offset < data.length) {
    assert.equal(data[offset], 0xff)
    const marker = data[offset + 1]
    offset += 2
    if ([0xc0, 0xc1, 0xc2].includes(marker)) return [data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3)]
    offset += data.readUInt16BE(offset)
  }
  throw new Error('JPEG dimensions missing')
}

// Independently verify the exported rest fit and fully bound waist roots.
// Rays and bone names come from the actual GLB, after Blender's export.
function verifyWaist(doc,accessor) {
  const part=name=>{
    const node=doc.nodes.find(node=>node.name===name);assert(node&&node.mesh!==undefined,'Missing waist mesh: '+name)
    const primitive=doc.meshes[node.mesh].primitives[0],a=primitive.attributes
    return{positions:accessor(a.POSITION).map(p=>new Vector3(...p)),weights:accessor(a.WEIGHTS_0),joints:accessor(a.JOINTS_0),
      indices:accessor(primitive.indices).flat(),bones:doc.skins[node.skin].joints.map(i=>doc.nodes[i].name)}
  }
  const body=part('Tripo_Trousers'),ray=new Ray(),hit=new Vector3(),nearest=new Vector3(),bary=new Vector3(),result=[]
  for(const {name} of waistFit.panels) {
    const panel=part(name);let matched=0,fitted=0
    assert(panel.weights.every((weights,i)=>weights.every((w,j)=>w<1e-7||!panel.bones[panel.joints[i][j]].startsWith('thigh_'))),'Belt-hung fabric must not bind to individual thighs: '+name)
    for(let i=0;i<panel.positions.length;i++) {
      const p=panel.positions[i]
      if(p.y<waistFit.profile.end)continue
      ray.origin.set(p.x,p.y,1);ray.direction.set(0,0,-1)
      let best=Infinity,face=null
      for(let j=0;j<body.indices.length;j+=3) {
        const ids=body.indices.slice(j,j+3),[a,b,c]=ids.map(i=>body.positions[i])
        if(!ray.intersectTriangle(a,b,c,false,hit))continue
        const distance=ray.origin.distanceToSquared(hit)
        if(distance<best){best=distance;nearest.copy(hit);face=ids}
      }
      if(!face)continue // No trousers at this height/width, above their opening.
      if(name!=='Tripo_Front_Tabard') {
        assert(p.z-nearest.z>=waistFit.profile.gap-1e-5,'Source waist fit lost its trouser clearance: '+name)
        fitted++
      }
      if(p.y<waistFit.profile.skinEnd)continue
      const [a,b,c]=face.map(i=>body.positions[i]);Triangle.getBarycoord(nearest,a,b,c,bary)
      const expected=new Map(),actual=new Map()
      face.forEach((vertex,k)=>body.weights[vertex].forEach((weight,j)=>{
        const name=body.bones[body.joints[vertex][j]]
        expected.set(name,(expected.get(name)??0)+weight*bary.getComponent(k))
      }))
      const selected=[...expected].filter(([name,weight])=>weight>1e-8&&!name.startsWith('thigh_')).sort((a,b)=>b[1]-a[1]).slice(0,4),total=selected.reduce((n,[,w])=>n+w,0)
      expected.clear();selected.forEach(([name,w])=>expected.set(name,w/total))
      panel.weights[i].forEach((weight,j)=>actual.set(panel.bones[panel.joints[i][j]],(actual.get(panel.bones[panel.joints[i][j]])??0)+weight))
      for(const bone of new Set([...expected.keys(),...actual.keys()]))assert(Math.abs((expected.get(bone)??0)-(actual.get(bone)??0))<2e-4,'Waist binding differs from its body surface: '+name+' '+bone)
      matched++
    }
    if(name!=='Tripo_Front_Tabard')assert(fitted>0&&matched>0,'No fitted waist roots inspected: '+name)
    result.push({name,fitted,matched})
  }
  return result
}

const proof = { status: 'passed', originalsUnchanged: true, shippedCharacterUnchanged: true, assets: [] }
for (const record of [{ file: 'tripo-rig-test.glb', triangles: rearCut.workingTriangles, meshes: 12 }, ...sourceLods, ...bakeRecords]) {
  const { bytes, doc, binary, accessor } = load(record.file)
  if(record.file==='tripo-rig-test.glb') {
    proof.waist=verifyWaist(doc,accessor)
    const node=doc.nodes.find(node=>node.name==='Tripo_Outer_Robe_Skirt')
    assert(node&&node.mesh!==undefined,'Missing rear panel')
    const primitive=doc.meshes[node.mesh].primitives[0],positions=accessor(primitive.attributes.POSITION),indices=accessor(primitive.indices).flat(),faces=[]
    for(let i=0;i<indices.length;i+=3)faces.push(indices.slice(i,i+3).map(index=>positions[index].map(x=>Math.floor(x*1e5+.5)).join(',')).sort().join('|'))
    assert.equal(faces.length,rearCut.retainedOuterTriangles,'Rear panel has extra deleted triangles')
    assert.equal(createHash('sha256').update(faces.sort().join('\n')).digest('hex'),rearCut.retainedGeometryHash,'Export changed fabric outside the reviewed rear-tip cut')
    proof.rearCut={removedTriangles:rearCut.removedTriangles,preservedTriangles:faces.length,preservedGeometry:true}
  }
  // Prove authoring-space endpoints survived the actual Blender/glTF export.
  // Joint-local offsets are not world-space Y-up vectors.
  const worlds=new Map()
  function worldMatrices(index,parent) {
    const node=doc.nodes[index]
    const local=node.matrix ? new Matrix4().fromArray(node.matrix) : new Matrix4().compose(
      new Vector3(...(node.translation??[0,0,0])),new Quaternion(...(node.rotation??[0,0,0,1])),new Vector3(...(node.scale??[1,1,1])))
    const world=new Matrix4().multiplyMatrices(parent,local);worlds.set(index,world)
    for(const child of node.children??[])worldMatrices(child,world)
  }
  for(const root of doc.scenes[doc.scene??0].nodes)worldMatrices(root,new Matrix4())
  for(let i=0;i<proxy.colliders.length;i++) {
    const [,,,,a,b,driverA,driverB]=proxy.colliders[i]
    for(const [name,offset,expected] of [[driverA,a,proxy.colliderRest[i][0]],[driverB,b,proxy.colliderRest[i][1]]]) {
      const index=doc.nodes.findIndex(node=>node.name===name)
      assert(index>=0&&worlds.has(index),'Missing exported collision joint '+name)
      const actual=new Vector3(...offset).applyMatrix4(worlds.get(index))
      assert(actual.distanceTo(new Vector3(...expected))<1e-5,'Exported collision endpoint is misplaced: '+name)
    }
  }
  for(const envelope of proxy.garmentEnvelopes) {
    const joint=doc.nodes.findIndex(node=>node.name===envelope.joint)
    assert(joint>=0&&worlds.has(joint))
    const toLocal=worlds.get(joint).clone().invert()
    for(let i=0;i<envelope.planes.length;i++) {
      const [x,y,z,constant]=envelope.planes[i],normal=new Vector3(x,y,z)
      const witness=new Vector3(...envelope.restWitnesses[i]).applyMatrix4(toLocal)
      assert(Math.abs(witness.dot(normal)-constant)<1e-5,'Garment envelope moved on export')
      for(const [nx,ny,nz,d]of envelope.planes)assert(witness.dot(new Vector3(nx,ny,nz))<=d+1e-5,'Garment envelope does not contain its source samples')
    }
  }
  assert.equal(doc.skins.length, 1)
  const skin = doc.skins[0]
  assert.equal(skin.joints.length, 65)
  const names = skin.joints.map((index) => doc.nodes[index].name)
  for (const required of ['root', 'pelvis', 'Head', 'hand_l', 'hand_r', 'foot_l', 'foot_r']) assert(names.includes(required))
  assert.deepEqual(doc.animations.map((clip) => clip.name).sort(), [...rigging.clips].sort())
  assert.equal(doc.meshes.length, record.meshes)
  let triangles = 0, movableVertices = 0, centerVertices=0
  for (const mesh of doc.meshes) for (const primitive of mesh.primitives) {
    assert.equal(primitive.mode ?? 4, 4)
    const attributes = primitive.attributes
    for (const name of ['POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0', '_WL_CLOTH','_WL_PROXY_INDICES','_WL_PROXY_WEIGHTS','_WL_PROXY_FACE','_WL_REAR_SIDE','_WL_MOTION_PROFILE']) assert(name in attributes, 'Missing ' + name)
    const panels=accessor(attributes._WL_MOTION_PROFILE)
    assert(panels.every(([kind])=>[0,1,2].includes(kind)),'Garment motion profiles must remain discrete after reduction')
    centerVertices+=panels.filter(([flag])=>flag===1).length
    if(record.file==='tripo-rig-test.glb') {
      const node=doc.nodes.find(node=>node.mesh===doc.meshes.indexOf(mesh))
      assert(node,'Missing mesh node')
      assert(panels.every(([flag])=>flag===(({'Tripo_Front_Tabard':1,'Tripo_Hip_Overlays':2})[node.name]??0)),'Motion profile changed another garment')
    }
    const rearSides=accessor(attributes._WL_REAR_SIDE)
    assert(rearSides.every(([side])=>[-1,0,1].includes(side)),'Rear-tail sides must remain discrete after reduction')
    const proxyIndices=accessor(attributes._WL_PROXY_INDICES),proxyWeights=accessor(attributes._WL_PROXY_WEIGHTS),proxyFaces=accessor(attributes._WL_PROXY_FACE)
    for(let i=0;i<proxyIndices.length;i++) {
      assert(proxyIndices[i].every(index=>Number.isInteger(index)&&index>=0&&index<proxy.positions.length))
      assert(proxyWeights[i].every(w=>w>=0&&w<=1))
      assert(Math.abs(proxyWeights[i].reduce((a,b)=>a+b,0)-1)<1e-5)
      assert(Number.isInteger(proxyFaces[i][0])&&proxyFaces[i][0]>=0&&proxyFaces[i][0]<proxy.triangles.length)
    }
    const positions = accessor(attributes.POSITION)
    const indices = accessor(primitive.indices).flat()
    triangles += indices.length / 3
    assert(indices.every((index) => index >= 0 && index < positions.length))
    const weights = accessor(attributes.WEIGHTS_0)
    const joints = accessor(attributes.JOINTS_0)
    const cloth = accessor(attributes._WL_CLOTH)
    assert.equal(weights.length, positions.length)
    for (let i = 0; i < weights.length; i++) {
      assert(Math.abs(weights[i].reduce((sum, value) => sum + value, 0) - 1) < 0.0001, 'Unnormalized weights')
      assert(weights[i].every((value) => value >= 0 && value <= 1))
      assert(joints[i].every((index) => Number.isInteger(index) && index >= 0 && index < 65))
      // LOD collapse blends weights at the collar boundary. Check the upper
      // hood beyond that transition, where arm influence must be absent.
      if(positions[i][1]>1.65)for(let influence=0;influence<4;influence++) {
        const name=names[joints[i][influence]]
        if(/^(clavicle|upperarm|lowerarm)_/.test(name))assert(weights[i][influence]<1e-6,`Hood inherited an arm weight: ${record.file} Y=${positions[i][1]} ${name}=${weights[i][influence]}`)
      }
      if(cloth[i][2]===2&&cloth[i][0]>0) {
        assert(proxyIndices[i].every(index=>index>0&&proxy.region[index]===2),'Overlay bindings must remain on an overlay sheet')
      }
      assert(cloth[i][0] >= -0.0001 && cloth[i][0] <= 1.0001)
      assert(cloth[i][1] >= -0.0001 && cloth[i][1] < 2)
      assert(cloth[i][2] >= -0.0001 && cloth[i][2] <= 4.0001)
      if (cloth[i][0] > 0.05) movableVertices++
    }
  }
  assert.equal(triangles, record.triangles)
  assert(doc.nodes.filter(node=>node.mesh!==undefined).every(node=>node.extras.cloth_proxy_id===proxy.id),'Mesh and proxy build identifiers differ')
  assert(movableVertices > 50)
  assert(centerVertices>20,'Center flap lost its motion identity')
  for (const clip of doc.animations) for (const sampler of clip.samplers) {
    const times = accessor(sampler.input).flat()
    assert(times.length > 1 && times.every((time, i) => i === 0 || time >= times[i - 1]))
    accessor(sampler.output)
  }
  const images = doc.images.map((image) => {
    const view = doc.bufferViews[image.bufferView]
    return { name: image.name, size: imageSize(binary.subarray(view.byteOffset, view.byteOffset + view.byteLength), image.mimeType) }
  })
  if (record.texture_resolution) {
    assert.equal(images.length, 2)
    assert(images.every((image) => image.size.every((dimension) => dimension === record.texture_resolution)))
    assert(doc.materials.every((material) => material.normalTexture && material.pbrMetallicRoughness.baseColorTexture))
  }
  if(record.material) {
    assert.equal(images.length,1)
    assert.deepEqual(images[0].size,[4096,4096])
    assert(doc.materials.every(material=>!material.normalTexture),'Original-material LOD must not use the rejected ray bake')
  }
  proof.assets.push({ file: record.file, triangles, meshes: doc.meshes.length, bones: 65, clips: doc.animations.length,
    movableVertices, bytes: bytes.length, images })
}
writeFileSync(join(directory, 'export-validation.json'), JSON.stringify(proof, null, 2))
console.log(JSON.stringify(proof, null, 2))
