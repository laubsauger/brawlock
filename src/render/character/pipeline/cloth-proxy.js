// Shared fitted-character cloth with bounded, damped secondary motion.
import { Matrix4, Quaternion, Vector3, Vector4 } from 'three/webgpu'
import { uniformArray } from 'three/tsl'
import { projectConvexGarmentContact } from './garment-contact.js'
import { ClothLegContact, CLOTH_SKIN } from './cloth-leg-contact.js'

export const MAX_CLOTH_STEP = 1 / 50
const ab = new Vector3(), nearest = new Vector3(), delta = new Vector3()
const inverse = new Matrix4(), sample = new Vector3()
const normalA = new Vector3(), normalB = new Vector3(), edge = new Vector3(), rotation = new Quaternion()
const identityRotation=new Quaternion()
const frameX=new Vector3(),frameY=new Vector3(),frameZ=new Vector3(),spin=new Vector3(),turn=new Quaternion()

export function clothPrimaryFreedom(mobility,region) {
  const t=Math.max(0,Math.min(1,mobility/(region===1||region===2?.025:.12)))
  return t*t*(3-2*t)
}

// Fit the whole local edge frame. A rotation inferred from just two normals is
// ambiguous at a folded/skinny triangle and can reverse by 180 degrees while
// its particles barely move. Edge covariance retains the fabric's tangent.
export function fitClothRotation(covariance, quaternion, iterations=12) {
  const [a,b,c]=covariance
  for(let iteration=0;iteration<iterations;iteration++) {
    frameX.set(1,0,0).applyQuaternion(quaternion)
    frameY.set(0,1,0).applyQuaternion(quaternion)
    frameZ.set(0,0,1).applyQuaternion(quaternion)
    spin.crossVectors(frameX,a).add(normalA.crossVectors(frameY,b)).add(normalB.crossVectors(frameZ,c))
    spin.multiplyScalar(1/(Math.abs(frameX.dot(a)+frameY.dot(b)+frameZ.dot(c))+1e-12))
    const angle=spin.length()
    if(angle<1e-6)break
    turn.setFromAxisAngle(spin.multiplyScalar(1/angle),angle)
    quaternion.premultiply(turn).normalize()
  }
  return quaternion
}

export class ClothProxy {
  constructor(data, actor, definitions) {
    if (data.version !== 1 || data.positions.length > 512) throw new Error('Unsupported cloth proxy')
    if(!Array.isArray(data.layers)||!Array.isArray(data.sleeves)||!Array.isArray(data.garmentEnvelopes))throw new Error('Rebuild cloth data: garment layers, sleeve attachments and garment envelopes are required')
    this.data = data
    this.actor = actor
    this.rest = data.positions.map(p => new Vector3(...p))
    this.targets = this.rest.map(p => p.clone())
    this.references=this.rest.map(p=>p.clone())
    this.oldReferences=this.rest.map(p=>p.clone())
    this.drape=data.drape.map(p=>new Vector3(...p))
    this.canDrape=this.drape.map((p,i)=>p.distanceToSquared(this.rest[i])>1e-12)
    this.contactRest=data.contact.map(p=>new Vector3(...p))
    this.contactNormals=this.contactRest.map(p=>p.clone())
    this.position = this.rest.map(p => p.clone())
    this.previous = this.rest.map(p => p.clone())
    this.offsets = this.rest.map(() => new Vector3())
    this.primaryOffsets=this.rest.map(()=>new Vector3())
    this.primaryOffsetNode=uniformArray(this.primaryOffsets,'vec3')
    this.rotations = this.rest.map(() => new Vector4(0, 0, 0, 1))
    this.offsetNode = uniformArray(this.offsets, 'vec3')
    this.targetNode = uniformArray(this.targets, 'vec3')
    this.rotationNode = uniformArray(this.rotations, 'vec4')
    this.weights = data.mobility.map(m => m === 0 ? 0 : Math.max(.15, m))
    this.skin = data.skin.map(weights => weights.map(([name, weight]) => {
      const bone = actor.getObjectByName(name)
      if (!bone?.isBone) throw new Error('Missing cloth skin joint: ' + name)
      return {bone, weight}
    }))
    actor.updateMatrixWorld(true)
    inverse.copy(actor.matrixWorld).invert()
    const bones = new Map()
    actor.traverse(obj => { if (obj.isSkinnedMesh) obj.skeleton.bones.forEach((bone, i) => bones.set(bone, obj.skeleton.boneInverses[i])) })
    this.skinMatrices = new Map([...bones].map(([bone, bind]) => [bone, {bind, matrix:new Matrix4()}]))
    this.sleeveFrames=new Map()
    this.sleeveAttachments=new Map(data.sleeves.map(([i,left,right,along,drop,across,radius])=>{
      const key=left+right
      if(!this.sleeveFrames.has(key)) {
        const a=actor.getObjectByName(left),b=actor.getObjectByName(right)
        if(!a?.isBone||!b?.isBone)throw new Error('Missing sleeve attachment joint')
        const axis=b.getWorldPosition(new Vector3()).sub(a.getWorldPosition(new Vector3())).transformDirection(inverse)
        const front=axis.clone().cross(new Vector3(0,-1,0)).normalize()
        this.sleeveFrames.set(key,{a,b,axis,front,restAxis:axis.clone(),restFront:front.clone(),start:new Vector3(),end:new Vector3()})
      }
      if(!(radius>0))throw new Error('Sleeve attachment radius is required')
      return [i,{frame:this.sleeveFrames.get(key),along,drop,across,radius}]
    }))
    this.capsules = definitions.map(([left,right,radius,kind,offsetA,offsetB,driverA,driverB]) => {
      const a = actor.getObjectByName(left), b = actor.getObjectByName(right)
      if (!a?.isBone || !b?.isBone) throw new Error('Missing cloth collision joint')
      if(!offsetA || !offsetB) throw new Error('Collision endpoints require fitted local offsets')
      const start=actor.getObjectByName(driverA),end=actor.getObjectByName(driverB)
      if(!start?.isBone||!end?.isBone)throw new Error('Collision endpoint drivers are required; rebuild the cloth data')
      return {left:a,right:b,driverA:start,driverB:end,radius,kind,offsetA:new Vector3(...offsetA),offsetB:new Vector3(...offsetB),a:new Vector3(),b:new Vector3(),oldA:new Vector3(),oldB:new Vector3(),at:new Vector3(),bt:new Vector3()}
    })
    this.p = new Float64Array(data.positions.flat())
    this.prev = new Float64Array(this.p)
    this.velocity=new Float64Array(this.p.length)
    this.smoothed=new Float64Array(this.p.length)
    this.secondary=new Float64Array(this.p.length)
    this.neighbours=this.rest.map(()=>[])
    for(const [a,b,length,stiffness] of data.edges) if(stiffness===1) {
      this.neighbours[a].push([b,1/(length*length)])
      this.neighbours[b].push([a,1/(length*length)])
    }
    this.covariance=[new Vector3(),new Vector3(),new Vector3()]
    this.sleeveNodes=data.region.flatMap((region,i)=>region===4&&this.weights[i]>0?[i]:[])
    this.garmentEnvelopes=data.garmentEnvelopes.map(({joint,planes,gap,center})=>{
      const bone=actor.getObjectByName(joint)
      if(!bone?.isBone||planes.length<6||!(gap>0)||!center||center.length!==3)throw new Error('Invalid fitted garment envelope')
      return {bone,gap,center:new Vector3(...center),planes:planes.map(([x,y,z,constant])=>({normal:new Vector3(x,y,z),constant})),toLocal:new Matrix4(),toActor:new Matrix4()}
    })
    if(!Array.isArray(data.legCloth)||!Array.isArray(data.clearance))throw new Error('Rebuild cloth data: local leg contacts are required')
    this.legCloth=data.legCloth.map(definition=>new ClothLegContact(definition,this))
    this.legClothByNode=new Map(this.legCloth.flatMap(cloth=>cloth.nodes.map(i=>[i,cloth])))
    this.lastCost = 0
    this.maxCost = 0
    this.reset()
  }

  sampleTargets(dt=0) {
    inverse.copy(this.actor.matrixWorld).invert()
    for (const [bone, value] of this.skinMatrices) value.matrix.multiplyMatrices(inverse,bone.matrixWorld).multiply(value.bind)
    for(const frame of this.sleeveFrames.values()) {
      frame.a.getWorldPosition(frame.start).applyMatrix4(inverse)
      frame.b.getWorldPosition(frame.end).applyMatrix4(inverse)
      edge.copy(frame.end).sub(frame.start).normalize()
      rotation.setFromUnitVectors(frame.axis,edge)
      frame.front.applyQuaternion(rotation)
      // Parallel transport through vertical arm poses, where gravity alone
      // cannot choose a direction around the arm. This removes forearm twist
      // without a sudden arbitrary orientation at the singular pose.
      delta.crossVectors(edge,sample.set(0,-1,0))
      const influence=delta.lengthSq()/(delta.lengthSq()+.04)
      if(delta.dot(frame.front)<0)delta.negate()
      if(delta.lengthSq()>0)frame.front.lerp(delta.normalize(),influence).normalize()
      frame.axis.copy(edge)
    }
    for (let i=1; i<this.rest.length; i++) {
      const p=this.targets[i]; p.set(0,0,0)
      for (const {bone, weight} of this.skin[i]) {
        sample.copy(this.rest[i]).applyMatrix4(this.skinMatrices.get(bone).matrix)
        p.addScaledVector(sample,weight)
      }
      this.references[i].copy(p)
      const sleeve=this.sleeveAttachments.get(i)
      if(sleeve&&this.weights[i]>0) {
        const {frame,along,drop,across,radius}=sleeve
        nearest.lerpVectors(frame.start,frame.end,along).addScaledVector(frame.front,across)
        delta.crossVectors(frame.front,frame.axis)
        nearest.addScaledVector(delta,Math.min(drop,radius))
        nearest.y-=Math.max(0,drop-radius)
        this.references[i].lerp(nearest,Math.min(1,this.data.mobility[i]*3)*.98)
      } else if(this.canDrape[i] && this.weights[i]>0 && !this.legClothByNode.has(i)) {
        const anchor=nearest.set(0,0,0)
        for(const {bone,weight} of this.skin[i]) anchor.addScaledVector(sample.copy(this.drape[i]).applyMatrix4(this.skinMatrices.get(bone).matrix),weight)
        delta.copy(p).sub(anchor)
        const length=delta.length()
        if(length>1e-8) {
          const gain=this.data.region[i]===4 ? 3 : 10
          const strength=Math.min(1,this.data.mobility[i]*gain)*.98
          delta.lerp(sample.set(0,-length,0),strength).normalize().multiplyScalar(length)
          this.references[i].copy(anchor).add(delta)
        }
      }
      this.contactNormals[i].copy(this.contactRest[i]).transformDirection(this.skinMatrices.get(this.skin[i][0].bone).matrix)
    }
    for(const envelope of this.garmentEnvelopes) {
      envelope.toActor.multiplyMatrices(inverse,envelope.bone.matrixWorld)
      envelope.toLocal.copy(envelope.toActor).invert()
    }
    for (const cap of this.capsules) {
      cap.a.copy(cap.offsetA).applyMatrix4(cap.driverA.matrixWorld).applyMatrix4(inverse)
      cap.b.copy(cap.offsetB).applyMatrix4(cap.driverB.matrixWorld).applyMatrix4(inverse)
    }
    for(const cloth of this.legCloth)cloth.sample(dt)
    for(let i=1;i<this.rest.length;i++)this.primaryOffsets[i].copy(this.references[i]).sub(this.targets[i])
  }

  reset() {
    this.actor.updateMatrixWorld(true)
    for(const frame of this.sleeveFrames.values()) {frame.axis.copy(frame.restAxis);frame.front.copy(frame.restFront)}
    this.sampleTargets()
    for (let i=0;i<this.rest.length;i++) {
      this.position[i].copy(this.references[i]); this.previous[i].copy(this.references[i]); this.oldReferences[i].copy(this.references[i])
      this.offsets[i].set(0,0,0)
      this.rotations[i].set(0,0,0,1)
    }
    for (const cap of this.capsules) { cap.oldA.copy(cap.a); cap.oldB.copy(cap.b);cap.at.copy(cap.a);cap.bt.copy(cap.b) }
    for(let i=0;i<this.position.length;i++) {
      this.position[i].toArray(this.p,i*3); this.position[i].toArray(this.prev,i*3)
    }
    this.velocity.fill(0)
    this.secondary.fill(0)
    this.shapeGoal()
    for(let i=1;i<this.position.length;i++){this.position[i].fromArray(this.p,i*3);this.previous[i].copy(this.position[i]);this.position[i].toArray(this.prev,i*3)}
    for(let i=1;i<this.position.length;i++) {
      const radius=.025+this.data.mobility[i]*.22
      delta.copy(this.position[i]).sub(this.references[i])
      if(this.weights[i]>0)delta.y=this.position[i].y-Math.max(.045,this.references[i].y)
      if(delta.length()>radius)delta.setLength(radius)
      delta.toArray(this.secondary,i*3)
      if(this.weights[i]>0)this.position[i].copy(this.references[i]).setY(Math.max(.045,this.references[i].y)).add(delta)
      this.position[i].toArray(this.p,i*3);this.position[i].toArray(this.prev,i*3)
    }
    this.publish(12)
  }

  shapeGoal() {
    // Skinning defines skirt conformation; cuffs clear the authored robe.
    // Contacts shape secondary goals without adding collision impulses.
    for(let pass=0;pass<2;pass++)for(let i=1;i<this.weights.length;i++)if(this.weights[i]>0)this.projectParticle(i)
    this.projectLayers()
    this.projectSleeveContacts()
  }

  projectParticle(i) {
    const cloth=this.legClothByNode.get(i)
    if(cloth) {
      this.p[i*3+1]=Math.max(.045,this.p[i*3+1])
      return
    }
    this.projectContact(i*3,this.p,this.contactNormals[i],this.data.region[i],this.rest[i].x>0,this.prev,.045)
  }

  projectLayers() {
    const {p,weights:w}=this
    for(const [i,a,b,c,u,v,t,side,gap] of this.data.layers) {
      const at=i*3,ai=a*3,bi=b*3,ci=c*3
      // Layer order is authored in the animated garment frame. A folded
      // collision target must not reverse that frame or move its own driver.
      normalA.subVectors(this.targets[b],this.targets[a])
      edge.subVectors(this.targets[c],this.targets[a])
      normalA.cross(edge).normalize().multiplyScalar(side)
      nearest.set(p[ai]*u+p[bi]*v+p[ci]*t,p[ai+1]*u+p[bi+1]*v+p[ci+1]*t,p[ai+2]*u+p[bi+2]*v+p[ci+2]*t)
      delta.set(p[at]-nearest.x,p[at+1]-nearest.y,p[at+2]-nearest.z)
      const depth=gap-delta.dot(normalA)
      const mass=w[i]
      if(depth<=0||mass===0)continue
      // A nearby patch defines a layer, not an infinite collision plane.
      const reach=Math.max(edge.lengthSq(),(p[bi]-p[ai])**2+(p[bi+1]-p[ai+1])**2+(p[bi+2]-p[ai+2])**2)
      if(delta.lengthSq()-delta.dot(normalA)**2>reach)continue
      const amount=depth/mass
      const x=normalA.x*amount,y=normalA.y*amount,z=normalA.z*amount
      p[at]+=x*w[i];p[at+1]+=y*w[i];p[at+2]+=z*w[i]
    }
  }

  projectSleeveContacts() {
    for(const i of this.sleeveNodes) {
      sample.fromArray(this.p,i*3)
      for(const envelope of this.garmentEnvelopes) {
        sample.applyMatrix4(envelope.toLocal)
        projectConvexGarmentContact(sample,envelope.planes,envelope.gap,envelope.center)
        sample.applyMatrix4(envelope.toActor)
      }
      sample.toArray(this.p,i*3)
    }
  }

  projectContact(at,p,normal,region,left,previous,floor) {
    let x=p[at],y=p[at+1],z=p[at+2]
    for(const cap of this.capsules) {
      if(cap.kind==='arm' && (region!==4 || cap.left.name.endsWith('_l')!==left)) continue
      const ax=cap.at.x,ay=cap.at.y,az=cap.at.z,bx=cap.bt.x-ax,by=cap.bt.y-ay,bz=cap.bt.z-az
      let fx=normal.x,fy=normal.y,fz=normal.z
      const radius=cap.radius+(region===1 ? CLOTH_SKIN.OUTER : CLOTH_SKIN.OVERLAY)
      const nearestT=Math.max(0,Math.min(1,((x-ax)*bx+(y-ay)*by+(z-az)*bz)/(bx*bx+by*by+bz*bz)))
      const nx0=ax+bx*nearestT,ny0=ay+by*nearestT,nz0=az+bz*nearestT
      if((x-nx0)**2+(y-ny0)**2+(z-nz0)**2>=radius*radius)continue
      if(normal.lengthSq()>.5) {
        // The nearest local cross-section preserves the authored fabric side.
        // A ray through the entire capsule can jump to a distant end cap.
        const dx=x-nx0,dy=y-ny0,dz=z-nz0
        const along=dx*fx+dy*fy+dz*fz
        const tx=dx-fx*along,ty=dy-fy*along,tz=dz-fz*along
        const forward=Math.sqrt(Math.max(0,radius*radius-tx*tx-ty*ty-tz*tz))
        x=nx0+tx+fx*forward;y=ny0+ty+fy*forward;z=nz0+tz+fz*forward
        continue
      }

      const t=Math.max(0,Math.min(1,((x-ax)*bx+(y-ay)*by+(z-az)*bz)/(bx*bx+by*by+bz*bz)))
      const nx=ax+bx*t,ny=ay+by*t,nz=az+bz*t
      let dx=x-nx,dy=y-ny,dz=z-nz,distance=Math.sqrt(dx*dx+dy*dy+dz*dz)
      if(distance<radius) {
        if(distance<1e-8) {
          dx=previous[at]-nx;dy=previous[at+1]-ny;dz=previous[at+2]-nz
          distance=Math.sqrt(dx*dx+dy*dy+dz*dz)
          if(distance<1e-8) throw new Error('Ambiguous cloth contact at capsule axis')
        }
        const scale=radius/distance; x=nx+dx*scale;y=ny+dy*scale;z=nz+dz*scale
      }
    }
    p[at]=x;p[at+1]=Math.max(floor,y);p[at+2]=z
  }

  update(dt) {
    if(!Number.isFinite(dt)||dt<0)throw new Error('Cloth step must be finite and nonnegative')
    if(dt===0)return
    const start=performance.now()
    for(let i=0;i<this.rest.length;i++)this.oldReferences[i].copy(this.references[i])
    for(const cap of this.capsules){cap.oldA.copy(cap.a);cap.oldB.copy(cap.b)}
    this.sampleTargets(dt)
    const count=Math.ceil(dt/MAX_CLOTH_STEP),h=dt/count
    const {p,prev,velocity:v,weights:w}=this
    for(let sub=1;sub<=count;sub++){
      const time=sub/count
      for(const cap of this.capsules){cap.at.lerpVectors(cap.oldA,cap.a,time);cap.bt.lerpVectors(cap.oldB,cap.b,time)}
      for(let i=1;i<w.length;i++){
        const at=i*3,reference=this.references[i],old=this.oldReferences[i]
        for(let axis=0;axis<3;axis++){
          const target=old.getComponent(axis)+(reference.getComponent(axis)-old.getComponent(axis))*time
          const goal=axis===1?Math.max(.045,target-.015*this.data.mobility[i]):target
          p[at+axis]=w[i]===0?target:goal
        }
      }
      // Contacts shape a kinematic goal. They never displace the persistent
      // visible state or inject their correction into its velocity.
      this.shapeGoal()
      for(let i=1;i<w.length;i++){
        const at=i*3,mobility=this.data.mobility[i]
        const skirt=this.data.region[i]===1||this.data.region[i]===2
        const omega=(this.data.region[i]===4?24:skirt?8:14)+(1-mobility)*18,decay=Math.exp(-omega*h)
        const radius=.025+mobility*.22
        const reference=this.references[i],old=this.oldReferences[i]
        let length=0
        for(let axis=0;axis<3;axis++){
          const animated=old.getComponent(axis)+(reference.getComponent(axis)-old.getComponent(axis))*time
          const base=w[i]>0&&axis===1?Math.max(.045,animated):animated
          this.smoothed[at+axis]=p[at+axis]-base-(reference.getComponent(axis)-old.getComponent(axis))/dt*mobility*(skirt?.035:.012)
          length+=this.smoothed[at+axis]**2
        }
        const scale=length>radius*radius?radius/Math.sqrt(length):1
        for(let axis=0;axis<3;axis++){
          const animated=old.getComponent(axis)+(reference.getComponent(axis)-old.getComponent(axis))*time
          const base=w[i]>0&&axis===1?Math.max(.045,animated):animated
          if(w[i]===0){p[at+axis]=base;v[at+axis]=this.secondary[at+axis]=0;continue}
          const goal=this.smoothed[at+axis]*scale
          const offset=this.secondary[at+axis]-goal,coefficient=v[at+axis]+omega*offset
          this.secondary[at+axis]=goal+(offset+coefficient*h)*decay
          v[at+axis]=(v[at+axis]-omega*coefficient*h)*decay
          p[at+axis]=base+this.secondary[at+axis]
        }
        if(w[i]>0&&p[at+1]<.045){p[at+1]=.045;this.secondary[at+1]=p[at+1]-Math.max(.045,old.y+(reference.y-old.y)*time);v[at+1]=Math.max(0,v[at+1])}
        if(this.legClothByNode.has(i)&&w[i]>0) {
          nearest.lerpVectors(old,reference,time);nearest.y=Math.max(.045,nearest.y)
          sample.fromArray(p,at)
          this.legClothByNode.get(i).limitSecondary(i,nearest,sample)
          sample.y=Math.max(.045,sample.y)
          sample.toArray(p,at)
          for(let axis=0;axis<3;axis++) {
            const animated=old.getComponent(axis)+(reference.getComponent(axis)-old.getComponent(axis))*time
            const base=axis===1?Math.max(.045,animated):animated
            this.secondary[at+axis]=p[at+axis]-base
          }
        }
      }
    }
    for(let i=1;i<this.position.length;i++){
      this.position[i].fromArray(p,i*3)
      for(let axis=0;axis<3;axis++)prev[i*3+axis]=p[i*3+axis]-v[i*3+axis]*h
      this.previous[i].fromArray(prev,i*3)
    }
    this.publish(3,dt)
    this.lastCost=performance.now()-start;this.maxCost=Math.max(this.maxCost,this.lastCost)
  }

  publish(rotationIterations=3,dt=0) {
    for (let i=1;i<this.position.length;i++) this.offsets[i].copy(this.position[i]).sub(this.targets[i])
    for(let i=1;i<this.position.length;i++) {
      const covariance=this.covariance
      for(const column of covariance)column.set(0,0,0)
      for(const [j,weight] of this.neighbours[i]) {
        edge.copy(this.targets[j]).sub(this.targets[i])
        delta.copy(this.position[j]).sub(this.position[i])
        covariance[0].addScaledVector(delta,edge.x*weight)
        covariance[1].addScaledVector(delta,edge.y*weight)
        covariance[2].addScaledVector(delta,edge.z*weight)
      }
      const prior=this.rotations[i]
      rotation.set(prior.x,prior.y,prior.z,prior.w)
      fitClothRotation(covariance,rotation,rotationIterations)
      const angle=2*Math.acos(Math.min(1,Math.abs(rotation.w)))
      if(angle>Math.PI/2)rotation.slerp(identityRotation,1-(Math.PI/2)/angle)
      if(dt>0){turn.set(prior.x,prior.y,prior.z,prior.w);turn.rotateTowards(rotation,12*dt);rotation.copy(turn)}
      this.rotations[i].set(rotation.x,rotation.y,rotation.z,rotation.w)
    }
  }

  inspect(details=false) {
    let penetrations=0, maxDepth=0, floor=Infinity, maxStretch=0, maxSecondary=0, worstEdge=null
    const contacts=[]
    for (let i=1;i<this.position.length;i++) {
      if (this.weights[i]===0) continue
      const p=this.position[i]; floor=Math.min(floor,p.y)
      maxSecondary=Math.max(maxSecondary,Math.hypot(...this.secondary.subarray(i*3,i*3+3)))
      for (const cap of this.capsules) {
        if(cap.kind==='arm' && (this.data.region[i]!==4 || cap.left.name.endsWith('_l')!==(this.rest[i].x>0))) continue
        ab.copy(cap.b).sub(cap.a)
        const t=Math.max(0,Math.min(1,delta.copy(p).sub(cap.a).dot(ab)/Math.max(ab.lengthSq(),1e-10)))
        nearest.copy(cap.a).addScaledVector(ab,t)
        const depth=cap.radius-p.distanceTo(nearest)
        if(depth>.002) {
          penetrations++; maxDepth=Math.max(maxDepth,depth)
          if(details)contacts.push({node:i,region:this.data.region[i],capsule:cap.left.name,depth,point:p.toArray(),normal:this.contactNormals[i].toArray()})
        }
      }
    }
    for(const [a,b,length,stiffness] of this.data.edges) if(stiffness===1 && this.weights[a]+this.weights[b]>0) {const ratio=this.position[a].distanceTo(this.position[b])/length;if(ratio>maxStretch){maxStretch=ratio;worstEdge={a,b,length}}}
    return {particles:this.position.length,free:this.weights.filter(w=>w>0).length,penetrations,maxDepth,floor,maxStretch,maxSecondary,worstEdge,cpuMs:this.lastCost,maxCpuMs:this.maxCost,...(details?{contacts}:{})}
  }
}
