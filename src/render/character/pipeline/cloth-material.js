// Shared by the motion review and the game character adapter.
import * as THREE from 'three/webgpu'
import { Fn, If, abs, attribute, clamp, cos, sin, cross, dot, exp, float, length, max, min, mix, normalLocal, positionLocal, select, smoothstep, sqrt, texture, uniform, vec2, vec3, vec4 } from 'three/tsl'
import { clothPrimaryFreedom } from './cloth-proxy.js'
import { REAR_CONTACT, REAR_VENT, CENTER_PANEL, CLOTH_MOTION, CLOTH_SKIN } from './cloth-leg-contact.js'

// GPU counterpart of clearRearCloth, using the same contact profile constants.
function clearRearClothNode(position,capsules,direction,weight) {
  const {edge,radius:padding,gap,layer,release}=REAR_CONTACT
  for(const {a,b,radius:bodyRadius} of capsules) {
    const axis=b.sub(a),offset=position.sub(a).toVar()
    const axisLength=dot(axis,axis),axisAlong=dot(axis,direction),offsetAlong=dot(offset,direction)
    const planeAxis=axis.sub(direction.mul(axisAlong)),planeOffset=offset.sub(direction.mul(offsetAlong))
    const planeLength=dot(planeAxis,planeAxis)
    const t=clamp(dot(planeOffset,planeAxis).div(max(planeLength,1e-30)),0,1)
    const distance=length(planeOffset.sub(planeAxis.mul(t))),radius=bodyRadius+padding
    If(distance.lessThan(radius+edge),()=>{
      const support=float(1).sub(smoothstep(radius,radius+edge,distance))
      const endOn=float(1).sub(smoothstep(0,edge*edge,planeLength))
      const far=mix(t.mul(axisAlong),max(0,axisAlong),endOn).sub(offsetAlong).toVar()
      const axisOffset=dot(axis,offset),coefA=axisLength.sub(axisAlong.mul(axisAlong))
      const coefB=axisLength.mul(offsetAlong).sub(axisOffset.mul(axisAlong))
      const coefC=axisLength.mul(dot(offset,offset)).sub(axisOffset.mul(axisOffset)).sub(axisLength.mul(radius*radius))
      const discriminant=coefB.mul(coefB).sub(coefA.mul(coefC))
      If(coefA.greaterThan(axisLength.mul(1e-8)).and(discriminant.greaterThanEqual(0)),()=>{
        const root=coefB.negate().add(sqrt(discriminant)).div(coefA)
        const along=axisOffset.add(root.mul(axisAlong))
        If(along.greaterThanEqual(0).and(along.lessThanEqual(axisLength)),()=>far.assign(max(far,root)))
      })
      for(const center of [a,b]) {
        const relative=position.sub(center),along=dot(relative,direction)
        const discriminant=along.mul(along).sub(dot(relative,relative)).add(radius*radius)
        If(discriminant.greaterThanEqual(0),()=>far.assign(max(far,along.negate().add(sqrt(discriminant)))))
      }
      const correction=float(0).toVar()
      If(far.greaterThanEqual(0),()=>correction.assign(far.add(gap).add(float(layer).div(float(1).add(far.div(layer))))))
        .Else(()=>correction.assign(exp(far.div(release)).mul(gap+layer)))
      position.assign(position.add(direction.mul(correction.mul(support).mul(weight))))
    })
  }
}

function clearVentedRearClothNode(position,capsules,direction,weight,release) {
 const {edge:baseEdge,motionEdge,round:baseRound,motionRound}=REAR_VENT
 const {gap,layer,release:fade}=REAR_CONTACT
 const round=float(baseRound).add(release.mul(motionRound)),edge=float(baseEdge).add(release.mul(motionEdge))
 for(const {a,b,ventRadius:radius} of capsules) {
  const axis=b.sub(a),offset=position.sub(a).toVar(),axisLength=dot(axis,axis),along=dot(axis,direction),offsetAlong=dot(offset,direction)
  const planeAxis=axis.sub(direction.mul(along)),planeOffset=offset.sub(direction.mul(offsetAlong)),planeLength=dot(planeAxis,planeAxis)
  const t=clamp(dot(planeOffset,planeAxis).div(max(planeLength,1e-30)),0,1)
  const distance=length(planeOffset.sub(planeAxis.mul(t)))
  If(distance.lessThan(float(radius).add(edge)),()=>{
   const d=float(radius*radius).sub(distance.mul(distance))
   const root=sqrt(max(0,d.add(sqrt(d.mul(d).add(round.pow(4).mul(4)))).mul(.5)))
   const far=min(t.mul(along).add(root.mul(sqrt(axisLength.div(max(planeLength,1e-30))))),max(0,along).add(radius).add(round)).sub(offsetAlong)
   const correction=float(0).toVar()
   If(far.greaterThanEqual(0),()=>correction.assign(far.add(gap).add(float(layer).div(float(1).add(far.div(layer))))))
    .Else(()=>correction.assign(exp(far.div(fade)).mul(gap+layer)))
   position.addAssign(direction.mul(correction).mul(float(1).sub(smoothstep(radius,float(radius).add(edge),distance))).mul(weight))
  })
 }
}

export function attachClothMaterial(mesh, simulation, clothEnabled, attachLook) {
  const imported = mesh.material
  const material = new THREE.MeshPhysicalNodeMaterial()
  material.color.copy(imported.color)
  material.map = imported.map
  mesh.userData.sourceMap = imported.map
  material.normalMap = imported.normalMap
  mesh.userData.bakedNormalMap = imported.normalMap
  material.roughness = imported.roughness
  material.metalness = imported.metalness
  material.specularIntensity = imported.specularIntensity ?? 1
  if (imported.specularColor) material.specularColor.copy(imported.specularColor)
  if(imported.name.startsWith('Tripo_Fabric')) {
    const albedo=texture(imported.map)
    const trim=smoothstep(.06,.20,albedo.r.sub(max(albedo.g,albedo.b)))
    material.roughnessNode=mix(.96,.75,trim)
    material.specularIntensityNode=mix(.17,.32,trim)
    material.sheen=.22;material.sheenColor.set('#342a3a');material.sheenRoughness=.9
  }
  material.side = THREE.DoubleSide
  attachLook(material,imported)
  const legCloth=simulation.legCloth[0]
  const hemFrame=uniform(legCloth.hemFrame)
  const bodyCapsules=simulation.capsules.filter(cap=>cap.kind==='leg'||cap.kind==='body').map(cap=>({kind:cap.kind,a:uniform(cap.a),b:uniform(cap.b),radius:cap.radius,ventRadius:cap.radius+REAR_CONTACT.radius}))
  const legCapsules=bodyCapsules.filter(cap=>cap.kind==='leg')
  const limbs=legCloth.thighs.map(({cap,matrix,hangingMatrix,hip,knee,calfLength,rearCarry,rearOpening})=>({
    opening:uniform(rearOpening),thigh:uniform(matrix),hanging:uniform(hangingMatrix),rearCarry:uniform(rearCarry),calfLength,hip:hip.y,knee:knee.y,hipX:hip.x,hipZ:hip.z,radius:cap.radius+.025
  }))
  material.positionNode = Fn(() => {
    const indices = attribute('_wl_proxy_indices', 'vec3')
    const weights = attribute('_wl_proxy_weights', 'vec3')
    const freedom = smoothstep(0, .12, attribute('_wl_proxy_freedom','float'))
    const primaryFreedom=attribute('_wl_proxy_primary','float')
    const region=attribute('_wl_proxy_region','float')
    const skirt=select(region.equal(1).or(region.equal(2)),1,0)
    const collisionSkin=select(region.equal(1),CLOTH_SKIN.OUTER,CLOTH_SKIN.OVERLAY)
    const source=attribute('position','vec3')
    const sourceNormal=attribute('normal','vec3')
    const rearSide=attribute('_wl_rear_side','float'),motion=attribute('_wl_motion_profile','float')
    const centerPanel=select(motion.equal(CLOTH_MOTION.CENTER_PANEL),1,0),hipOverlay=select(motion.equal(CLOTH_MOTION.HIP_OVERLAY),1,0)
    const vent=float(1).sub(smoothstep(.55,1.13,source.y)).mul(float(1).sub(smoothstep(0,.08,source.z))).mul(abs(rearSide))
    const primaryLegs=limbs.map(({thigh,hanging,hip,knee,hipX,hipZ,radius,rearCarry,calfLength,opening})=>{
      const yaw=rearSide.negate().mul(opening.x).mul(vent),c=cos(yaw),s=sin(yaw),x=source.x.sub(hipX),z=source.z.sub(hipZ)
      const turned=vec3(float(hipX).add(x.mul(c)).add(z.mul(s)),source.y,float(hipZ).sub(x.mul(s)).add(z.mul(c)))
      const turnedNormal=vec3(sourceNormal.x.mul(c).add(sourceNormal.z.mul(s)),sourceNormal.y,sourceNormal.z.mul(c).sub(sourceNormal.x.mul(s)))
      const upper=thigh.mul(vec4(turned,1)).xyz
      const radialOffset=vec2(turned.x.sub(hipX),turned.z.sub(hipZ))
      const radial=min(1,float(radius).div(max(length(radialOffset),.000001)))
      const carriedRadial=radialOffset.mul(radial),freeRadial=radialOffset.mul(float(1).sub(radial))
      const lower=hanging.mul(vec4(float(hipX).add(carriedRadial.x),knee,float(hipZ).add(carriedRadial.y),1)).xyz
        .add(hemFrame.mul(vec4(freeRadial.x,0,freeRadial.y,0)).xyz).sub(vec3(0,float(knee).sub(source.y),0))
        .add(rearCarry.mul(float(1).sub(smoothstep(0,.08,source.z))).mul(clamp(float(knee).sub(source.y).div(calfLength),0,1)).mul(float(1).sub(abs(rearSide))))
      const bend=float(1).sub(smoothstep(knee-.12,knee+.12,source.y))
      const attachment=mix(float(1).sub(smoothstep(hip-.14,hip+.16,source.y)),float(1).sub(smoothstep(CENTER_PANEL.top-CENTER_PANEL.blend,CENTER_PANEL.top,source.y)),centerPanel)
      const position=mix(positionLocal,mix(upper,lower,bend),attachment)
      const limbNormal=mix(thigh.mul(vec4(turnedNormal,0)).xyz,hemFrame.mul(vec4(turnedNormal,0)).xyz,bend).normalize()
      return {position,normal:mix(normalLocal,limbNormal,attachment).normalize()}
    })
    const tailRelease=mix(limbs[1].opening.y,limbs[0].opening.y,select(rearSide.greaterThan(0),1,0))
    const ownerBlend=float(REAR_VENT.ownerBlend).add(tailRelease.mul(REAR_VENT.motionOwnerBlend))
    const own=float(1).sub(smoothstep(0,.08,source.z)).mul(abs(rearSide)).mul(float(1).sub(smoothstep(float(REAR_VENT.ownerTop).sub(ownerBlend),REAR_VENT.ownerTop,source.y)))
    const leftWeight=mix(mix(smoothstep(-.08,.08,source.x),select(rearSide.greaterThan(0),1,0),own),.5,centerPanel)
    const legPosition=mix(mix(primaryLegs[1].position,primaryLegs[0].position,leftWeight),positionLocal,hipOverlay)
    const legNormal=mix(mix(primaryLegs[1].normal,primaryLegs[0].normal,leftWeight).normalize(),normalLocal,hipOverlay)
    const offset = simulation.offsetNode.element(indices.x.toUint()).mul(weights.x)
      .add(simulation.offsetNode.element(indices.y.toUint()).mul(weights.y))
      .add(simulation.offsetNode.element(indices.z.toUint()).mul(weights.z))
    const primary=simulation.primaryOffsetNode.element(indices.x.toUint()).mul(weights.x)
      .add(simulation.primaryOffsetNode.element(indices.y.toUint()).mul(weights.y))
      .add(simulation.primaryOffsetNode.element(indices.z.toUint()).mul(weights.z))
    const qa=simulation.rotationNode.element(indices.x.toUint())
    const qb=simulation.rotationNode.element(indices.y.toUint())
    const qc=simulation.rotationNode.element(indices.z.toUint())
    const q=qa.mul(weights.x)
      .add(qb.mul(weights.y).mul(select(dot(qa,qb).lessThan(0),-1,1)))
      .add(qc.mul(weights.z).mul(select(dot(qa,qc).lessThan(0),-1,1))).normalize()
    const rotated = normalLocal.add(cross(q.xyz,cross(q.xyz,normalLocal).add(normalLocal.mul(q.w))).mul(2))
    normalLocal.assign(mix(normalLocal,mix(rotated,legNormal,skirt),primaryFreedom.mul(clothEnabled)).normalize())
    const anchor = simulation.targetNode.element(indices.x.toUint()).mul(weights.x)
      .add(simulation.targetNode.element(indices.y.toUint()).mul(weights.y))
      .add(simulation.targetNode.element(indices.z.toUint()).mul(weights.z))
    const residual = positionLocal.sub(anchor)
    const rotatedResidual = residual.add(cross(q.xyz,cross(q.xyz,residual).add(residual.mul(q.w))).mul(2))
    const primaryDeformation=mix(primary.add(rotatedResidual.sub(residual)),legPosition.sub(positionLocal),skirt)
    const deformation=offset.sub(primary).mul(freedom).add(primaryDeformation.mul(primaryFreedom))
    const deformed=positionLocal.add(deformation.mul(clothEnabled)).toVar()
    If(skirt.mul(primaryFreedom).mul(clothEnabled).greaterThan(0),()=>{
      const ventWeight=float(1).sub(smoothstep(.95,1.13,source.y))
      const legacyWeight=float(1).sub(smoothstep(limbs[0].knee,limbs[0].knee+REAR_CONTACT.heightBlend,source.y))
      const rearWeight=float(1).sub(smoothstep(0,.08,source.z)).mul(mix(legacyWeight,ventWeight,abs(rearSide))).mul(primaryFreedom)
      const radialWeight=primaryFreedom.sub(rearWeight.mul(abs(rearSide)))
      If(radialWeight.greaterThan(0),()=>{
      const conformed=deformed.toVar()
      for(const {a,b,radius:bodyRadius} of bodyCapsules) {
        const radius=float(bodyRadius).add(collisionSkin)
        const axis=b.sub(a),t=clamp(dot(conformed.sub(a),axis).div(dot(axis,axis)),0,1)
        const nearest=a.add(axis.mul(t)),radial=conformed.sub(nearest).toVar(),distance=length(radial).toVar()
        const mapped=select(distance.lessThan(radius),radius.add(.003).add(distance.mul(.1)),distance.add(exp(distance.sub(radius).negate().div(.05)).mul(radius.mul(.1).add(.003))))
        conformed.assign(nearest.add(radial.mul(mapped.div(distance))))
      }
      deformed.assign(mix(deformed,conformed,radialWeight.mul(clothEnabled)))
      })
      If(rearWeight.greaterThan(0),()=>{
       const direction=hemFrame.mul(vec4(rearSide,0,abs(rearSide).sub(1),0)).xyz.normalize()
       If(abs(rearSide).greaterThan(0),()=>clearVentedRearClothNode(deformed,legCapsules,direction,rearWeight,tailRelease))
        .Else(()=>clearRearClothNode(deformed,legCapsules,direction,rearWeight))
      })
    })
    // Fine hem details can extend below their coarse driver. Enforce the same
    // flat review floor on the final visible surface, including its tips.
    const aboveFloor=select(freedom.greaterThan(0),max(deformed.y,.012),deformed.y)
    return vec3(deformed.x,mix(deformed.y,aboveFloor,clothEnabled),deformed.z)
  })()
  mesh.userData.clothPosition = material.positionNode
  mesh.material = material

}


export function prepareClothAttributes(actor) {
  actor.traverse(obj => {
    if (!obj.isSkinnedMesh) return
    const geometry=obj.geometry
    const indices=geometry.getAttribute('_wl_proxy_indices'),weights=geometry.getAttribute('_wl_proxy_weights')
    const faces=geometry.getAttribute('_wl_proxy_face'),motion=geometry.getAttribute('_wl_cloth')
    if (!indices || !weights || !faces || !motion || !geometry.getAttribute('_wl_rear_side') || !geometry.getAttribute('_wl_motion_profile')) throw new Error('Cloth bindings or panel identities are missing; rebuild the review meshes')
    // WebGPU guarantees eight vertex buffers. Share one buffer for the
    // review attributes instead of spending a separate binding on every attribute.
    const values=new Float32Array(indices.count*12)
    for(let i=0;i<indices.count;i++) values.set([indices.getX(i),indices.getY(i),indices.getZ(i),weights.getX(i),weights.getY(i),weights.getZ(i),faces.getX(i),motion.getX(i),clothPrimaryFreedom(motion.getX(i),motion.getZ(i)),motion.getZ(i),geometry.getAttribute('_wl_rear_side').getX(i),geometry.getAttribute('_wl_motion_profile').getX(i)],i*12)
    const buffer=new THREE.InterleavedBuffer(values,12)
    for(const [name,size,offset] of [['_wl_proxy_indices',3,0],['_wl_proxy_weights',3,3],['_wl_proxy_face',1,6],['_wl_proxy_freedom',1,7],['_wl_proxy_primary',1,8],['_wl_proxy_region',1,9],['_wl_rear_side',1,10],['_wl_motion_profile',1,11]]) geometry.setAttribute(name,new THREE.InterleavedBufferAttribute(buffer,size,offset))
  })
}
