// CPU counterpart of the review shader, for audits of visible render geometry.
import { Quaternion, Vector3, Vector4 } from 'three/webgpu'
import { clothPrimaryFreedom } from './cloth-proxy.js'
import { conformClothToLegs, clearRearCloth, REAR_CONTACT } from './cloth-leg-contact.js'
const anchor=new Vector3(),offset=new Vector3(),primary=new Vector3(),residual=new Vector3(),rest=new Vector3(),carried=new Vector3(),rotation=new Vector4(),part=new Vector4(),q=new Quaternion()
const rearDirection=new Vector3()
const smooth=value=>{const t=Math.max(0,Math.min(1,value));return t*t*(3-2*t)}

export function deformClothVertex(mesh,index,simulation,out,enabled=true) {
  const a=mesh.geometry.attributes,mobility=a._wl_cloth.getX(index)
  out.fromBufferAttribute(a.position,index);mesh.applyBoneTransform(index,out)
  if(!enabled||mobility===0)return out
  anchor.set(0,0,0);offset.set(0,0,0);primary.set(0,0,0);rotation.set(0,0,0,0)
  for(let axis=0;axis<3;axis++) {
    const node=a._wl_proxy_indices.getComponent(index,axis),weight=a._wl_proxy_weights.getComponent(index,axis)
    anchor.addScaledVector(simulation.targets[node],weight);offset.addScaledVector(simulation.offsets[node],weight)
    primary.addScaledVector(simulation.primaryOffsets[node],weight)
    part.copy(simulation.rotations[node])
    if(axis>0&&part.dot(simulation.rotations[a._wl_proxy_indices.getX(index)])<0)part.multiplyScalar(-1)
    rotation.add(part.multiplyScalar(weight))
  }
  rotation.normalize();q.set(rotation.x,rotation.y,rotation.z,rotation.w)
  residual.copy(out).sub(anchor);anchor.copy(residual);residual.applyQuaternion(q).sub(anchor)
  const t=Math.min(1,mobility/.12),sway=t*t*(3-2*t),shape=clothPrimaryFreedom(mobility,a._wl_cloth.getZ(index))
  if([1,2].includes(a._wl_cloth.getZ(index))) {
    rest.fromBufferAttribute(a.position,index)
    simulation.legCloth[0].shape(rest,out,carried)
    carried.sub(out)
    out.addScaledVector(offset,sway).addScaledVector(primary,-sway).addScaledVector(carried,shape)
    carried.copy(out);conformClothToLegs(carried,simulation.capsules);out.lerp(carried,shape)
    const legCloth=simulation.legCloth[0],knee=legCloth.thighs[0].knee.y
    const rearWeight=(1-smooth(rest.z/.08))*(1-smooth((rest.y-knee)/REAR_CONTACT.heightBlend))*shape
    if(rearWeight>0) {
      rearDirection.set(0,0,-1).transformDirection(legCloth.hemFrame)
      clearRearCloth(out,simulation.capsules,rearDirection,rearWeight)
    }
  } else out.addScaledVector(offset,sway).addScaledVector(primary,shape-sway).addScaledVector(residual,shape)
  out.y=Math.max(.012,out.y)
  return out
}
