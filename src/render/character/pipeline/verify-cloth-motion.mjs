// Continuous authoring regression: requires the locally generated experiment.
// Texture decoding is deliberately excluded; the browser checks the materials.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { AnimationMixer, LoopOnce, Vector3 } from 'three/webgpu'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { ClothProxy } from './cloth-proxy.js'

const directory=resolve(process.argv[2]??'art/source/tripo-warlock-v1')
const data=JSON.parse(readFileSync(join(directory,'cloth-proxy.json')))
const source=readFileSync(join(directory,'tripo-rig-test.glb'))
const jsonLength=source.readUInt32LE(12)
const document=JSON.parse(source.toString('utf8',20,20+jsonLength))
delete document.images;delete document.textures;delete document.materials
for(const mesh of document.meshes)for(const primitive of mesh.primitives)delete primitive.material
const json=Buffer.from(JSON.stringify(document))
const padded=Buffer.alloc(Math.ceil(json.length/4)*4,0x20);json.copy(padded)
const binary=source.subarray(20+jsonLength)
const header=Buffer.alloc(20)
header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4)
header.writeUInt32LE(20+padded.length+binary.length,8)
header.writeUInt32LE(padded.length,12);header.writeUInt32LE(0x4e4f534a,16)
const bytes=Buffer.concat([header,padded,binary])
const buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)
const proof=[]
for(const name of ['walk','run','throw','death']) {
  const gltf=await new GLTFLoader().parseAsync(buffer,'')
  const actor=gltf.scene;actor.updateMatrixWorld(true)
  const simulation=new ClothProxy(data,actor,data.colliders)
  const mixer=new AnimationMixer(actor),clip=gltf.animations.find(clip=>clip.name===name)
  assert(clip,'Missing clip: '+name)
  const action=mixer.clipAction(clip).play()
  if(['throw','death'].includes(name)){action.setLoop(LoopOnce,1);action.clampWhenFinished=true}
  mixer.update(0);simulation.reset()
  let maxMotion=0,lateMotion=0,maxSecondary=0,flips=0,maxExcessMotion=0
  const before=simulation.position.map(p=>p.clone()),rotations=simulation.rotations.map(q=>q.clone())
  const solverTravel=new Vector3(),referenceTravel=new Vector3()
  const previousReference=simulation.references.map(p=>p.clone())
  const frames=Math.ceil((Math.max(5,clip.duration*3)+2)*60)
  for(let frame=0;frame<frames;frame++) {
    simulation.position.forEach((p,i)=>before[i].copy(p))
    simulation.rotations.forEach((q,i)=>rotations[i].copy(q))
    simulation.references.forEach((p,i)=>previousReference[i].copy(p))
    mixer.update(1/60);actor.updateMatrixWorld(true);simulation.update(1/60)
    for(let i=1;i<simulation.position.length;i++) {
      const p=simulation.position[i]
      assert(p.toArray().every(Number.isFinite),'Non-finite cloth: '+name)
      if(simulation.weights[i]===0)continue
      assert(p.y>=.045-1e-8,'Cloth crossed the floor: '+name)
      const motion=p.distanceTo(before[i])
      referenceTravel.subVectors(simulation.references[i],previousReference[i])
      const solverMotion=solverTravel.subVectors(p,before[i]).sub(referenceTravel).length()
      maxExcessMotion=Math.max(maxExcessMotion,solverMotion)
      maxMotion=Math.max(maxMotion,motion)
      if(frame>=frames-120)lateMotion=Math.max(lateMotion,motion)
      const secondary=new Vector3().fromArray(simulation.secondary,i*3).length()
      maxSecondary=Math.max(maxSecondary,secondary)
      assert(secondary<=.025+data.mobility[i]*.22+.002,'Secondary travel escaped its budget: '+name)
      const angle=2*Math.acos(Math.min(1,Math.abs(rotations[i].dot(simulation.rotations[i]))))
      if(angle>.5)flips++
    }
  }
  assert.equal(flips,0,'Cloth frame flipped during '+name)
  if(name==='walk') {
    assert(maxMotion<.035,'Walking cloth jumped more than 3.5 cm in one frame')
    assert(maxExcessMotion<.035,'Walking cloth jumped more than 3.5 cm beyond its attachment travel')
  }
  if(['throw','death'].includes(name))assert(lateMotion<1e-5,'Stopped cloth failed to settle: '+name)
  proof.push({name,frames,maxMotion,lateMotion,maxSecondary,flips,maxExcessMotion})
}
writeFileSync(join(directory,'continuous-cloth-motion.json'),JSON.stringify(proof,null,2))
console.log(JSON.stringify(proof,null,2))
