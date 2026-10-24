import * as THREE from 'three/webgpu'
import { attribute, clamp, dot, float, floor, faceDirection, max, min, mix, smoothstep, step, texture, uniform, uv, vec2, vec3 } from 'three/tsl'
import { U, type WarlockGpu } from './gpuState'
import { applyFx } from './materials'
import { EMBLEM_COLS, emblemAtlas } from './emblems'
import { CapeDrape } from './tripoCapeDrape'
import type { ClothProxy } from './pipeline/cloth-proxy.js'

const COLUMNS = 12, ROWS = 24

/** Skin attachment guides in the cape mesh's current local frame. */
export function poseCapeGuides(skin: THREE.SkinnedMesh, capeWorld: THREE.Matrix4, rest: THREE.Vector3[], targets: THREE.Vector3[]) {
  // updateWorldMatrix does not refresh SkinnedMesh.bindMatrixInverse. Derive
  // this frame's inverse explicitly, including pawn translation and turns.
  skin.bindMatrixInverse.copy(capeWorld).invert()
  for (let i = 0; i < targets.length; i++) {
    targets[i].copy(rest[i]); skin.applyBoneTransform(i, targets[i])
  }
}

/** Shoulder-to-knee cloth; spine/hip weights supply contact guides, not its drape. */
export function buildTripoCape(reference: THREE.SkinnedMesh): THREE.BufferGeometry {
  const joint = (name: string) => {
    const i = reference.skeleton.bones.findIndex(b => b.name === name)
    if (i < 0) throw new Error(`Cape attachment joint missing: ${name}`)
    return i
  }
  const chest = joint('spine_03'), middle = joint('spine_02'), waist = joint('spine_01'), hips = joint('pelvis')
  const columns = COLUMNS, rows = ROWS
  const positions: number[] = [], uvs: number[] = [], joints: number[] = [], weights: number[] = [], indices: number[] = []
  for (let i = 0; i <= rows; i++) for (let j = 0; j <= columns; j++) {
    const t = i / rows, s = j / columns, across = 2 * s - 1
    const halfWidth = .16 + .15 * Math.sin(t * Math.PI / 2)
    const tear = [0, .018, -.008, .028, .006, -.014, .012, -.008, .025, .004, -.018, .012, 0][j]
    const hem = THREE.MathUtils.smoothstep(t, .82, 1)
    const y = 1.47 - .028 * across * across - 1.02 * t - .045 * (1 - across * across) * Math.pow(t, 5) + tear * hem
    const z = -.10 - .10 * t + .04 * across * across + .009 * Math.cos(across * Math.PI * 4) * Math.sin(t * Math.PI / 2)
    positions.push(across * halfWidth, y, z)
    // Readable from behind, including asymmetric letter emblems.
    uvs.push(1 - s, t)
    const low = THREE.MathUtils.smoothstep(t, 0, .33)
    const hip = THREE.MathUtils.smoothstep(t, .22, .45)
    joints.push(chest, middle, waist, hips)
    weights.push(1 - low, low * (1 - hip) * .65, low * (1 - hip) * .35, low * hip)
    if (i < rows && j < columns) {
      const a = i * (columns + 1) + j, b = a + columns + 1
      indices.push(a, a + 1, b, a + 1, b + 1, b)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(joints, 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4))
  geometry.setIndex(indices)
  geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere()
  return geometry
}

/** Sample a quiet patch of the actual source fabric for matching woven detail. */
function fabricPatch(actor: THREE.Object3D): { map: THREE.Texture; uv: THREE.Vector2 } {
  const ray = new THREE.Ray(new THREE.Vector3(.045, 1.36, -2), new THREE.Vector3(0, 0, 1))
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3(), bary = new THREE.Vector3()
  const ua = new THREE.Vector2(), ub = new THREE.Vector2(), uc = new THREE.Vector2()
  let best = Infinity, result: { map: THREE.Texture; uv: THREE.Vector2 } | undefined
  actor.traverse(o => {
    const mesh = o as THREE.SkinnedMesh
    if (!mesh.isSkinnedMesh || !mesh.userData.sourceMap) return
    const g = mesh.geometry, p = g.attributes.position, uv = g.attributes.uv, ids = g.index
    if (!uv || !ids) throw new Error('Cape fabric reference requires the authored UV surface')
    for (let i = 0; i < ids.count; i += 3) {
      const ia = ids.getX(i), ib = ids.getX(i + 1), ic = ids.getX(i + 2)
      a.fromBufferAttribute(p, ia); b.fromBufferAttribute(p, ib); c.fromBufferAttribute(p, ic)
      if (!ray.intersectTriangle(a, b, c, false, hit) || hit.z >= best) continue
      THREE.Triangle.getBarycoord(hit, a, b, c, bary)
      ua.set(uv.getX(ia), uv.getY(ia)); ub.set(uv.getX(ib), uv.getY(ib)); uc.set(uv.getX(ic), uv.getY(ic))
      best = hit.z
      result = { map: mesh.userData.sourceMap as THREE.Texture, uv: ua.clone().multiplyScalar(bary.x).addScaledVector(ub, bary.y).addScaledVector(uc, bary.z) }
    }
  })
  if (!result) throw new Error('No source fabric under the cape reference point')
  return result
}

/** Fit the resting cloth to the actual robe rather than a guessed back plane. */
function fitBack(actor: THREE.Object3D, geometry: THREE.BufferGeometry, reference: THREE.SkinnedMesh) {
  const surfaces: THREE.SkinnedMesh[] = []
  actor.traverse(o => {
    const mesh = o as THREE.SkinnedMesh
    if (mesh.isSkinnedMesh && mesh.userData.sourceMap) surfaces.push(mesh)
  })
  const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, 0, 1))
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3(), bary = new THREE.Vector3()
  const p = geometry.attributes.position
  for (let i = 0; i < p.count; i++) {
    // The cape widens past the narrow waist. Sample the back's central surface
    // there; a ray at its loose edge can hit the robe's front through an armhole.
    ray.origin.set(p.getY(i) > .98 ? p.getX(i) * .35 : p.getX(i), p.getY(i), -2)
    let back = Infinity
    let binding: { mesh: THREE.SkinnedMesh; vertices: number[]; bary: number[] } | undefined
    for (const mesh of surfaces) {
      const g = mesh.geometry
      const ids = g.index!, source = g.attributes.position
      for (let j = 0; j < ids.count; j += 3) {
        a.fromBufferAttribute(source, ids.getX(j)); b.fromBufferAttribute(source, ids.getX(j + 1)); c.fromBufferAttribute(source, ids.getX(j + 2))
        if (ray.intersectTriangle(a, b, c, false, hit) && hit.z < back) {
          back = hit.z
          THREE.Triangle.getBarycoord(hit, a, b, c, bary)
          binding = { mesh, vertices: [ids.getX(j), ids.getX(j + 1), ids.getX(j + 2)], bary: bary.toArray() }
        }
      }
    }
    // Below the shoulders the widening hem extends beyond the robe silhouette.
    if (Number.isFinite(back)) {
      const pleat = .004 * (1 + Math.cos(i % (COLUMNS + 1) / COLUMNS * Math.PI * 8))
      p.setZ(i, p.getY(i) > .98 ? back - .014 - pleat : Math.min(p.getZ(i), back - .018 - pleat))
      if (p.getY(i) > .98 && binding) {
        // Match the underlying surface's actual rig weights. Guessed spine
        // blends move through the waist when that joint chain bends.
        const weights = new Map<number, number>()
        const { mesh, vertices, bary } = binding, attrs = mesh.geometry.attributes
        for (let v = 0; v < 3; v++) for (let k = 0; k < 4; k++) {
          const weight = attrs.skinWeight.getComponent(vertices[v], k) * bary[v]
          if (!weight) continue
          const bone = mesh.skeleton.bones[attrs.skinIndex.getComponent(vertices[v], k)]
          const joint = reference.skeleton.bones.indexOf(bone)
          if (joint < 0) throw new Error('Cape fit uses a different garment skeleton')
          weights.set(joint, (weights.get(joint) ?? 0) + weight)
        }
        const selected = [...weights].sort((a, b) => b[1] - a[1]).slice(0, 4)
        const total = selected.reduce((sum, [, weight]) => sum + weight, 0)
        if (total <= 0) throw new Error('Cape surface fit has no skin weights')
        for (let k = 0; k < 4; k++) {
          geometry.attributes.skinIndex.setComponent(i, k, k < selected.length ? selected[k][0] : 0)
          geometry.attributes.skinWeight.setComponent(i, k, k < selected.length ? selected[k][1] / total : 0)
        }
      }
    }
  }
  geometry.computeVertexNormals()
}

export function attachTripoCape(actor: THREE.Object3D, gpu: WarlockGpu, coat: ClothProxy) {
  let reference: THREE.SkinnedMesh | undefined
  actor.traverse(o => { if (!reference && (o as THREE.SkinnedMesh).isSkinnedMesh) reference = o as THREE.SkinnedMesh })
  if (!reference?.parent) throw new Error('Cape requires the fitted garment hierarchy')
  const patch = fabricPatch(actor)
  const material = new THREE.MeshPhysicalNodeMaterial({ side: THREE.DoubleSide, roughness: .94, metalness: 0, sheen: .22, sheenRoughness: .9 })
  material.name = 'TripoCapeFabric'
  const st = uv(), t = st.y
  const sample = texture(patch.map, st.mul(.12).add(uniform(patch.uv).sub(.06))).rgb
  const shade = clamp(dot(sample, vec3(.2126, .7152, .0722)).div(.06), .9, 1.1)
  const edge = min(min(st.x, float(1).sub(st.x)), min(t, float(1).sub(t)))
  const border = float(1).sub(smoothstep(.008, .016, edge))
  const stitch = smoothstep(.003, .005, edge).mul(float(1).sub(smoothstep(.007, .009, edge)))
  const base = mix(mix(vec3(.034, .030, .038), U.team.mul(.08), .18).mul(shade), U.team.mul(.16).mul(shade), border)
  const eUv = st.sub(vec2(.5, .31)).div(vec2(.55, .28)).add(.5)
  const inside = step(0, eUv.x).mul(step(eUv.x, 1)).mul(step(0, eUv.y)).mul(step(eUv.y, 1))
  const cell = vec2(max(U.emblem, 0).mod(EMBLEM_COLS), floor(max(U.emblem, 0).div(EMBLEM_COLS)))
  const emblem = texture(emblemAtlas(), cell.add(clamp(eUv, .002, .998)).div(EMBLEM_COLS)).r.mul(inside).mul(step(-.5, U.emblem)).mul(max(faceDirection, 0))
  material.sheenColor.set('#342a3a')
  const ink = border.mul(.025).add(stitch.mul(.10)).add(emblem.mul(.18).mul(shade))
  const emissive = U.team.mul(ink).mul(float(1).add(U.castCharge.mul(.25)))
  applyFx(material, mix(base, U.team.mul(.28).mul(shade), emblem.mul(.85)), emissive, attribute('position', 'vec3').y)
  const guides = buildTripoCape(reference)
  fitBack(actor, guides, reference)
  const skin = new THREE.SkinnedMesh(guides, material)
  skin.bind(reference.skeleton, reference.bindMatrix)
  const geometry = guides.clone()
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'TripoShortCape'
  mesh.userData.wl = gpu
  mesh.castShadow = mesh.receiveShadow = true
  mesh.frustumCulled = false
  reference.parent.add(mesh)
  const drape = new CapeDrape(geometry, COLUMNS)
  const targets = drape.rest.map(p => p.clone())
  const inverse = new THREE.Matrix4(), gravity = new THREE.Vector3(), wind = new THREE.Vector3()
  const delta = new THREE.Vector3(), axis = new THREE.Vector3(), nearest = new THREE.Vector3()
  const goals = targets.map(p => p.clone()), normals = targets.map(() => new THREE.Vector3())
  const down = new THREE.Vector3(), across = new THREE.Vector3()
  const rear = coat.rest.flatMap((p, i) => coat.data.region[i] === 1 && p.z < -.06 ? [i] : [])
  const pose = () => {
    actor.updateWorldMatrix(true, true)
    poseCapeGuides(skin, mesh.matrixWorld, drape.rest, targets)
    inverse.copy(mesh.parent!.matrixWorld).invert()
    down.set(0, -1, 0).transformDirection(inverse)
    gravity.copy(down).multiplyScalar(9.81)
    for (let i = 0; i < targets.length; i++) {
      normals[i].copy(drape.rest[i]).addScaledVector(axis.set(0, 0, -1), .01)
      skin.applyBoneTransform(i, normals[i]); normals[i].sub(targets[i]).normalize()
    }
    // The lower cloth hangs from the waist under gravity; it does not inherit
    // the torso's lean. A small wind deflection lifts the hem during motion.
    const waist = 8, stride = COLUMNS + 1
    across.subVectors(targets[waist * stride + COLUMNS], targets[waist * stride]).normalize()
    for (let row = 0; row <= ROWS; row++) for (let col = 0; col <= COLUMNS; col++) {
      const i = row * stride + col, anchor = waist * stride + col
      goals[i].copy(targets[i])
      if (row > waist) {
        const length = drape.rest[anchor].y - drape.rest[i].y
        goals[i].copy(targets[anchor]).addScaledVector(down, length)
          .addScaledVector(across, drape.rest[i].x - drape.rest[anchor].x)
          .addScaledVector(normals[anchor], .06 * length + gpu.flutter * .16 * length * length)
          .addScaledVector(across, gpu.swayCape.x * length * .4)
      }
    }
  }
  const contact = (p: THREE.Vector3, i: number) => {
    if (drape.rest[i].y > .75) {
      const signed = delta.subVectors(p, targets[i]).dot(normals[i])
      if (signed < .002) p.addScaledVector(normals[i], .002 - signed)
    }
    // Select one nearby coat support. Applying many overlapping triangle
    // planes in sequence made contradictory corrections and injected energy.
    let support = -1, best = .12 * .12
    for (const j of rear) {
      const q = coat.position[j]
      if (Math.abs(p.z - q.z) > .12) continue
      const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2
      if (d < best) { best = d; support = j }
    }
    if (support >= 0) p.z = Math.min(p.z, coat.position[support].z - .02)
    for (const cap of coat.capsules) {
      if (cap.kind !== 'leg') continue
      axis.subVectors(cap.b, cap.a)
      const t = THREE.MathUtils.clamp(delta.subVectors(p, cap.a).dot(axis) / axis.lengthSq(), 0, 1)
      nearest.copy(cap.a).addScaledVector(axis, t)
      delta.subVectors(p, nearest)
      const distance = delta.length(), radius = cap.radius + .018
      if (distance < radius && distance > 1e-8) p.addScaledVector(delta, (radius - distance) / distance)
    }
    p.y = Math.max(.018, p.y)
  }
  let seconds = 0, wasVisible = true, cpuMs = 0
  pose(); drape.reset(targets)
  return {
    mesh,
    update(dt: number) {
      if (!mesh.visible) { wasVisible = false; return }
      if (dt <= 0) return
      const start = performance.now()
      pose(); seconds += dt
      if (!wasVisible) { drape.reset(targets); wasVisible = true }
      wind.set(gpu.swayCape.x * 8 + Math.sin(seconds * 3 + gpu.phase) * gpu.flutter * .2, 0, gpu.swayCape.z * 8 - gpu.flutter * gpu.flutter * 2)
      drape.update(dt, targets, goals, gravity, wind, contact)
      cpuMs = performance.now() - start
    },
    inspect() {
      let maxEdge = 0
      for (let i = COLUMNS + 1; i < drape.points.length; i++) maxEdge = Math.max(maxEdge, drape.points[i].distanceTo(drape.points[i - COLUMNS - 1]))
      return { cpuMs, steps: drape.lastSteps, maxEdge }
    },
    reset() { pose(); drape.reset(targets); seconds = 0 },
    dispose() { mesh.removeFromParent(); geometry.dispose(); guides.dispose(); material.dispose() },
  }
}
