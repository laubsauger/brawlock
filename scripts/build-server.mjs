// Bundle the dedicated server into one file (dist-server/server.mjs): no node_modules on
// the host. The netcode id is baked in: it must match the deployed client build.
// esbuild is vite's own dependency (vite 7), so no extra install.
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { netId } from './net-id.mjs'
import { readReleaseMetadata } from './release-version.mjs'

const root = process.cwd()
const release = process.argv.includes('--dev') ? `dev-${netId(root)}` : netId(root)
let commit = 'unknown'
try {
  commit = execSync('git rev-parse --short=12 HEAD', { encoding: 'utf8' }).trim()
} catch {
  /* not a git checkout */
}
mkdirSync('dist-server', { recursive: true })
await build({
  entryPoints: ['server/main.mjs'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist-server/server.mjs',
  define: { __NET_ID__: JSON.stringify(release), __RELEASE_COMMIT__: JSON.stringify(commit === 'unknown' ? null : commit), 'import.meta.env.DEV': 'false' },
  logLevel: 'warning',
})
writeFileSync('dist-server/version.json', JSON.stringify({ net: release, commit, ...readReleaseMetadata(root), built: new Date().toISOString() }) + '\n')
console.log(`dist-server/server.mjs (net ${release}, commit ${commit})`)
