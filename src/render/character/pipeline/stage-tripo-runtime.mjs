// Reproduce the opt-in game candidate from the validated authoring outputs.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const source = resolve(root, 'art/source/tripo-warlock-v1')
const target = resolve(root, 'public/models/warlock/tripo')
const mesh = readFileSync(resolve(source, 'tripo-10k-original.glb'))
if (mesh.readUInt32LE(0) !== 0x46546c67 || mesh.readUInt32LE(4) !== 2) throw new Error('Expected a GLB 2.0 candidate')
const json = JSON.parse(mesh.subarray(20, 20 + mesh.readUInt32LE(12)).toString())
const proxy = JSON.parse(readFileSync(resolve(source, 'cloth-proxy.json'), 'utf8'))
if (!proxy.id || !proxy.colliders?.length) throw new Error('Missing fitted cloth data')
const skinned = json.nodes.filter(node => node.skin !== undefined)
if (skinned.length !== 2 || json.animations.length !== 13) throw new Error('Expected the two-material 10K mesh and full animation library')
for (const node of skinned) {
  if (node.extras?.cloth_proxy_id !== proxy.id) throw new Error('Mesh/proxy authoring identities differ')
}
const files = [['tripo-10k-original.glb', 'warlock-10k.glb'], ['cloth-proxy.json', 'cloth-proxy.json']]
mkdirSync(target, { recursive: true })
for (const [from, to] of files) copyFileSync(resolve(source, from), resolve(target, to))
const manifest = {
  model: 'User-provided Tripo starter warlock; opt-in integration candidate',
  proxy: proxy.id,
  files: Object.fromEntries(files.map(([from, to]) => [to, { source: from, sha256: createHash('sha256').update(readFileSync(resolve(target, to))).digest('hex') }])),
}
writeFileSync(resolve(target, 'provenance.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify(manifest, null, 2))
