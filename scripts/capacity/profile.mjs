import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'

const dir = resolve(process.argv[2])
if (!dir.startsWith(resolve('artifacts/capacity') + '/')) throw new Error('Expected an isolated capacity run directory')
// optional second argument: one profile of several (room processes write one each)
const file = process.argv[3] ?? 'cpu.cpuprofile'
const profile = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'))
const sourceMap = new TraceMap(JSON.parse(readFileSync(`${dir}/build/server.mjs.map`, 'utf8')))
if (!Array.isArray(profile.nodes) || !Array.isArray(profile.samples) || !Array.isArray(profile.timeDeltas)
  || profile.samples.length !== profile.timeDeltas.length) throw new Error('Invalid CPU profile')
const nodes = new Map(profile.nodes.map(node => [node.id, node])), parents = new Map(), mapped = new Map()
for (const node of profile.nodes) {
  for (const child of node.children ?? []) parents.set(child, node.id)
  const frame = node.callFrame
  if (!frame.url.endsWith('/server.mjs') || frame.lineNumber < 0) continue
  const original = originalPositionFor(sourceMap, { line: frame.lineNumber + 1, column: frame.columnNumber })
  if (original.source) mapped.set(node.id, { file: original.source.slice(original.source.indexOf('/src/') + 1), line: original.line })
}
function category(file) {
  if (file.includes('src/bots/')) return 'Bot decisions'
  if (file.includes('src/sim/snapshot')) return 'State cloning / hashing'
  if (file.includes('src/sim/')) return 'Core simulation'
  if (/src\/net\/(protocol|wsframe|ws|stream|transport)/.test(file)) return 'Transport / stream / wire'
  if (file.includes('src/net/session')) return 'Session / scheduling'
  if (file.includes('server/')) return 'Server / persistence / monitoring'
  return 'Other JavaScript'
}
const groups = new Map(), functions = new Map()
let idleSamples = 0, activeSamples = 0
for (let i = 0; i < profile.samples.length; i++) {
  const node = nodes.get(profile.samples[i])
  if (!node) throw new Error('Unknown CPU sample')
  if (node.callFrame.functionName === '(idle)') { idleSamples++; continue }
  activeSamples++
  let caller = node, source = mapped.get(node.id)
  while (!source && parents.has(caller.id)) { caller = nodes.get(parents.get(caller.id)); source = mapped.get(caller.id) }
  const group = node.callFrame.functionName === '(garbage collector)' ? 'Garbage collection' : source ? category(source.file) : 'Native / unmapped'
  groups.set(group, (groups.get(group) ?? 0) + 1)
  const key = `${node.callFrame.functionName || '(anonymous)'} · ${source ? `${source.file}:${source.line}` : node.callFrame.url || 'native'}`
  functions.set(key, (functions.get(key) ?? 0) + 1)
}
const rank = map => [...map].sort((a, b) => b[1] - a[1]).map(([name, samples]) => ({ name, percentOfNonIdleSamples: samples / activeSamples * 100, samples }))
const result = { kind: 'sampled-cpu-attribution', intervalUs: 1000, activeSamples, idleSamples, negativeTimeDeltas: profile.timeDeltas.filter(n => n < 0).length,
  caveat: 'Sample counts, not elapsed-time weights. Exclusive attribution to the nearest mapped JavaScript caller; native time and GC stay explicit. Sampling is diagnostic, not a second process CPU meter. Includes setup, all roster sizes and cleanup.',
  groups: rank(groups), topFunctions: rank(functions).slice(0, 25) }
writeFileSync(`${dir}/${file === 'cpu.cpuprofile' ? 'cpu-summary.json' : file.replace(/\.cpuprofile$/, '.summary.json')}`, JSON.stringify(result, null, 2))
console.log(JSON.stringify(result))
