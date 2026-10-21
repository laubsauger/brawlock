import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three/webgpu'
import { ClothProxy, fitClothRotation } from './cloth-proxy.js'
import { conformClothToLegs, clearRearCloth } from './cloth-leg-contact.js'

function fittedSkirt() {
  const actor=new THREE.Group(),pelvis=new THREE.Bone()
  pelvis.name='pelvis';pelvis.position.y=1;actor.add(pelvis)
  const bones=[pelvis],colliders=[],colliderRest=[]
  for(const side of ['l','r']) {
    const thigh=new THREE.Bone(),knee=new THREE.Bone(),foot=new THREE.Bone()
    thigh.name='thigh_'+side;knee.name='calf_'+side;foot.name='foot_'+side
    thigh.position.x=side==='l'?.1:-.1;knee.position.y=foot.position.y=-.4
    pelvis.add(thigh);thigh.add(knee);knee.add(foot);bones.push(thigh,knee,foot)
  }
  actor.updateMatrixWorld(true)
  const mesh=new THREE.SkinnedMesh(new THREE.BufferGeometry(),new THREE.MeshBasicNodeMaterial())
  mesh.bind(new THREE.Skeleton(bones));actor.add(mesh)
  for(const side of ['l','r'])for(const [a,b] of [['thigh_','calf_'],['calf_','foot_']]) {
    const left=actor.getObjectByName(a+side),right=actor.getObjectByName(b+side)
    colliders.push([left.name,right.name,.07,'leg',[0,0,0],[0,0,0]])
    colliderRest.push([left.getWorldPosition(new THREE.Vector3()).toArray(),right.getWorldPosition(new THREE.Vector3()).toArray()])
  }
  const positions=[[0,0,0],[-.13,1.1,.12],[.13,1.1,.12],[.13,.78,.12],[.13,.34,.18],[-.13,.78,.12],[-.13,.34,.18]]
  const data={version:1,positions,skin:[[],...positions.slice(1).map(()=>[['pelvis',1]])],
    contact:positions.map(()=>[0,0,1]),drape:positions,mobility:[0,0,0,.35,1,.35,1],
    region:[0,1,1,1,1,1,1],edges:[],triangles:[[0,0,0],[1,2,3]],layers:[],sleeves:[],garmentEnvelopes:[],
    legCloth:[{name:'test skirt',nodes:[1,2,3,4,5,6],padding:.006}],clearance:positions.map(()=>.006),colliderRest}
  return {actor,pelvis,data,simulation:new ClothProxy(data,actor,colliders),thigh:actor.getObjectByName('thigh_l')}
}

test('fitted skirt preserves its rest silhouette and ignores thigh axial twist',()=>{
  const {actor,thigh,simulation}=fittedSkirt()
  simulation.references.forEach((p,i)=>assert(p.distanceTo(simulation.rest[i])<1e-8))
  thigh.rotation.y=1.8;actor.updateMatrixWorld(true);simulation.sampleTargets()
  simulation.references.forEach((p,i)=>assert(p.distanceTo(simulation.rest[i])<1e-8,'Thigh twist inflated or spun the skirt'))
})

test('one bent thigh opens its own cloth while the opposite hip stays fitted',()=>{
  const {actor,thigh,simulation}=fittedSkirt()
  thigh.rotation.x=-.9;actor.updateMatrixWorld(true);simulation.update(1/60)
  assert(simulation.references[3].z>simulation.rest[3].z+.1,'Cloth did not follow the raised thigh')
  assert(simulation.references[5].distanceTo(simulation.rest[5])<1e-8,'The other hip expanded')
  assert(simulation.references[1].distanceTo(simulation.rest[1])<1e-8,'The waist moved with the thigh')
})

test('the hanging hem trails a leg change and settles after the pose stops',()=>{
  const {actor,thigh,simulation}=fittedSkirt()
  thigh.rotation.x=-.9;actor.updateMatrixWorld(true);simulation.update(1/60)
  const hem=simulation.references[4].clone(),upper=simulation.references[3].clone()
  simulation.update(1/60)
  assert(simulation.references[4].distanceTo(hem)>.001,'Hem had no follow-through')
  assert(simulation.references[3].distanceTo(upper)<1e-8,'The thigh attachment lagged')
  for(let frame=0;frame<180;frame++)simulation.update(1/60)
  const before=simulation.position.map(p=>p.clone());simulation.update(1/60)
  before.forEach((p,i)=>assert(p.distanceTo(simulation.position[i])<1e-7,'Held cloth kept jittering'))
})

test('a backward bent calf carries the rear hem progressively without moving the front panel',()=>{
  const {actor,simulation}=fittedSkirt(),cloth=simulation.legCloth[0]
  const samples=[new THREE.Vector3(.13,.58,-.18),new THREE.Vector3(.13,.34,-.18),new THREE.Vector3(.13,.34,.18)]
  const before=samples.map(p=>cloth.shape(p,p,new THREE.Vector3()))
  actor.getObjectByName('calf_l').rotation.x=1;actor.updateMatrixWorld(true)
  simulation.update(1/60)
  const first=cloth.shape(samples[1],samples[1],new THREE.Vector3())
  for(let i=0;i<120;i++)simulation.update(1/60)
  const after=samples.map(p=>cloth.shape(p,p,new THREE.Vector3()))
  assert(after[1].z<before[1].z-.15,'The rear hem ignored the bent calf')
  assert(after[0].distanceTo(before[0])<after[1].distanceTo(before[1])*.2,'Calf motion moved the whole panel as a rigid slab')
  assert(first.distanceTo(before[1])<after[1].distanceTo(before[1])*.5,'The rear hem snapped immediately to the new pose')
  assert(after[2].distanceTo(before[2])<1e-8,'Rearward calf motion changed the front panel')
})

test('leg conformation keeps thin layers distinct and stays local to the limb',()=>{
  const cap={kind:'leg',a:new THREE.Vector3(),b:new THREE.Vector3(0,1,0),radius:.1}
  let previous=0
  for(const radius of [.02,.0201,.06,.09,.1,.1001,.15,.3]) {
    const p=new THREE.Vector3(radius,.5,0);conformClothToLegs(p,[cap])
    assert(p.x>.1&&p.x>previous,'Thin layers collapsed onto the same surface');previous=p.x
  }
  const far=new THREE.Vector3(.6,.5,0);conformClothToLegs(far,[cap])
  assert(Math.abs(far.x-.6)<1e-6,'A distant limb inflated the cloth')
  assert.throws(()=>conformClothToLegs(new THREE.Vector3(0,.5,0),[cap]),/limb axis/)
})

test('a rear sheet clears a passing calf without splitting across its two sides',()=>{
  const cap={kind:'leg',a:new THREE.Vector3(0,0,0),b:new THREE.Vector3(0,1,0),radius:.1}
  const rear=new THREE.Vector3(0,0,-1)
  const ends=[new THREE.Vector3(-.03,.5,.11),new THREE.Vector3(.03,.5,-.11)]
  ends.forEach(p=>clearRearCloth(p,[cap],rear,1))
  for(let step=0;step<=20;step++) {
    const p=ends[0].clone().lerp(ends[1],step/20)
    assert(Math.hypot(p.x,p.z)>.1,'The edge between clear vertices still crossed the calf')
    assert(p.z<0,'Rear fabric escaped around the front of the calf')
  }
})

test('rear contact handles capsule end caps and a limb aimed along the exit direction',()=>{
  const rear=new THREE.Vector3(0,0,-1)
  for(const b of [new THREE.Vector3(0,1,0),new THREE.Vector3(0,0,-1)]) {
    const cap={kind:'leg',a:new THREE.Vector3(),b,radius:.1}
    const p=b.clone().add(new THREE.Vector3(.02,.02,.04))
    clearRearCloth(p,[cap],rear,1)
    assert(p.toArray().every(Number.isFinite),'An end-on limb produced invalid cloth')
    assert(p.z<b.z-.09,'Fabric remained inside the endpoint sphere')
  }
})

test('rear contact preserves layer order, fades at the footprint edge and respects its mask',()=>{
  const cap={kind:'leg',a:new THREE.Vector3(),b:new THREE.Vector3(0,1,0),radius:.1}
  const rear=new THREE.Vector3(0,0,-1)
  let previous=-Infinity
  for(const z of [-.5,-.15,-.1,-.0999,0,.1,.1001,.5]) {
    const p=new THREE.Vector3(.02,.5,z);clearRearCloth(p,[cap],rear,1)
    assert(p.z>previous,'Thin layers collapsed or exchanged order');previous=p.z
  }
  const points=[.1659,.166,.1661,.5].map(x=>{
    const p=new THREE.Vector3(x,.5,.02);clearRearCloth(p,[cap],rear,1);return p
  })
  assert(points[0].distanceTo(points[1])<.00011,'Contact jumped at the footprint boundary')
  assert.deepEqual(points[3].toArray(),[.5,.5,.02],'Distant cloth moved with this limb')
  const masked=new THREE.Vector3(0,.5,.02);clearRearCloth(masked,[cap],rear,0)
  assert.deepEqual(masked.toArray(),[0,.5,.02],'Masked cloth moved')
})

test('rear contact follows the actor frame rather than a fixed world axis',()=>{
  const q=new THREE.Quaternion().setFromEuler(new THREE.Euler(.3,1.1,-.2))
  const cap={kind:'leg',a:new THREE.Vector3(),b:new THREE.Vector3(0,1,0),radius:.1}
  const p=new THREE.Vector3(.02,.5,.08),expected=clearRearCloth(p.clone(),[cap],new THREE.Vector3(0,0,-1),1)
  const rotated={...cap,a:cap.a.clone().applyQuaternion(q),b:cap.b.clone().applyQuaternion(q)}
  const actual=clearRearCloth(p.clone().applyQuaternion(q),[rotated],new THREE.Vector3(0,0,-1).applyQuaternion(q),1)
  assert(actual.distanceTo(expected.applyQuaternion(q))<1e-8)
})

test('fitted hem follow-through agrees across frame rates and actor placement',()=>{
  const fixtures=[30,60,120].map((fps,index)=>{
    const fixture=fittedSkirt()
    if(index===2){fixture.actor.position.set(6,2,-3);fixture.actor.rotation.y=.8}
    fixture.thigh.rotation.x=-.9;fixture.actor.updateMatrixWorld(true)
    for(let frame=0;frame<fps/2;frame++)fixture.simulation.update(1/fps)
    return fixture
  })
  fixtures[0].simulation.references.forEach((p,i)=>{
    for(const fixture of fixtures.slice(1))assert(p.distanceTo(fixture.simulation.references[i])<1e-7,'Hem response depends on display rate or actor placement')
  })
})

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
  const data={version:1,positions,contact:positions.map((_,i)=>i>0?[0,0,1]:[0,0,0]),drape:positions,skin:[[],...positions.slice(1).map(()=>[['anchor',1]])],mobility:[0,0,0,1,1],region:[0,1,1,1,1],garmentEnvelopes:[],legCloth:[],clearance:positions.map(()=>.006),sleeves:[],layers:[],triangles:[[0,0,0],[1,2,3],[2,4,3]],edges}
  const simulation=new ClothProxy(data,actor,[['knee','ankle',.17,'leg',[0,0,0],[0,0,0]]])
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
  data.edges=[]
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

test('front panels recover in front of a leg rather than wrapping behind it',()=>{
  const {actor,knee,ankle,simulation}=curtain()
  knee.position.z=ankle.position.z=.16
  actor.updateMatrixWorld(true)
  simulation.reset()
  for(let i=0;i<30;i++) simulation.update(1/60)
  assert(simulation.position[3].z>.28)
  assert(simulation.position[4].z>.28)
})

test('a hanging sleeve reference points down after the arm rotates',()=>{
  const fixture=curtain(),{actor,root,data}=fixture
  data.region=[0,4,4,4,4]
  data.contact=data.positions.map(()=>[0,0,0])
  data.drape=data.positions.map(p=>[p[0],Math.max(p[1],.8),p[2]])
  root.rotation.z=Math.PI/2;actor.updateMatrixWorld(true)
  const sim=new ClothProxy(data,actor,[])
  const anchor=new THREE.Vector3(...data.drape[3]).applyMatrix4(root.matrixWorld)
  assert(sim.references[3].y<anchor.y-.28,'Sleeve reference rotated sideways with the arm')
})

test('sleeve fabric also collides with the hips and legs',()=>{
  const fixture=curtain(),{actor,knee,ankle,data}=fixture
  data.region=[0,4,4,4,4];data.contact=data.positions.map(()=>[0,0,0])
  knee.position.z=ankle.position.z=.12;actor.updateMatrixWorld(true)
  const sim=new ClothProxy(data,actor,[['knee','ankle',.17,'leg',[0,0,0],[0,0,0]]])
  for(let i=0;i<30;i++)sim.update(1/60)
  assert.equal(sim.inspect().penetrations,0,'Cuff fabric ignored a leg collision')
})

test('front-panel clearance is correct against an angled calf',()=>{
  const {actor,knee,ankle,simulation}=curtain()
  knee.position.set(0,.9,.25);ankle.position.set(0,.3,-.25)
  actor.updateMatrixWorld(true);simulation.reset()
  for(let i=0;i<30;i++) simulation.update(1/60)
  assert.equal(simulation.inspect().penetrations,0,'Projected-axis approximation left the panel inside the bent leg')
})

test('a separated leg cannot push a short overlay across an empty gap',()=>{
  const {simulation,knee,ankle,actor}=curtain()
  knee.position.z=ankle.position.z=.6;actor.updateMatrixWorld(true);simulation.sampleTargets()
  for(const cap of simulation.capsules){cap.at.copy(cap.a);cap.bt.copy(cap.b)}
  const point=new Float64Array([0,.5,.1]),previous=new Float64Array(point)
  simulation.projectContact(0,point,new THREE.Vector3(0,0,1),2,true,previous,.045)
  assert.deepEqual([...point],[0,.5,.1],'A non-contacting leg inflated the garment')
})

test('a folded cloth frame retains its tangent rather than flipping with a normal',()=>{
  const expected=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),2.4)
  const edges=[new THREE.Vector3(1,0,0),new THREE.Vector3(.1,1,0),new THREE.Vector3(-.2,.5,0)]
  const covariance=[new THREE.Vector3(),new THREE.Vector3(),new THREE.Vector3()]
  for(const edge of edges) {
    const rotated=edge.clone().applyQuaternion(expected)
    covariance[0].addScaledVector(rotated,edge.x);covariance[1].addScaledVector(rotated,edge.y);covariance[2].addScaledVector(rotated,edge.z)
  }
  const fitted=fitClothRotation(covariance,new THREE.Quaternion())
  assert(fitted.angleTo(expected)<.002,'The local fabric frame lost its orientation')
})

test('layer contact preserves separation while allowing a detached panel to move away',()=>{
  const {actor,data}=curtain()
  data.drape=data.drape.map(p=>[...p])
  data.positions.push([0,.85,-.08]);data.contact.push([0,0,1]);data.drape.push([0,.85,-.08])
  data.skin.push([['anchor',1]]);data.mobility.push(1);data.region.push(2)
  data.layers=[[5,1,2,3,.25,.25,.5,-1,.012]]
  const simulation=new ClothProxy(data,actor,[])
  simulation.projectLayers()
  const p=simulation.p
  const surface=p[1*3+2]*.25+p[2*3+2]*.25+p[3*3+2]*.5
  assert(p[5*3+2]-surface>=.012-1e-8,'The outer panel crossed the inner garment')
  p[5*3]=4;p[5*3+2]=-.08
  simulation.projectLayers()
  assert.equal(p[5*3+2],-.08,'A distant panel was pushed by an infinite layer plane')
})

test('forearm roll does not carry the hanging cuff around the arm',()=>{
  const {actor,root,knee,data}=curtain()
  data.sleeves=[[3,'anchor','knee',.5,.3,0,.05]]
  data.region=[0,4,4,4,4]
  const simulation=new ClothProxy(data,actor,[])
  const before=simulation.references[3].clone(),oldTarget=simulation.targets[3].clone()
  root.quaternion.setFromAxisAngle(knee.position.clone().normalize(),Math.PI/2)
  actor.updateMatrixWorld(true);simulation.sampleTargets()
  assert(simulation.targets[3].distanceTo(oldTarget)>.1,'The test did not rotate the sleeve skin')
  assert(simulation.references[3].distanceTo(before)<.01,'The free cuff rotated around the arm instead of hanging down')
})

test('sleeve orientation stays continuous as an arm crosses the vertical pose',()=>{
  const {actor,knee,data}=curtain()
  data.sleeves=[[3,'anchor','knee',.5,.3,0,.05]]
  const simulation=new ClothProxy(data,actor,[])
  const frame=simulation.sleeveAttachments.get(3).frame
  let previous=null
  for(let i=0;i<=120;i++) {
    const angle=i/120*Math.PI
    knee.position.set(.9*Math.cos(angle),-.9*Math.sin(angle),0)
    actor.updateMatrixWorld(true);simulation.sampleTargets()
    assert(Math.abs(frame.front.length()-1)<1e-6,'The vertical arm lost its cloth orientation')
    if(previous)assert(frame.front.dot(previous)>.95,'The cuff reversed orientation at the vertical pose')
    previous=frame.front.clone()
  }
})

test('ground contact settles without turning a correction into a rebound',()=>{
  const {actor,root,simulation}=curtain()
  let lateMotion=0
  for(let frame=0;frame<360;frame++) {
    root.position.y=frame<60?-.8*frame/59:-.8
    actor.updateMatrixWorld(true)
    const before=simulation.position[3].clone()
    simulation.update(1/60)
    assert(simulation.position[3].y>=.045)
    if(frame>300)lateMotion=Math.max(lateMotion,simulation.position[3].distanceTo(before))
  }
  assert(lateMotion<1e-7,'A stopped garment kept jittering against the floor')
  assert(Math.abs(simulation.velocity[10])<1e-7,'Floor corrections retained vertical energy')
})

test('secondary motion stays bounded through repeated abrupt knee changes',()=>{
  const {actor,knee,ankle,simulation,data}=curtain()
  for(let frame=0;frame<240;frame++) {
    knee.position.z=ankle.position.z=frame%40<20?.18:-.3
    actor.updateMatrixWorld(true);simulation.update(1/60)
    for(const i of [3,4]) {
      const length=new THREE.Vector3().fromArray(simulation.secondary,i*3).length()
      assert(length<=.025+data.mobility[i]*.22+1e-6,'Contact escaped the secondary motion envelope')
      assert(simulation.position[i].toArray().every(Number.isFinite))
    }
  }
})

test('motion and settlement agree at 30, 60 and 120 display frames per second',()=>{
  const outputs=[]
  for(const fps of [30,60,120]) {
    const {actor,root,knee,ankle,simulation}=curtain()
    for(let frame=1;frame<=fps*3;frame++) {
      const time=frame/fps
      root.position.x=.08*Math.sin(time*3)
      knee.position.z=ankle.position.z=-.1+.18*Math.sin(time*4)
      actor.updateMatrixWorld(true);simulation.update(1/fps)
    }
    outputs.push(simulation.position.map(p=>p.clone()))
  }
  for(const points of outputs)for(let i=1;i<points.length;i++)assert(points[i].distanceTo(outputs[2][i])<.003,'Display rate changed the cloth shape by more than 3 mm')
})

test('layer ordering cannot displace the underlying garment driver',()=>{
  const {actor,data}=curtain()
  data.drape=data.drape.map(p=>[...p])
  data.positions.push([0,.85,-.08]);data.contact.push([0,0,1]);data.drape.push([0,.85,-.08])
  data.skin.push([['anchor',1]]);data.mobility.push(1);data.region.push(2)
  data.layers=[[5,1,2,3,.25,.25,.5,-1,.012]]
  const simulation=new ClothProxy(data,actor,[])
  simulation.p[17]=-.2
  const driver=[...simulation.p.slice(3,15)]
  simulation.projectLayers()
  assert.deepEqual([...simulation.p.slice(3,15)],driver)
  assert(simulation.p[17]>-.2)
})

test('convex garment contact clears cuffs without repelling distant cloth',async()=>{
  const {projectConvexGarmentContact}=await import('./garment-contact.js')
  const planes=[]
  for(const axis of [0,1,2])for(const direction of [-1,1]) {
    const normal=new THREE.Vector3().setComponent(axis,direction)
    planes.push({normal,constant:1})
  }
  const point=new THREE.Vector3(.99,.2,.3)
  assert(projectConvexGarmentContact(point,planes,.02,new THREE.Vector3())>0)
  assert(Math.abs(point.x-1.02)<1e-8)
  for(const coordinates of [[2,0,0],[0,2,0],[0,0,-2]]) {
    const remote=new THREE.Vector3(...coordinates)
    assert.equal(projectConvexGarmentContact(remote,planes,.02,new THREE.Vector3()),0)
    assert.deepEqual(remote.toArray(),coordinates)
  }
})

test('cuff clearance stays continuous across two equally near envelope faces',async()=>{
  const {projectConvexGarmentContact}=await import('./garment-contact.js')
  const planes=[]
  for(const axis of [0,1,2])for(const direction of [-1,1])planes.push({normal:new THREE.Vector3().setComponent(axis,direction),constant:1})
  const a=new THREE.Vector3(.5,.5-.00001,.1),b=new THREE.Vector3(.5,.5+.00001,.1)
  for(const p of [a,b])projectConvexGarmentContact(p,planes,.02,new THREE.Vector3())
  assert(a.distanceTo(b)<.0001,'Nearest-face switching snapped the cuff across a corner')
})

test('a garment envelope stays in its attachment joint frame after translation and rotation',()=>{
  const fixtures=[curtain(),curtain()],results=[]
  for(let index=0;index<fixtures.length;index++) {
    const {actor,root,data}=fixtures[index],center=new THREE.Vector3(0,.5,.1),planes=[]
    for(const axis of [0,1,2])for(const sign of [-1,1]) {
      const normal=new THREE.Vector3().setComponent(axis,sign)
      planes.push([...normal.toArray(),normal.dot(center)+.2])
    }
    data.region=[0,4,4,4,4]
    data.garmentEnvelopes=[{joint:'anchor',center:center.toArray(),gap:.02,planes}]
    if(index){root.position.set(2,0,-1);root.rotation.y=.7;actor.updateMatrixWorld(true)}
    const sim=new ClothProxy(data,actor,[])
    for(let frame=0;frame<60;frame++)sim.update(1/60)
    results.push(sim.position[3].clone())
  }
  results[0].applyMatrix4(fixtures[1].root.matrixWorld)
  assert(results[0].distanceTo(results[1])<1e-7,'The clearance volume used world axes instead of joint-local coordinates')
})
