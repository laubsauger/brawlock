// Independent US account authority; regional game bundles retain their current size.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { dailyBundle } from './daily-id.mjs'
const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim()
await build({
  entryPoints: ['server/accounts-main.mjs'], bundle: true,
  platform: 'node', format: 'esm', target: 'node24',
  outfile: 'dist-accounts/accounts.mjs',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  // the daily verifier of this build travels inside the account bundle, so the bundle's hash (and a
  // release's redeploy of the service) moves whenever runs would verify differently
  define: { __RELEASE_COMMIT__: JSON.stringify(commit), __DAILY_BUNDLE__: JSON.stringify(dailyBundle(process.cwd())) },
  loader: { '.css': 'text' },
  logLevel: 'warning',
})
console.log('dist-accounts/accounts.mjs')
