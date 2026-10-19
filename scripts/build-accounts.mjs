// Independent US account authority; regional game bundles retain their current size.
import { build } from 'esbuild'
await build({
  entryPoints: ['server/accounts-main.mjs'], bundle: true,
  platform: 'node', format: 'esm', target: 'node22',
  outfile: 'dist-accounts/accounts.mjs',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning',
})
console.log('dist-accounts/accounts.mjs')
