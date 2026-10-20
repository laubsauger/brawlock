// Authoring intake: Blender does not import the runtime EXT_meshopt_compression asset.
// Decode its buffer views without changing meshes, skeletons, materials, or clips.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'

const [input, output] = process.argv.slice(2)
if (!input || !output) throw new Error('Usage: node decode-warlock.mjs INPUT.glb OUTPUT.glb')
const source = readFileSync(input)
if (source.readUInt32LE(0) !== 0x46546c67 || source.readUInt32LE(4) !== 2 || source.readUInt32LE(8) !== source.length) throw new Error('Expected a complete GLB 2.0 asset.')
const jsonLength = source.readUInt32LE(12)
if (source.readUInt32LE(16) !== 0x4e4f534a) throw new Error('GLB JSON chunk is missing.')
const doc = JSON.parse(source.toString('utf8', 20, 20 + jsonLength))
const binaryAt = 20 + jsonLength
if (source.readUInt32LE(binaryAt + 4) !== 0x004e4942 || doc.buffers[0].uri
  || doc.buffers.slice(1).some((buffer) => !buffer.extensions?.EXT_meshopt_compression?.fallback || buffer.uri)) throw new Error('Expected embedded binary data and meshopt placeholder buffers only.')
const binaryLength = source.readUInt32LE(binaryAt)
const binary = source.subarray(binaryAt + 8, binaryAt + 8 + binaryLength)
const chunks = [binary]
let length = binary.length
let decoded = 0
await MeshoptDecoder.ready
for (const view of doc.bufferViews) {
  const ext = view.extensions?.EXT_meshopt_compression
  if (!ext) {
    if (view.buffer !== 0) throw new Error('An undecoded view references a placeholder buffer.')
    continue
  }
  if (ext.buffer !== 0 || ext.byteOffset < 0 || ext.byteOffset + ext.byteLength > binary.length) throw new Error('Invalid meshopt buffer range.')
  const data = new Uint8Array(ext.count * ext.byteStride)
  MeshoptDecoder.decodeGltfBuffer(data, ext.count, ext.byteStride, binary.subarray(ext.byteOffset, ext.byteOffset + ext.byteLength), ext.mode, ext.filter)
  const pad = (4 - length % 4) % 4
  if (pad) { chunks.push(Buffer.alloc(pad)); length += pad }
  view.buffer = 0
  view.byteOffset = length
  view.byteLength = data.length
  chunks.push(Buffer.from(data)); length += data.length
  delete view.extensions.EXT_meshopt_compression
  if (!Object.keys(view.extensions).length) delete view.extensions
  decoded++
}
if (!decoded) throw new Error('Input contains no meshopt-compressed buffer views.')
for (const key of ['extensionsUsed', 'extensionsRequired']) if (doc[key]) {
  doc[key] = doc[key].filter((name) => name !== 'EXT_meshopt_compression')
  if (!doc[key].length) delete doc[key]
}
doc.buffers = [{ byteLength: length }]
const json = Buffer.from(JSON.stringify(doc))
const jsonPad = (4 - json.length % 4) % 4
const binPad = (4 - length % 4) % 4
const header = Buffer.alloc(20)
header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4)
header.writeUInt32LE(20 + json.length + jsonPad + 8 + length + binPad, 8)
header.writeUInt32LE(json.length + jsonPad, 12); header.writeUInt32LE(0x4e4f534a, 16)
const binHeader = Buffer.alloc(8)
binHeader.writeUInt32LE(length + binPad, 0); binHeader.writeUInt32LE(0x004e4942, 4)
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, Buffer.concat([header, json, Buffer.alloc(jsonPad, 0x20), binHeader, ...chunks, Buffer.alloc(binPad)]))
console.log(`Decoded ${decoded} buffer views to ${output}`)
