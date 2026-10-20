import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three/webgpu'
import { ClothProxy } from './cloth-proxy.js'

function curtain() {
  const actor=new THREE.Group(),root=new THREE.Bone(),knee=new THREE.Bone(),ankle=new THREE.Bone()
  root.name='anchor'; knee.name='knee'; ankle.name='ankle'
  knee.position.set(0,.9,-.3); ankle.position.set(0,.2,-.3)
  actor.add(root,knee,ankle); actor.updateMatrixWorld(true)
  const skeleton=new THREE.Skeleton([root,knee,ankle])
  const mesh=new THREE.SkinnedMesh(new THREE.BufferGeometry(),new THREE.MeshBasicNodeMaterial())
  mesh.bind(skeleton); actor.add(mesh)
  const positions=[[0,0,0],[-.12,1.2,.1],[.12,1.2,.1],[-.12,.5,.1],[.12,.5,.1]]
  const edges=[[1,2],[1,3],[2,4],[3,4],[1,4],[2,3]].map(([a,b])=>[a,b,new THREE.Vector3(...positions[a]).distanceTo(new THREE.Vector3(...positions[b])),1])
  const data={version:1,positions,skin:[[],...positions.slice(1).map(()=>[['anchor',1]])],mobility:[0,0,0,1,1],region:[0,1,1,1,1],triangles:[[0,0,0],[1,2,3],[2,4,3]],edges}
  const simulation=new ClothProxy(data,actor,[['knee','ankle',.17,'leg']])
  return {actor,root,knee,ankle,simulation,data}
}

test('a moving knee carries the panel forward and retains contact after stopping',()=>{
  const {actor,knee,ankle,simulation}=curtain()
  for(let i=0;i<90;i++) {
    knee.position.z=ankle.position.z=-.3+i/89*.48
    actor.updateMatrixWorld(true); simulation.update(1/60)
  }
  for(let i=0;i<120;i++) simulation.update(1/60)
  for(const i of [3,4]) assert(simulation.position[i].z>.30,'Panel passed behind the leg')
  assert.equal(simulation.inspect().penetrations,0)
  assert(simulation.inspect().maxStretch<1.08,'Fabric stretched instead of moving around the leg')
  assert.deepEqual(simulation.position[1].toArray(),[-.12,1.2,.1])
})

test('free fabric settles on the floor without a pose tether pulling it below',()=>{
  const {actor,simulation,data}=curtain()
  data.edges=[]; simulation.edgeData=new Float64Array()
  simulation.targets[3].y=.02; simulation.rest[3].y=.02
  simulation.reset()
  for(let i=0;i<180;i++) {actor.updateMatrixWorld(true);simulation.update(1/60)}
  assert(simulation.position[3].y>=.045)
  assert(simulation.position[3].y<.046)
})

test('actor placement does not change local cloth dynamics',()=>{
  const a=curtain(),b=curtain(); b.actor.position.set(10,0,-8)
  for(let i=0;i<60;i++) {
    for(const fixture of [a,b]) {
      fixture.knee.position.z=fixture.ankle.position.z=-.3+i/59*.48
      fixture.actor.updateMatrixWorld(true);fixture.simulation.update(1/60)
    }
  }
  a.simulation.position.forEach((p,i)=>assert(p.distanceTo(b.simulation.position[i])<1e-8))
})

test('the pinned garment follows its attachment while the free hem retains motion',()=>{
  const {actor,root,simulation}=curtain()
  for(let i=0;i<30;i++) {root.position.x=i/29*.25;actor.updateMatrixWorld(true);simulation.update(1/60)}
  assert(Math.abs(simulation.position[1].x-.13)<1e-8)
  const before=simulation.position[3].clone()
  simulation.update(1/60)
  assert(simulation.position[3].distanceTo(before)>.0001,'Fabric lost all motion as soon as its anchor stopped')
})
