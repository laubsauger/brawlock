// Recessed face insert for this authoring model. No production asset mutation.
import * as THREE from 'three/webgpu'
import { attribute, float, length, mix, select, smoothstep, uniform, uv, vec3 } from 'three/tsl'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

export function attachPreviewFace(actor, color, phase=0) {
  const head=actor.getObjectByName('Head')
  if(!head?.isBone) throw new Error('The hood face requires the fitted Head joint')
  actor.updateMatrixWorld(true)
  const pieces=[]
  function add(geometry,part) {
    const g=geometry.toNonIndexed()
    g.setAttribute('aFacePart',new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count).fill(part),1))
    pieces.push(g);geometry.dispose()
  }
  // Taper toward the hood tip: an ellipsoid protrudes through the narrow upper
  // sides of this hood and reads as a black head sitting outside the fabric.
  const profile=[[.002,1.505],[.038,1.54],[.071,1.59],[.091,1.65],[.086,1.70],[.055,1.75],[.014,1.79],[.001,1.80]]
  const voidGeometry=new THREE.LatheGeometry(profile.map(([radius,y])=>new THREE.Vector2(radius,y)),20)
  voidGeometry.scale(1,1,.9);voidGeometry.translate(0,0,.118)
  add(voidGeometry,0)
  const eyeHeight=1.675
  function radiusAt(y) {
    for(let i=1;i<profile.length;i++)if(y<=profile[i][1]) {
      const [a,ay]=profile[i-1],[b,by]=profile[i]
      return THREE.MathUtils.lerp(a,b,(y-ay)/(by-ay))
    }
    throw new Error('Eye extends beyond the fitted hood profile')
  }
  function faceDepth(x,y) {
    const radius=radiusAt(y)
    if(Math.abs(x)>=radius)throw new Error('Eye extends beyond the recessed face')
    return .118+.9*Math.sqrt(radius*radius-x*x)
  }
  for(const side of [-1,1]) {
    const eye=new THREE.PlaneGeometry(2,2,24,8)
    const positions=eye.attributes.position
    for(let i=0;i<positions.count;i++) {
      const u=positions.getX(i),v=positions.getY(i)
      const width=Math.pow(Math.max(0,Math.sin((u+1)*Math.PI/2)),.8)
      const x=side*(.042+u*.027),y=eyeHeight+u*.0081+v*width*(v>=0?.008:.005)
      positions.setXYZ(i,x,y,faceDepth(x,y)+.001)
    }
    eye.computeVertexNormals();add(eye,1)
    // The glow follows the same face surface, rather than a billboard in front.
    const halo=new THREE.PlaneGeometry(1,1,12,6),points=halo.attributes.position
    for(let i=0;i<points.count;i++) {
      const u=points.getX(i)*2,v=points.getY(i)*2
      const x=side*(.042+u*.033),y=eyeHeight+u*.0099+v*.014
      points.setXYZ(i,x,y,faceDepth(x,y)+.0005)
    }
    halo.computeVertexNormals();add(halo,2)
  }
  const geometry=mergeGeometries(pieces,false)
  if(!geometry) throw new Error('Face insert geometry could not be combined')
  for(const piece of pieces) piece.dispose()
  const eyeColor=uniform(new THREE.Color(color))
  const openness=uniform(1)
  // This glow always sits over the black void. Shade its falloff into black
  // instead of blending transparent, depth-writing quads over the same mesh:
  // their back-face pass could prevent the opaque face from drawing beneath.
  const material=new THREE.MeshBasicNodeMaterial({side:THREE.DoubleSide})
  const part=attribute('aFacePart','float')
  const radial=length(uv().sub(.5).mul(2))
  const haloOpacity=float(1).sub(smoothstep(.05,1,radial)).pow(2).mul(.42)
  material.colorNode=select(part.lessThan(.5),vec3(0),eyeColor.mul(select(part.lessThan(1.5),float(2.5),haloOpacity)).mul(openness))
  const mesh=new THREE.Mesh(geometry,material)
  mesh.name='PreviewHoodVoidAndEyes'
  mesh.matrixAutoUpdate=false
  mesh.matrix.copy(head.matrixWorld).invert().multiply(actor.matrixWorld)
  head.add(mesh)
  const base=geometry.attributes.position.array.slice(),parts=geometry.attributes.aFacePart
  let elapsed=0,nextBlink=2.8+phase*.37,blinkTime=-1,previousOpen=1,sequence=phase+1
  function setOpen(value) {
    if(value===previousOpen)return
    previousOpen=value;openness.value=value
    const positions=geometry.attributes.position
    for(let i=0;i<positions.count;i++)if(parts.getX(i)>.5) {
      const x=base[i*3],baseline=eyeHeight+(Math.abs(x)-.042)*.30,y=baseline+(base[i*3+1]-baseline)*value
      positions.setXYZ(i,x,y,faceDepth(x,y)+(parts.getX(i)<1.5?.001:.0005))
    }
    positions.needsUpdate=true
  }
  return {
    mesh,setColor(value){eyeColor.value.set(value)},
    blink(){blinkTime=0},
    update(dt) {
      elapsed+=dt
      if(blinkTime<0&&elapsed>=nextBlink)blinkTime=0
      if(blinkTime>=0) {
        blinkTime+=dt
        const closed=blinkTime<.065?THREE.MathUtils.smoothstep(blinkTime,0,.065):1-THREE.MathUtils.smoothstep(blinkTime,.065,.19)
        setOpen(1-closed)
        if(blinkTime>=.19) {
          blinkTime=-1;sequence=(Math.imul(sequence,1664525)+1013904223)>>>0
          nextBlink=elapsed+3.5+sequence/4294967296*3
          setOpen(1)
        }
      }
    },
    dispose(){geometry.dispose();material.dispose()},
  }
}
