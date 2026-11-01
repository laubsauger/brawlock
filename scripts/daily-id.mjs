// The daily verifier bundle and its id (docs/moonshot/specs/daily.md): src/game/daily/verify.ts
// with everything it imports (the sim, the bots, the command codec, the moments engine), bundled
// with esbuild. The id is a hash of that bundle, so it moves exactly when a run would verify
// differently; a new hat or a UI change leaves it. Used by vite.config.ts (__DAILY_ID__) and
// scripts/build-daily.mjs (the file the account service loads).
import { buildSync } from 'esbuild'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export function dailyBundle(root) {
  const out = buildSync({
    entryPoints: [join(root, 'src/game/daily/verify.ts')],
    bundle: true,
    write: false,
    platform: 'neutral',
    format: 'esm',
    target: 'es2022',
    legalComments: 'none',
    logLevel: 'silent',
  })
  const code = out.outputFiles[0].text
  return { id: createHash('sha256').update(code).digest('hex').slice(0, 12), code }
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(dailyBundle(process.argv[2] ?? process.cwd()).id)
