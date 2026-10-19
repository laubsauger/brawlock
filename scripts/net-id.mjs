// Netcode compatibility id: a hash of everything a dedicated server and its clients must
// share (src/sim, src/net; tests excluded). UI-only deploys keep the id, so a server
// stays usable until the netcode or the sim changes. Used by vite.config.ts (__NET_ID__)
// and the server bundle (deploy/deploy.sh).
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export function netId(root) {
  const h = createHash('sha256')
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
        h.update(relative(root, p))
        h.update(readFileSync(p))
      }
    }
  }
  for (const d of ['src/sim', 'src/net']) walk(join(root, d))
  // Both authorities validate these IDs before sending cosmetic slot metadata.
  const cosmetics = 'src/game/progressionCatalog.ts'
  h.update(cosmetics)
  h.update(readFileSync(join(root, cosmetics)))
  return h.digest('hex').slice(0, 12)
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(netId(process.argv[2] ?? process.cwd()))
