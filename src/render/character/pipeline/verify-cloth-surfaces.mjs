// Continuous authoring regression: requires the locally generated experiment.
// Texture decoding is deliberately excluded; the browser checks the materials.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { AnimationMixer, LoopOnce, Vector3, Box3, Ray } from 'three/webgpu'
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

import { deformClothVertex } from './cloth-deformation.js'
function deform(mesh,sim,enabled=true) {
 return {mesh,points:Array.from({length:mesh.geometry.attributes.position.count},(_,i)=>deformClothVertex(mesh,i,sim,new Vector3(),enabled))};
}
function cuts(parts){
 const triangles=[],edges=new Map(),key=p=>p.toArray().map(x=>Math.round(x*100000)).join(',');
 for(const {mesh,points}of parts){
  const index=mesh.geometry.index,a=mesh.geometry.attributes;
  for(let i=0;i<index.count;i+=3){
   const ids=[0,1,2].map(j=>index.getX(i+j)),vertices=ids.map(i=>points[i]);
   if(/Outer_Robe|Hip_Overlays|Hanging_Panel|Front_Tabard|Waist_Sash/.test(mesh.name)){

    triangles.push({vertices,box:new Box3().setFromPoints(vertices),part:mesh.name});
   }else if(mesh.name.includes('Upper'))for(let j=0;j<3;j++){
    const v=ids[j],w=ids[(j+1)%3];if(a._wl_cloth.getZ(v)!==4&&a._wl_cloth.getZ(w)!==4)continue;
    const pa=points[v],pb=points[w];
    const id=[key(pa),key(pb)].sort().join('|');
    edges.set(id,{a:pa,b:pb,free:Math.max(a._wl_cloth.getX(v),a._wl_cloth.getX(w)),indices:[v,w]});
   }
  }
 }
 // A local spatial grid only prunes disjoint AABBs. Keep the exact same ray /
 // triangle intersection and endpoint tolerances for the acceptance result.
 const grid=new Map(),cellSize=.12;
 function cells(box,visit) {
  for(let x=Math.floor(box.min.x/cellSize);x<=Math.floor(box.max.x/cellSize);x++)
   for(let y=Math.floor(box.min.y/cellSize);y<=Math.floor(box.max.y/cellSize);y++)
    for(let z=Math.floor(box.min.z/cellSize);z<=Math.floor(box.max.z/cellSize);z++)visit(x+','+y+','+z);
 }
 for(const triangle of triangles)cells(triangle.box,key=>{
  if(!grid.has(key))grid.set(key,[]);grid.get(key).push(triangle);
 });
 const intersections=[],direction=new Vector3(),hit=new Vector3(),ray=new Ray(),box=new Box3(),points=new Set();
 for(const edge of edges.values()){
  const length=direction.subVectors(edge.b,edge.a).length();if(length<1e-7)continue;
  direction.divideScalar(length);ray.set(edge.a,direction);box.setFromPoints([edge.a,edge.b]);
  const candidates=new Set();cells(box,key=>{for(const triangle of grid.get(key)??[])candidates.add(triangle)});
  for(const {vertices,box:target,part}of candidates){
   if(!box.intersectsBox(target))continue;
   const point=ray.intersectTriangle(...vertices,false,hit);if(!point)continue;
   const distance=point.distanceTo(edge.a);if(distance<.0001||distance>length-.0001)continue;
   const id=key(point);if(points.has(id))continue;points.add(id);
   intersections.push({point:point.toArray(),part,free:edge.free,indices:edge.indices});
  }
 }
 return{free:intersections.filter(i=>i.free>0).length,rigid:intersections.filter(i=>i.free===0).length,intersections};
}

// Sample actual deformed render geometry at 60 Hz through each source clip.
// This gate checks cuffs against the robe, not arbitrary cloth self-contact.
const proof=[];
for(const name of ['idle','walk','run','castEnter','castLoop','castShoot','castExit','throw','slam','hit','hitHead','knockback','death']){
 const gltf=await new GLTFLoader().parseAsync(buffer,''),actor=gltf.scene;actor.updateMatrixWorld(true);
 const sim=new ClothProxy(data,actor,data.colliders),mixer=new AnimationMixer(actor),clip=gltf.animations.find(c=>c.name===name),action=mixer.clipAction(clip).play();
 if(!['idle','walk','run','castLoop'].includes(name)){action.setLoop(LoopOnce,1);action.clampWhenFinished=true}
 mixer.update(0);sim.reset();const parts=[];actor.traverse(m=>{if(m.isSkinnedMesh)parts.push(m)});let worst=0,worstTime=0,total=0;
 const frames=Math.ceil(Math.min(3,clip.duration+1)*60);
 for(let frame=0;frame<=frames;frame++){
  if(frame){mixer.update(1/60);actor.updateMatrixWorld(true);sim.update(1/60)}

  const result=cuts(parts.map(mesh=>deform(mesh,sim)));total+=result.free;
  if(result.free>worst){worst=result.free;worstTime=frame/60}
 }
 proof.push({name,worst,worstTime,total});console.log(JSON.stringify(proof.at(-1)));
}
writeFileSync(join(directory,'cuff-surface-motion.json'),JSON.stringify(proof,null,2));
assert(proof.every(clip=>clip.worst===0),'Cuff edges cross the visible robe; see cuff-surface-motion.json');
