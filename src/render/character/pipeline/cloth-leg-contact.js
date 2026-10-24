// Authoring only. The thigh carries the fabric to the knee; the lower hem
// hangs from that moving bend. Contacts use the fitted limb surfaces only.
import { Matrix4, Quaternion, Vector3 } from 'three/webgpu'

const axis = new Vector3(), nearest = new Vector3(), delta = new Vector3()
const point = new Vector3(), carried = new Vector3(), restKnee = new Vector3()
const restAxis = new Vector3(), currentAxis = new Vector3(), translation = new Vector3()
const pelvisRotation = new Quaternion(), correction = new Quaternion(), basis = new Matrix4(), actorInverse = new Matrix4()
const hipPosition = new Vector3(), kneePosition = new Vector3()
const freeHem = new Vector3(),ventRest=new Vector3()
const rearAxis = new Vector3()
const rearTarget = new Vector3()
const smooth = value => { const t = Math.max(0, Math.min(1, value)); return t*t*(3-2*t) }
const rayOffset=new Vector3(),projectedAxis=new Vector3(),projectedOffset=new Vector3()

export const CLOTH_MOTION={SKIRT:0,CENTER_PANEL:1,HIP_OVERLAY:2}

export const CLOTH_SKIN={OUTER:.006,OVERLAY:.004}

export const CENTER_PANEL={top:1.15,blend:.3}

export const REAR_VENT={edge:.12,motionEdge:.06,round:.012,motionRound:.038,ownerTop:1.13,ownerBlend:.30,motionOwnerBlend:.15,kneeStart:.2,kneeRange:.35}

export const REAR_CONTACT={edge:.06,radius:.006,gap:.003,layer:.008,release:.05,heightBlend:.12}

// Preserve the authored side of a rear sheet when a calf passes its old
// position. Nearest-point exits put neighbouring vertices on opposite sides
// of the calf: both vertices clear it, but their connecting triangle does not.
export function clearRearCloth(p,capsules,direction,weight) {
  const {edge,radius:padding,gap,layer,release}=REAR_CONTACT
  for(const cap of capsules) {
    if(cap.kind!=='leg')continue
    axis.subVectors(cap.b,cap.a);rayOffset.copy(p).sub(cap.a)
    const axisLength=axis.lengthSq(),axisAlong=axis.dot(direction),offsetAlong=rayOffset.dot(direction)
    projectedAxis.copy(axis).addScaledVector(direction,-axisAlong)
    projectedOffset.copy(rayOffset).addScaledVector(direction,-offsetAlong)
    const projectedLength=projectedAxis.lengthSq()
    const t=Math.max(0,Math.min(1,projectedOffset.dot(projectedAxis)/Math.max(1e-30,projectedLength)))
    const distance=projectedOffset.addScaledVector(projectedAxis,-t).length(),radius=cap.radius+padding
    if(distance>=radius+edge)continue
    const support=1-smooth((distance-radius)/edge)
    // The far intersection of an infinite line with the finite cylinder and
    // its endpoint spheres gives the actual capsule boundary in this direction.
    // Outside the silhouette, continue the tangent-axis depth through a smooth
    // footprint band, so neighbouring triangles start moving before contact.
    // When the projected axis is narrower than the footprint fade, its two
    // endpoint depths cannot be distinguished smoothly. Continue the far end
    // through that band, approaching the ordinary tangent depth continuously
    // as the projected axis opens. An exact-parallel branch would just move
    // the original jump to its angular threshold.
    const endOn=1-smooth(projectedLength/(edge*edge))
    let far=t*axisAlong+(Math.max(0,axisAlong)-t*axisAlong)*endOn-offsetAlong
    const axisOffset=axis.dot(rayOffset),a=axisLength-axisAlong*axisAlong
    const b=axisLength*offsetAlong-axisOffset*axisAlong
    const c=axisLength*rayOffset.lengthSq()-axisOffset*axisOffset-radius*radius*axisLength
    const discriminant=b*b-a*c
    if(a>1e-8*axisLength&&discriminant>=0) {
      const root=(-b+Math.sqrt(discriminant))/a,along=axisOffset+root*axisAlong
      if(along>=0&&along<=axisLength){far=Math.max(far,root)}
    }
    for(const center of [cap.a,cap.b]) {
      delta.copy(p).sub(center)
      const along=delta.dot(direction),discriminant=along*along-delta.lengthSq()+radius*radius
      if(discriminant>=0){far=Math.max(far,-along+Math.sqrt(discriminant))}
    }
    // A strictly monotone exit keeps separate fabric skins distinct. The
    // footprint fade starts outside the real limb, avoiding a silhouette jump.
    const correction=far>=0 ? far+gap+layer/(1+far/layer) : (gap+layer)*Math.exp(far/release)
    p.addScaledVector(direction,correction*support*weight)
  }
  return p
}

// A monotone surface map keeps a thin layer's front/back vertices distinct.
// A hard radius clamp would put both sides on one surface and cause z-fighting.
export function conformClothToBody(p, capsules, padding=CLOTH_SKIN.OVERLAY) {
  for(const cap of capsules) {
    if(cap.kind==='arm')continue
    axis.subVectors(cap.b,cap.a)
    const t=Math.max(0,Math.min(1,delta.copy(p).sub(cap.a).dot(axis)/axis.lengthSq()))
    nearest.copy(cap.a).addScaledVector(axis,t);delta.copy(p).sub(nearest)
    const distance=delta.length()
    if(distance<1e-8)throw new Error('Visible cloth lies on a limb axis')
    const radius=cap.radius+padding
    const skin=.003+.1*radius
    const mapped=distance<radius ? radius+.003+.1*distance : distance+skin*Math.exp(-(distance-radius)/.05)
    p.copy(nearest).addScaledVector(delta,mapped/distance)
  }
  return p
}

export class ClothLegContact {
  constructor(definition, simulation) {
    if(!Object.values(CLOTH_MOTION).includes(definition.motion))throw new Error('Rebuild cloth data: garment motion profile is required')
    this.motion=definition.motion
    this.sim = simulation
    this.nodes = definition.nodes
    this.padding = definition.padding
    if (!(this.padding>0) || !this.nodes.length || this.nodes.some(i=>!Number.isInteger(i)||i<=0||i>=simulation.rest.length||!Number.isFinite(simulation.data.clearance[i])||simulation.data.clearance[i]<0)) {
      throw new Error('Invalid fitted leg cloth definition')
    }
    this.hemFrame = new Matrix4()
    this.thighs = ['l', 'r'].map(side => {
      const index = simulation.capsules.findIndex(cap => cap.left.name === 'thigh_'+side)
      if (index < 0) throw new Error('Missing fitted thigh: '+side)
      const cap = simulation.capsules[index]
      const calfIndex=simulation.capsules.findIndex(cap=>cap.left.name==='calf_'+side)
      if(calfIndex<0)throw new Error('Missing fitted calf: '+side)
      const calf=simulation.capsules[calfIndex]
      const calfLength=new Vector3(...simulation.data.colliderRest[calfIndex][0]).distanceTo(new Vector3(...simulation.data.colliderRest[calfIndex][1]))
      const hip = new Vector3().setFromMatrixPosition(simulation.skinMatrices.get(cap.left).bind.clone().invert())
      const knee = new Vector3().setFromMatrixPosition(simulation.skinMatrices.get(cap.right).bind.clone().invert())
      return {cap,calf,calfLength,rearCarry:new Vector3(),rearOpening:new Vector3(),hip,knee,matrix:new Matrix4(),hangingMatrix:new Matrix4(),hangingRotation:new Quaternion(),hangingPosition:new Vector3()}
    })
    this.pelvis=simulation.actor.getObjectByName('pelvis')
    if (!this.pelvis?.isBone) throw new Error('Missing skirt attachment: pelvis')
    this.contacts = new Map(this.nodes.map(i => {
      const rest = simulation.rest[i], contacts = []
      simulation.capsules.forEach((cap, index) => {
        if (cap.kind !== 'leg') return
        if (Math.abs(rest.x) > .08 && cap.left.name.endsWith('_l') !== (rest.x > 0)) return
        const [a,b] = simulation.data.colliderRest[index].map(p => new Vector3(...p))
        axis.subVectors(b,a)
        const t = delta.copy(rest).sub(a).dot(axis)/axis.lengthSq()
        if (t < -.06/axis.length() || t > 1+.06/axis.length()) return
        contacts.push({cap})
      })
      return [i,contacts]
    }))
  }

  limitSecondary(i, base, p) {
    // Limit inward lag relative to the reference. These half-spaces contain
    // the zero offset, so they cannot increase the secondary travel budget.
    // They do not certify the reference itself against the visible body mesh.
    const gap = this.padding + this.sim.data.clearance[i]
    for (let pass = 0; pass < 2; pass++) for (const {cap} of this.contacts.get(i)) {
      axis.subVectors(cap.bt,cap.at)
      const t = Math.max(0,Math.min(1,delta.copy(base).sub(cap.at).dot(axis)/axis.lengthSq()))
      nearest.copy(cap.at).addScaledVector(axis,t)
      delta.copy(base).sub(nearest)
      const distance = delta.length(), radius = cap.radius+gap
      if (distance < 1e-8) throw new Error('Cloth reference lies on the limb axis')
      delta.multiplyScalar(1/distance)
      const available = Math.max(0,distance-radius)
      const inward = -point.copy(p).sub(base).dot(delta)
      if (inward > available) p.addScaledVector(delta,inward-available)
    }
    return p
  }

  shape(rest, reference, out,side=0,motion=CLOTH_MOTION.SKIRT) {
    if(motion===CLOTH_MOTION.HIP_OVERLAY)return out.copy(reference)
    const centerPanel=motion===CLOTH_MOTION.CENTER_PANEL
    const vent=(1-smooth(rest.z/.08))*(1-smooth((rest.y-.55)/.58))*Math.abs(side)
    const ownerBlend=REAR_VENT.ownerBlend+REAR_VENT.motionOwnerBlend*this.thighs[side>0?0:1].rearOpening.y
    point.set(0,0,0)
    this.thighs.forEach(({cap,hip,knee,matrix,hangingMatrix,calfLength,rearCarry,rearOpening}, index) => {
      const own=(1-smooth(rest.z/.08))*Math.abs(side)*smooth((REAR_VENT.ownerTop-rest.y)/ownerBlend)
      let left=smooth((rest.x+.08)/.16)*(1-own)+(side>0?1:0)*own
      // One tabard is a single sheet: opposing leg frames must not pull
      // neighbouring columns in different directions.
      if(centerPanel)left=.5
      const weight=index===0?left:1-left
      const yaw=-side*rearOpening.x*vent,c=Math.cos(yaw),s=Math.sin(yaw),x=rest.x-hip.x,z=rest.z-hip.z
      ventRest.set(hip.x+x*c+z*s,rest.y,hip.z-x*s+z*c)
      carried.copy(ventRest).applyMatrix4(matrix)
      const dx=ventRest.x-hip.x,dz=ventRest.z-hip.z
      const radial=Math.min(1,(cap.radius+.025)/Math.max(.000001,Math.hypot(dx,dz)))
      restKnee.set(hip.x+dx*radial,knee.y,hip.z+dz*radial).applyMatrix4(hangingMatrix)
      freeHem.set(dx*(1-radial),0,dz*(1-radial)).applyMatrix4(this.hemFrame)
      restKnee.add(freeHem)
      restKnee.y -= knee.y-rest.y
      // Distribute a backward calf swing through the hanging rear panel before
      // contact. A vertical reference otherwise kinks around the raised boot.
      const rear=(1-smooth(rest.z/.08))*Math.max(0,Math.min(1,(knee.y-rest.y)/calfLength))
      restKnee.addScaledVector(rearCarry,rear*(1-Math.abs(side)))
      carried.lerp(restKnee,1-smooth((rest.y-knee.y+.12)/.24))
      const attachment = centerPanel?smooth((CENTER_PANEL.top-rest.y)/CENTER_PANEL.blend):smooth((hip.y+.16-rest.y)/.30)
      carried.lerp(reference, 1-attachment)
      point.addScaledVector(carried, weight)
    })
    return out.copy(point)
  }

  sample(dt=0) {
    actorInverse.copy(this.sim.actor.matrixWorld).invert()
    basis.extractRotation(this.sim.skinMatrices.get(this.pelvis).matrix)
    pelvisRotation.setFromRotationMatrix(basis)
    this.hemFrame.copy(basis)
    rearAxis.set(0,0,-1).transformDirection(this.hemFrame)
    for (const {cap,calf,calfLength,rearCarry,rearOpening,hip,knee,matrix,hangingMatrix,hangingRotation,hangingPosition} of this.thighs) {
      const lead=dt>0?Math.min(2,.04/dt):0
      rearTarget.copy(calf.b).addScaledVector(axis.subVectors(calf.b,calf.oldB),lead).sub(cap.a)
      const behind=smooth((rearTarget.dot(rearAxis)-.12)/.20)
      const heelRelease=behind*smooth((axis.subVectors(calf.b,calf.a).dot(rearAxis)/calfLength-.05)/.5)
      // A forward knee can catch the back tail even while its ankle is
      // still ahead of the hip. Release for that bend as well as the heel.
      const forward=-axis.subVectors(cap.b,cap.a).normalize().dot(rearAxis)
      const kneeRelease=smooth((forward-REAR_VENT.kneeStart)/REAR_VENT.kneeRange)
      const release=1-(1-heelRelease)*(1-kneeRelease)
      if(dt===0)rearOpening.set(release,release,0)
      else rearOpening.lerp(translation.set(release,release,0),1-Math.exp(-18*dt))
      rearTarget.copy(rearAxis).multiplyScalar(Math.max(0,axis.subVectors(calf.b,calf.a).dot(rearAxis)))
      if(dt===0)rearCarry.copy(rearTarget)
      else rearCarry.lerp(rearTarget,1-Math.exp(-18*dt))
      restAxis.subVectors(knee,hip).normalize().applyQuaternion(pelvisRotation)
      cap.left.getWorldPosition(hipPosition).applyMatrix4(actorInverse)
      cap.right.getWorldPosition(kneePosition).applyMatrix4(actorInverse)
      currentAxis.subVectors(kneePosition,hipPosition).normalize()
      correction.setFromUnitVectors(restAxis,currentAxis).multiply(pelvisRotation)
      translation.copy(hip).applyQuaternion(correction).negate().add(hipPosition)
      matrix.compose(translation,correction,restAxis.set(1,1,1))
      if(dt===0) hangingRotation.copy(correction)
      else {
        const follow=1-Math.exp(-18*dt)
        hangingRotation.slerp(correction,follow)
      }
      // Rotation trails the thigh; the support point stays on the actual knee.
      // Lagging that point as well stretched the blend across two different knees.
      hangingPosition.copy(kneePosition)
      translation.copy(knee).applyQuaternion(hangingRotation).negate().add(hangingPosition)
      hangingMatrix.compose(translation,hangingRotation,restAxis)
    }
    for (const i of this.nodes) {
      if (this.sim.weights[i] === 0) continue
      this.shape(this.sim.rest[i],this.sim.references[i],this.sim.references[i],0,this.motion)
    }
  }
}

// Conservative, rounded lateral envelope for the split rear tails. The cylinder
// and endpoint support are both outer bounds; their minimum avoids an end-on
// singularity without choosing a different side of the leg.
export function clearVentedRearCloth(p,capsules,direction,weight,release) {
 const {edge:baseEdge,motionEdge,round:baseRound,motionRound}=REAR_VENT
 const {radius:padding,gap,layer,release:fade}=REAR_CONTACT
 const round=baseRound+motionRound*release,edge=baseEdge+motionEdge*release
 for(const cap of capsules) {
  if(cap.kind!=='leg')continue
  axis.subVectors(cap.b,cap.a);rayOffset.copy(p).sub(cap.a)
  const axisLength=axis.lengthSq(),along=axis.dot(direction),offsetAlong=rayOffset.dot(direction)
  projectedAxis.copy(axis).addScaledVector(direction,-along)
  projectedOffset.copy(rayOffset).addScaledVector(direction,-offsetAlong)
  const planeLength=projectedAxis.lengthSq(),t=Math.max(0,Math.min(1,projectedOffset.dot(projectedAxis)/Math.max(1e-30,planeLength)))
  const distance=projectedOffset.addScaledVector(projectedAxis,-t).length(),radius=cap.radius+padding
  if(distance>=radius+edge)continue
  const d=radius*radius-distance*distance
  const root=Math.sqrt((d+Math.sqrt(d*d+4*round**4))/2)
  const far=Math.min(t*along+root*Math.sqrt(axisLength/Math.max(1e-30,planeLength)),Math.max(0,along)+radius+round)-offsetAlong
  const correction=far>=0?far+gap+layer/(1+far/layer):(gap+layer)*Math.exp(far/fade)
  p.addScaledVector(direction,correction*(1-smooth((distance-radius)/edge))*weight)
 }
 return p
}
