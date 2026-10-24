import { build } from 'esbuild'
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { netId } from '../net-id.mjs'

const out = 'artifacts/capacity/build'
mkdirSync(out, { recursive: true })
if (!process.argv[2] || !/^[a-f0-9]{7,40}$/.test(process.argv[2])) throw new Error('Supply the deployed source commit explicitly: node scripts/capacity/build.mjs <sha>')
const revision = execFileSync('git', ['rev-parse', '--verify', `${process.argv[2]}^{commit}`], { encoding: 'utf8' }).trim()
const snapshot = resolve(`${out}/source-${revision.slice(0, 12)}-${Date.now()}`)
mkdirSync(snapshot, { recursive: true })
const archive = `${snapshot}/source.tar`
writeFileSync(archive, execFileSync('git', ['archive', '--format=tar', revision, 'src', 'server', 'package.json'], { maxBuffer: 32 * 1024 * 1024 }))
execFileSync('tar', ['-xf', archive, '-C', snapshot])
mkdirSync(`${snapshot}/scripts/capacity`, { recursive: true })
mkdirSync(`${snapshot}/src/testing`, { recursive: true })
copyFileSync('src/testing/headlessClient.ts', `${snapshot}/src/testing/headlessClient.ts`)
for (const name of ['server', 'worker', 'bot-cost']) copyFileSync(`scripts/capacity/${name}.mjs`, `${snapshot}/scripts/capacity/${name}.mjs`)
const net = netId(snapshot)
for (const name of ['server', 'worker', 'bot-cost']) await build({
  entryPoints: [`${snapshot}/scripts/capacity/${name}.mjs`], outfile: `${out}/${name}.mjs`,
  bundle: true, platform: 'node', format: 'esm', target: 'node24', sourcemap: 'external',
  define: { __NET_ID__: JSON.stringify(net), __RELEASE_COMMIT__: JSON.stringify(revision), 'import.meta.env.DEV': 'false' },
  logLevel: 'warning',
})
writeFileSync(`${out}/manifest.json`, JSON.stringify({ revision, net, builtAt: new Date().toISOString(), timeScale: 1,
  scope: 'isolated game process and real prediction clients; no production account/rating authority; network route recorded per run' }, null, 2) + '\n')
console.log(out)
