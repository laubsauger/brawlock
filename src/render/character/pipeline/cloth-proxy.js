// Authoring viewer only. A small persistent PBD surface drives each render LOD.
import { Matrix4, Quaternion, Vector3, Vector4 } from 'three/webgpu'
import { uniformArray } from 'three/tsl'

const stepSize = 1 / 60
const ab = new Vector3(), nearest = new Vector3(), delta = new Vector3()
const inverse = new Matrix4(), sample = new Vector3()
const normalA = new Vector3(), normalB = new Vector3(), edge = new Vector3(), rotation = new Quaternion()

export class ClothProxy {
  constructor(data, actor, definitions) {
    if (data.version !== 1 || data.positions.length > 512) throw new Error('Unsupported cloth proxy')
    this.data = data
    this.actor = actor
    this.rest = data.positions.map(p => new Vector3(...p))
    this.targets = this.rest.map(p => p.clone())
    this.oldTargets = this.rest.map(p => p.clone())
    this.position = this.rest.map(p => p.clone())
    this.previous = this.rest.map(p => p.clone())
    this.offsets = this.rest.map(() => new Vector3())
    this.rotations = this.rest.map(() => new Vector4(0, 0, 0, 1))
    this.targetNormals = this.rest.map(() => new Vector3())
    this.simulatedNormals = this.rest.map(() => new Vector3())
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
    this.capsules = definitions.map(([left,right,radius,kind]) => {
      const a = actor.getObjectByName(left), b = actor.getObjectByName(right)
      if (!a?.isBone || !b?.isBone) throw new Error('Missing cloth collision joint')
      return {left:a,right:b,radius,kind,a:new Vector3(),b:new Vector3(),oldA:new Vector3(),oldB:new Vector3(),at:new Vector3(),bt:new Vector3()}
    })
    this.p = new Float64Array(data.positions.flat())
    this.prev = new Float64Array(this.p)
    this.edgeData = new Float64Array(data.edges.flat())
    this.initialized = false
    this.lastCost = 0
    this.maxCost = 0
    this.reset()
  }

  sampleTargets() {
    inverse.copy(this.actor.matrixWorld).invert()
    for (const [bone, value] of this.skinMatrices) value.matrix.multiplyMatrices(inverse,bone.matrixWorld).multiply(value.bind)
    for (let i=1; i<this.rest.length; i++) {
      const p=this.targets[i]; p.set(0,0,0)
      for (const {bone, weight} of this.skin[i]) {
        sample.copy(this.rest[i]).applyMatrix4(this.skinMatrices.get(bone).matrix)
        p.addScaledVector(sample,weight)
      }
    }
    for (const cap of this.capsules) {
      cap.left.getWorldPosition(cap.a).applyMatrix4(inverse)
      cap.right.getWorldPosition(cap.b).applyMatrix4(inverse)
    }
  }

  reset() {
    this.actor.updateMatrixWorld(true)
    this.sampleTargets()
    for (let i=0;i<this.rest.length;i++) {
      this.position[i].copy(this.targets[i]); this.previous[i].copy(this.targets[i]); this.oldTargets[i].copy(this.targets[i])
      this.offsets[i].set(0,0,0)
    }
    for (const cap of this.capsules) { cap.oldA.copy(cap.a); cap.oldB.copy(cap.b) }
    for(let i=0;i<this.position.length;i++) {
      this.position[i].toArray(this.p,i*3); this.position[i].toArray(this.prev,i*3)
    }
    this.initialized = true
    this.publish()
  }

  projectParticle(i) {
    const at=i*3,p=this.p,region=this.data.region[i]
    let x=p[at],y=p[at+1],z=p[at+2]
    for(const cap of this.capsules) {
      if(region===4 ? cap.kind!=='arm' : cap.kind==='arm') continue
      const ax=cap.at.x,ay=cap.at.y,az=cap.at.z,bx=cap.bt.x-ax,by=cap.bt.y-ay,bz=cap.bt.z-az
      const t=Math.max(0,Math.min(1,((x-ax)*bx+(y-ay)*by+(z-az)*bz)/(bx*bx+by*by+bz*bz)))
      const nx=ax+bx*t,ny=ay+by*t,nz=az+bz*t
      let dx=x-nx,dy=y-ny,dz=z-nz,distance=Math.sqrt(dx*dx+dy*dy+dz*dz)
      const radius=cap.radius+(region===1 ? .022 : .013)
      if(distance<radius) {
        if(distance<1e-8) {
          dx=this.prev[at]-nx;dy=this.prev[at+1]-ny;dz=this.prev[at+2]-nz
          distance=Math.sqrt(dx*dx+dy*dy+dz*dz)
          if(distance<1e-8) throw new Error('Ambiguous cloth contact at capsule axis')
        }
        const scale=radius/distance; x=nx+dx*scale;y=ny+dy*scale;z=nz+dz*scale
      }
    }
    p[at]=x;p[at+1]=Math.max(.045,y);p[at+2]=z
  }

  update(dt) {
    if (dt <= 0) return
    const start = performance.now()
    for (let i=0;i<this.rest.length;i++) this.oldTargets[i].copy(this.targets[i])
    for (const cap of this.capsules) { cap.oldA.copy(cap.a); cap.oldB.copy(cap.b) }
    this.sampleTargets()
    const count = Math.ceil(dt / stepSize), h = dt / count
    const {p, prev, weights:w} = this
    const damping = Math.exp(-1.8*h)
    const retention = 1-Math.exp(-.48*h/4)
    const bending = 1-Math.pow(1-.08,h*60)
    for (let sub=1;sub<=count;sub++) {
      const t = sub / count
      for (const cap of this.capsules) { cap.at.lerpVectors(cap.oldA,cap.a,t); cap.bt.lerpVectors(cap.oldB,cap.b,t) }
      for (let i=1;i<w.length;i++) {
        const at=i*3, target=this.targets[i], old=this.oldTargets[i]
        if (w[i]===0) {
          p[at]=old.x+(target.x-old.x)*t; p[at+1]=old.y+(target.y-old.y)*t; p[at+2]=old.z+(target.z-old.z)*t
          prev[at]=p[at]; prev[at+1]=p[at+1]; prev[at+2]=p[at+2]
          continue
        }
        for(let axis=0;axis<3;axis++) {
          const oldValue=p[at+axis]
          p[at+axis]+=(p[at+axis]-prev[at+axis])*damping+(axis===1 ? -2.5*h*h : 0)
          prev[at+axis]=oldValue
        }
      }
      for(let iteration=0;iteration<4;iteration++) {
        const edges=this.edgeData
        for(let e=0;e<edges.length;e+=4) {
          const a=edges[e],b=edges[e+1],mass=w[a]+w[b]
          if(mass===0) continue
          const ai=a*3,bi=b*3,dx=p[bi]-p[ai],dy=p[bi+1]-p[ai+1],dz=p[bi+2]-p[ai+2]
          const distance=Math.sqrt(dx*dx+dy*dy+dz*dz)
          if(distance<1e-8) continue
          const correction=(distance-edges[e+2])/distance*(edges[e+3]===1 ? 1 : bending)/mass
          const wa=w[a]*correction,wb=w[b]*correction
          p[ai]+=dx*wa; p[ai+1]+=dy*wa; p[ai+2]+=dz*wa
          p[bi]-=dx*wb; p[bi+1]-=dy*wb; p[bi+2]-=dz*wb
        }
        for(let i=1;i<w.length;i++) {
          if(w[i]===0) continue
          const at=i*3,target=this.targets[i],old=this.oldTargets[i]
          const tx=old.x+(target.x-old.x)*t,ty=old.y+(target.y-old.y)*t,tz=old.z+(target.z-old.z)*t
          const dx=p[at]-tx,dy=p[at+1]-ty,dz=p[at+2]-tz
          const limit=.025+this.data.mobility[i]*.5,distance=Math.sqrt(dx*dx+dy*dy+dz*dz)
          if(distance>limit) { const scale=limit/distance; p[at]=tx+dx*scale; p[at+1]=ty+dy*scale; p[at+2]=tz+dz*scale }
          p[at]+=(tx-p[at])*retention; p[at+1]+=(ty-p[at+1])*retention; p[at+2]+=(tz-p[at+2])*retention
          this.projectParticle(i)
        }
      }
      // Overlapping knee/foot capsules and the floor must all remain satisfied;
      // projecting onto a later collider can re-enter an earlier one.
      for(let pass=0;pass<6;pass++) for(let i=1;i<w.length;i++) if(w[i]>0) this.projectParticle(i)
    }
    for(let i=1;i<w.length;i++) {
      this.position[i].fromArray(p,i*3); this.previous[i].fromArray(prev,i*3)
    }
    this.publish()
    this.lastCost = performance.now()-start
    this.maxCost = Math.max(this.maxCost,this.lastCost)
  }

  publish() {
    for (let i=1;i<this.position.length;i++) this.offsets[i].copy(this.position[i]).sub(this.targets[i])
    for(let i=0;i<this.position.length;i++) {this.targetNormals[i].set(0,0,0);this.simulatedNormals[i].set(0,0,0)}
    for (let i=1;i<this.data.triangles.length;i++) {
      const [a,b,c]=this.data.triangles[i]
      normalA.copy(this.targets[b]).sub(this.targets[a]).cross(edge.copy(this.targets[c]).sub(this.targets[a]))
      normalB.copy(this.position[b]).sub(this.position[a]).cross(edge.copy(this.position[c]).sub(this.position[a]))
      for(const vertex of [a,b,c]) {this.targetNormals[vertex].add(normalA);this.simulatedNormals[vertex].add(normalB)}
    }
    for(let i=1;i<this.position.length;i++) {
      normalA.copy(this.targetNormals[i]).normalize();normalB.copy(this.simulatedNormals[i]).normalize()
      rotation.setFromUnitVectors(normalA,normalB)
      this.rotations[i].set(rotation.x,rotation.y,rotation.z,rotation.w)
    }
  }

  inspect() {
    let penetrations=0, maxDepth=0, floor=Infinity, maxStretch=0, worstEdge=null
    for (let i=1;i<this.position.length;i++) {
      if (this.weights[i]===0) continue
      const p=this.position[i]; floor=Math.min(floor,p.y)
      for (const cap of this.capsules) {
        if (this.data.region[i]===4 ? cap.kind!=='arm' : cap.kind==='arm') continue
        ab.copy(cap.b).sub(cap.a)
        const t=Math.max(0,Math.min(1,delta.copy(p).sub(cap.a).dot(ab)/Math.max(ab.lengthSq(),1e-10)))
        nearest.copy(cap.a).addScaledVector(ab,t)
        const depth=cap.radius-p.distanceTo(nearest)
        if(depth>.002) { penetrations++; maxDepth=Math.max(maxDepth,depth) }
      }
    }
    for(const [a,b,length,stiffness] of this.data.edges) if(stiffness===1 && this.weights[a]+this.weights[b]>0) {const ratio=this.position[a].distanceTo(this.position[b])/length;if(ratio>maxStretch){maxStretch=ratio;worstEdge={a,b,length}}}
    return {particles:this.position.length,free:this.weights.filter(w=>w>0).length,penetrations,maxDepth,floor,maxStretch,worstEdge,cpuMs:this.lastCost,maxCpuMs:this.maxCost}
  }
}
