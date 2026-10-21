// Authoring only. The thigh carries the fabric to the knee; the lower hem
// hangs from that moving bend. Contacts use the fitted limb surfaces only.
import { Matrix4, Quaternion, Vector3 } from 'three/webgpu'

const axis = new Vector3(), nearest = new Vector3(), delta = new Vector3()
const point = new Vector3(), carried = new Vector3(), restKnee = new Vector3()
const restAxis = new Vector3(), currentAxis = new Vector3(), translation = new Vector3()
const pelvisRotation = new Quaternion(), correction = new Quaternion(), basis = new Matrix4(), actorInverse = new Matrix4()
const hipPosition = new Vector3(), kneePosition = new Vector3()
const freeHem = new Vector3()
const rearAxis = new Vector3()
const rearTarget = new Vector3()
const smooth = value => { const t = Math.max(0, Math.min(1, value)); return t*t*(3-2*t) }
const rayOffset=new Vector3(),projectedAxis=new Vector3(),projectedOffset=new Vector3()

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
    const t=Math.max(0,Math.min(1,projectedOffset.dot(projectedAxis)/Math.max(1e-12,projectedAxis.lengthSq())))
    const distance=projectedOffset.addScaledVector(projectedAxis,-t).length(),radius=cap.radius+padding
    if(distance>=radius+edge)continue
    const support=1-smooth((distance-radius)/edge)
    // The far intersection of an infinite line with the finite cylinder and
    // its endpoint spheres gives the actual capsule boundary in this direction.
    // Outside the silhouette, continue the tangent-axis depth through a smooth
    // footprint band, so neighbouring triangles start moving before contact.
    let far=t*axisAlong-offsetAlong
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
export function conformClothToLegs(p, capsules) {
  for(const cap of capsules) {
    if(cap.kind!=='leg')continue
    axis.subVectors(cap.b,cap.a)
    const t=Math.max(0,Math.min(1,delta.copy(p).sub(cap.a).dot(axis)/axis.lengthSq()))
    nearest.copy(cap.a).addScaledVector(axis,t);delta.copy(p).sub(nearest)
    const distance=delta.length()
    if(distance<1e-8)throw new Error('Visible cloth lies on a limb axis')
    const skin=.003+.1*cap.radius
    const mapped=distance<cap.radius ? cap.radius+.003+.1*distance : distance+skin*Math.exp(-(distance-cap.radius)/.05)
    p.copy(nearest).addScaledVector(delta,mapped/distance)
  }
  return p
}

export class ClothLegContact {
  constructor(definition, simulation) {
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
      return {cap,calf,calfLength,rearCarry:new Vector3(),hip,knee,matrix:new Matrix4(),hangingMatrix:new Matrix4(),hangingRotation:new Quaternion(),hangingPosition:new Vector3()}
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

  shape(rest, reference, out) {
    point.set(0,0,0)
    this.thighs.forEach(({cap,hip,knee,matrix,hangingMatrix,calfLength,rearCarry}, index) => {
      const weight = index === 0 ? smooth((rest.x+.08)/.16) : 1-smooth((rest.x+.08)/.16)
      carried.copy(rest).applyMatrix4(matrix)
      const dx=rest.x-hip.x,dz=rest.z-hip.z
      const radial=Math.min(1,(cap.radius+.025)/Math.max(.000001,Math.hypot(dx,dz)))
      restKnee.set(hip.x+dx*radial,knee.y,hip.z+dz*radial).applyMatrix4(hangingMatrix)
      freeHem.set(dx*(1-radial),0,dz*(1-radial)).applyMatrix4(this.hemFrame)
      restKnee.add(freeHem)
      restKnee.y -= knee.y-rest.y
      // Distribute a backward calf swing through the hanging rear panel before
      // contact. A vertical reference otherwise kinks around the raised boot.
      const rear=(1-smooth(rest.z/.08))*Math.max(0,Math.min(1,(knee.y-rest.y)/calfLength))
      restKnee.addScaledVector(rearCarry,rear)
      carried.lerp(restKnee,1-smooth((rest.y-knee.y+.07)/.14))
      const attachment = smooth((hip.y+.04-rest.y)/.18)
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
    for (const {cap,calf,rearCarry,hip,knee,matrix,hangingMatrix,hangingRotation,hangingPosition} of this.thighs) {
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
      if(dt===0) {hangingRotation.copy(correction);hangingPosition.copy(hipPosition)}
      else {
        const follow=1-Math.exp(-18*dt)
        hangingRotation.slerp(correction,follow);hangingPosition.lerp(hipPosition,follow)
      }
      translation.copy(hip).applyQuaternion(hangingRotation).negate().add(hangingPosition)
      hangingMatrix.compose(translation,hangingRotation,restAxis)
    }
    for (const i of this.nodes) {
      if (this.sim.weights[i] === 0) continue
      this.shape(this.sim.rest[i],this.sim.references[i],this.sim.references[i])
    }
  }
}
