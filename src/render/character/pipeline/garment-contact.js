// Dev authoring only. A fitted convex garment volume gives adjacent cuff
// points a continuous radial exit, including across its face boundaries.
export function projectConvexGarmentContact(point,planes,gap,center) {
  let distance=-Infinity
  for(const plane of planes)distance=Math.max(distance,point.dot(plane.normal)-plane.constant)
  if(distance>=gap)return 0
  const x=point.x-center.x,y=point.y-center.y,z=point.z-center.z
  const radius=Math.hypot(x,y,z)
  if(radius<1e-8)throw new Error('Ambiguous cloth contact at garment envelope center')
  let scale=Infinity
  for(const plane of planes) {
    const along=plane.normal.x*x+plane.normal.y*y+plane.normal.z*z
    if(along>1e-10)scale=Math.min(scale,(plane.constant+gap-center.dot(plane.normal))/along)
  }
  if(!Number.isFinite(scale))throw new Error('Garment envelope must enclose its center')
  point.set(center.x+x*scale,center.y+y*scale,center.z+z*scale)
  return radius*(scale-1)
}
