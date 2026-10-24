// Actual working-mesh garment diagnostic. Requires locally generated artifacts.
// Samples every 60 Hz frame over three walk/run loops, including cold start
// and sustained motion. Passing is necessary, not
// sufficient: edge intersections do not detect every possible surface contact.
// Texture decoding is deliberately excluded; the browser checks the materials.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { AnimationMixer, Vector3, Box3, Ray } from 'three/webgpu'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { ClothProxy } from './cloth-proxy.js'

const directory=resolve(process.argv[2]??'art/source/tripo-warlock-v1')
const CYCLES=3
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
function deform(mesh,sim) {
 const points=Array.from({length:mesh.geometry.attributes.position.count},(_,i)=>deformClothVertex(mesh,i,sim,new Vector3()));
 assert(points.every(p=>p.toArray().every(Number.isFinite)),'Non-finite visible mesh: '+mesh.name);
 return {mesh,points};
}
function cuts(parts){
 const triangles=[],edges=new Map(),key=p=>p.toArray().map(x=>Math.round(x*100000)).join(',');
 for(const {mesh,points}of parts){
  const index=mesh.geometry.index,a=mesh.geometry.attributes;
  for(let i=0;i<index.count;i+=3){
   const ids=[0,1,2].map(j=>index.getX(i+j)),vertices=ids.map(i=>points[i]);
   if(/Trousers|Boot_/.test(mesh.name)){
    triangles.push({vertices,indices:ids,box:new Box3().setFromPoints(vertices),part:mesh.name});
   }else if(/Outer_Robe|Hip_Overlays|Hanging_Panel|Front_Tabard/.test(mesh.name))for(let j=0;j<3;j++){
    const v=ids[j],w=ids[(j+1)%3];
    const pa=points[v],pb=points[w];
    // Use source topology, so a changing fold cannot merge different edges or
    // alter the stretch sample population when their deformed points coincide.
    const id=mesh.uuid+':'+Math.min(v,w)+','+Math.max(v,w);
    edges.set(id,{a:pa,b:pb,free:Math.max(a._wl_cloth.getX(v),a._wl_cloth.getX(w)),indices:[v,w],source:mesh.name,rest:[v,w].map(i=>new Vector3().fromBufferAttribute(a.position,i))});
   }
  }
 }
 assert(triangles.length,'No visible trouser/boot collision triangles');
 const grid=new Map(),cellSize=.12;
 function cells(box,visit){for(let x=Math.floor(box.min.x/cellSize);x<=Math.floor(box.max.x/cellSize);x++)for(let y=Math.floor(box.min.y/cellSize);y<=Math.floor(box.max.y/cellSize);y++)for(let z=Math.floor(box.min.z/cellSize);z<=Math.floor(box.max.z/cellSize);z++)visit(x+','+y+','+z)}
 for(const triangle of triangles)cells(triangle.box,key=>{if(!grid.has(key))grid.set(key,[]);grid.get(key).push(triangle)});
 const intersections=[],direction=new Vector3(),hit=new Vector3(),ray=new Ray(),box=new Box3(),points=new Set();
 for(const edge of edges.values()){
  // This gate classifies movable fabric only. A coincident pinned edge must
  // not consume the hit key before the free skin is checked.
  if(edge.free<=0)continue;
  const length=direction.subVectors(edge.b,edge.a).length();if(length<1e-7)continue;
  direction.divideScalar(length);ray.set(edge.a,direction);box.setFromPoints([edge.a,edge.b]);
  const candidates=new Set();cells(box,key=>{for(const triangle of grid.get(key)??[])candidates.add(triangle)});
  for(const {vertices,indices:targetIndices,box:target,part}of candidates){
   if(!box.intersectsBox(target))continue;
   const point=ray.intersectTriangle(...vertices,false,hit);if(!point)continue;
   const distance=point.distanceTo(edge.a);if(distance<.0001||distance>length-.0001)continue;
   const id=edge.source+':'+key(point);if(points.has(id))continue;points.add(id);
   intersections.push({point:point.toArray(),part,targetIndices,free:edge.free,indices:edge.indices,source:edge.source,edge:[edge.a.toArray(),edge.b.toArray()],restEdge:edge.rest.map(p=>p.toArray()),rest:edge.rest[0].clone().lerp(edge.rest[1],distance/length).toArray()});
  }
 }
 const lengths=[];
 for(const edge of edges.values()) {
  if(edge.free<=0)continue;
  const restLength=edge.rest[0].distanceTo(edge.rest[1]);
  // Exclude tiny thickness/seam edges: the metric describes fabric travel,
  // rather than numerical noise across its two almost coincident skins.
  if(restLength<.015)continue;
  const ratio=edge.a.distanceTo(edge.b)/restLength;
  assert(Number.isFinite(ratio),'Non-finite visible fabric edge');
  lengths.push({ratio,source:edge.source,indices:edge.indices,restLength,
   rest:edge.rest.map(p=>p.toArray()),deformed:[edge.a.toArray(),edge.b.toArray()]});
 }
 lengths.sort((a,b)=>a.ratio-b.ratio);
 assert(lengths.length,'No measurable garment edges');
 const garments={};
 for(const name of new Set(lengths.map(edge=>edge.source))) {
  const edges=lengths.filter(edge=>edge.source===name);
  garments[name]={edges:edges.length,max:edges.at(-1).ratio,p95:edges[Math.floor(edges.length*.95)].ratio,doubled:edges.filter(edge=>edge.ratio>2).length};
 }
 return{free:intersections.filter(i=>i.free>0).length,intersections,
  stretch:{edges:lengths.length,max:lengths.at(-1).ratio,p95:lengths[Math.floor(lengths.length*.95)].ratio,
   doubled:lengths.filter(e=>e.ratio>2).length,garments,worst:lengths.slice(-5)}};
}
const proof=[];
for(const name of ['walk','run']) {
 const gltf=await new GLTFLoader().parseAsync(buffer,''),actor=gltf.scene;actor.updateMatrixWorld(true);
 const sim=new ClothProxy(data,actor,data.colliders),mixer=new AnimationMixer(actor),clip=gltf.animations.find(c=>c.name===name);
 assert(clip,'Missing clip: '+name);
 const action=mixer.clipAction(clip).play();
 mixer.update(0);sim.reset();const parts=[];actor.traverse(mesh=>{if(mesh.isSkinnedMesh)parts.push(mesh)});
 for(let frame=0;frame<=Math.ceil(clip.duration*60)*CYCLES;frame++) {
  if(frame){mixer.update(1/60);actor.updateMatrixWorld(true);sim.update(1/60)}
  const result=cuts(parts.map(mesh=>deform(mesh,sim)));
  proof.push({name,time:action.time,free:result.free,rear:result.intersections.filter(h=>h.free>0&&h.rest[2]<-.15).length,
   stretch:result.stretch,intersections:result.intersections.filter(h=>h.free>0)});
 }
}
const summary=['walk','run'].map(name=>{
 const frames=proof.filter(f=>f.name===name);
 return{name,samples:frames.length,crossings:frames.reduce((n,f)=>n+f.free,0),
  rearCrossings:frames.reduce((n,f)=>n+f.rear,0),maxStretch:Math.max(...frames.map(f=>f.stretch.max)),
  worstP95Stretch:Math.max(...frames.map(f=>f.stretch.p95)),
  doubledEdges:frames.reduce((n,f)=>n+f.stretch.doubled,0)};
});
const file=join(directory,'garment-surface-motion.json');
writeFileSync(file,JSON.stringify({proxy:data.id,sampling:{fps:60,stride:1,cycles:CYCLES,minEdgeLength:.015},summary,frames:proof},null,2));
console.log(JSON.stringify({file,summary},null,2));
assert(summary.every(s=>s.crossings===0&&s.doubledEdges===0),
 'Visible garment still crosses the legs or stretches beyond twice its rest length; see garment-surface-motion.json');
