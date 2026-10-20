// Independent inspection of exported GLB data, rather than Blender scene state.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'

const directory = resolve(process.argv[2] ?? 'art/source/tripo-warlock-v1')
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const preparation = JSON.parse(readFileSync(join(directory, 'preparation.json'), 'utf8'))
const rigging = JSON.parse(readFileSync(join(directory, 'rigging.json'), 'utf8'))
const bakeRecords = process.argv.includes('--include-bake-studies') ? JSON.parse(readFileSync(join(directory, 'lods.json'), 'utf8')).lods : []
const proxy = JSON.parse(readFileSync(join(directory, 'cloth-proxy.json'), 'utf8'))
const sourceLods=JSON.parse(readFileSync(join(directory,'source-lods.json'),'utf8'))
assert(proxy.positions.length <= 512)
assert(proxy.garments.every(garment=>garment.pinned>0),'Every garment needs an attachment band')
assert.equal(hash('public/models/warlock/warlock.glb'), preparation.shipped_asset_sha256)
for (const item of preparation.originals) assert.equal(hash(join(directory, 'originals', item.file)), item.sha256)

function load(name) {
  const bytes = readFileSync(join(directory, name))
  assert.equal(bytes.readUInt32LE(0), 0x46546c67)
  assert.equal(bytes.readUInt32LE(4), 2)
  assert.equal(bytes.readUInt32LE(8), bytes.length)
  const jsonLength = bytes.readUInt32LE(12)
  const doc = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength))
  const binAt = 20 + jsonLength
  assert.equal(bytes.readUInt32LE(binAt + 4), 0x004e4942)
  const binary = bytes.subarray(binAt + 8)
  function accessor(index) {
    const a = doc.accessors[index]
    assert(!a.sparse, 'Unexpected sparse accessor in this pipeline')
    const sizes = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }
    const methods = { 5120: ['getInt8', 1], 5121: ['getUint8', 1], 5122: ['getInt16', 2],
      5123: ['getUint16', 2], 5125: ['getUint32', 4], 5126: ['getFloat32', 4] }
    const [method, size] = methods[a.componentType]
    const width = sizes[a.type]
    const buffer = doc.bufferViews[a.bufferView]
    const stride = buffer.byteStride ?? width * size
    const start = (buffer.byteOffset ?? 0) + (a.byteOffset ?? 0)
    const view = new DataView(binary.buffer, binary.byteOffset, binary.length)
    const result = []
    for (let i = 0; i < a.count; i++) {
      const value = []
      for (let j = 0; j < width; j++) {
        let number = view[method](start + i * stride + j * size, true)
        if (a.normalized) {
          assert([5121, 5123].includes(a.componentType), 'Unexpected normalized component type')
          number /= a.componentType === 5121 ? 255 : 65535
        }
        assert(Number.isFinite(number), 'Non-finite accessor value')
        value.push(number)
      }
      result.push(value)
    }
    return result
  }
  return { bytes, doc, binary, accessor }
}

function imageSize(data, mime) {
  if (mime === 'image/png') return [data.readUInt32BE(16), data.readUInt32BE(20)]
  assert.equal(mime, 'image/jpeg')
  let offset = 2
  while (offset < data.length) {
    assert.equal(data[offset], 0xff)
    const marker = data[offset + 1]
    offset += 2
    if ([0xc0, 0xc1, 0xc2].includes(marker)) return [data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3)]
    offset += data.readUInt16BE(offset)
  }
  throw new Error('JPEG dimensions missing')
}

const proof = { status: 'passed', originalsUnchanged: true, shippedCharacterUnchanged: true, assets: [] }
for (const record of [{ file: 'tripo-rig-test.glb', triangles: 20077, meshes: 12 }, ...sourceLods, ...bakeRecords]) {
  const { bytes, doc, binary, accessor } = load(record.file)
  assert.equal(doc.skins.length, 1)
  const skin = doc.skins[0]
  assert.equal(skin.joints.length, 65)
  const names = skin.joints.map((index) => doc.nodes[index].name)
  for (const required of ['root', 'pelvis', 'Head', 'hand_l', 'hand_r', 'foot_l', 'foot_r']) assert(names.includes(required))
  assert.deepEqual(doc.animations.map((clip) => clip.name).sort(), [...rigging.clips].sort())
  assert.equal(doc.meshes.length, record.meshes)
  let triangles = 0, movableVertices = 0
  for (const mesh of doc.meshes) for (const primitive of mesh.primitives) {
    assert.equal(primitive.mode ?? 4, 4)
    const attributes = primitive.attributes
    for (const name of ['POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0', '_WL_CLOTH','_WL_PROXY_INDICES','_WL_PROXY_WEIGHTS','_WL_PROXY_FACE']) assert(name in attributes, 'Missing ' + name)
    const proxyIndices=accessor(attributes._WL_PROXY_INDICES),proxyWeights=accessor(attributes._WL_PROXY_WEIGHTS),proxyFaces=accessor(attributes._WL_PROXY_FACE)
    for(let i=0;i<proxyIndices.length;i++) {
      assert(proxyIndices[i].every(index=>Number.isInteger(index)&&index>=0&&index<proxy.positions.length))
      assert(proxyWeights[i].every(w=>w>=0&&w<=1))
      assert(Math.abs(proxyWeights[i].reduce((a,b)=>a+b,0)-1)<1e-5)
      assert(Number.isInteger(proxyFaces[i][0])&&proxyFaces[i][0]>=0&&proxyFaces[i][0]<proxy.triangles.length)
    }
    const positions = accessor(attributes.POSITION)
    const indices = accessor(primitive.indices).flat()
    triangles += indices.length / 3
    assert(indices.every((index) => index >= 0 && index < positions.length))
    const weights = accessor(attributes.WEIGHTS_0)
    const joints = accessor(attributes.JOINTS_0)
    const cloth = accessor(attributes._WL_CLOTH)
    assert.equal(weights.length, positions.length)
    for (let i = 0; i < weights.length; i++) {
      assert(Math.abs(weights[i].reduce((sum, value) => sum + value, 0) - 1) < 0.0001, 'Unnormalized weights')
      assert(weights[i].every((value) => value >= 0 && value <= 1))
      assert(joints[i].every((index) => Number.isInteger(index) && index >= 0 && index < 65))
      assert(cloth[i][0] >= -0.0001 && cloth[i][0] <= 1.0001)
      assert(cloth[i][1] >= -0.0001 && cloth[i][1] < 2)
      assert(cloth[i][2] >= -0.0001 && cloth[i][2] <= 4.0001)
      if (cloth[i][0] > 0.05) movableVertices++
    }
  }
  assert.equal(triangles, record.triangles)
  assert(doc.nodes.filter(node=>node.mesh!==undefined).every(node=>node.extras.cloth_proxy_id===proxy.id),'Mesh and proxy build identifiers differ')
  assert(movableVertices > 50)
  for (const clip of doc.animations) for (const sampler of clip.samplers) {
    const times = accessor(sampler.input).flat()
    assert(times.length > 1 && times.every((time, i) => i === 0 || time >= times[i - 1]))
    accessor(sampler.output)
  }
  const images = doc.images.map((image) => {
    const view = doc.bufferViews[image.bufferView]
    return { name: image.name, size: imageSize(binary.subarray(view.byteOffset, view.byteOffset + view.byteLength), image.mimeType) }
  })
  if (record.texture_resolution) {
    assert.equal(images.length, 2)
    assert(images.every((image) => image.size.every((dimension) => dimension === record.texture_resolution)))
    assert(doc.materials.every((material) => material.normalTexture && material.pbrMetallicRoughness.baseColorTexture))
  }
  if(record.material) {
    assert.equal(images.length,1)
    assert.deepEqual(images[0].size,[4096,4096])
    assert(doc.materials.every(material=>!material.normalTexture),'Original-material LOD must not use the rejected ray bake')
  }
  proof.assets.push({ file: record.file, triangles, meshes: doc.meshes.length, bones: 65, clips: doc.animations.length,
    movableVertices, bytes: bytes.length, images })
}
writeFileSync(join(directory, 'export-validation.json'), JSON.stringify(proof, null, 2))
console.log(JSON.stringify(proof, null, 2))
