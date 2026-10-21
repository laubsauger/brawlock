// Independent US account authority; regional game bundles retain their current size.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim()
await build({
  entryPoints: ['server/accounts-main.mjs'], bundle: true,
  platform: 'node', format: 'esm', target: 'node22',
  outfile: 'dist-accounts/accounts.mjs',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  define: { __RELEASE_COMMIT__: JSON.stringify(commit) },
  loader: { '.css': 'text' },
  logLevel: 'warning',
})
console.log('dist-accounts/accounts.mjs')
