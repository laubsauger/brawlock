import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Explicit, checked-in metadata: rebuilding a release must not change its date.
export function releaseMetadata(pkg) {
  const { version, releaseDate } = pkg
  const match = typeof version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version)
  if (!match || match[4]?.split('.').some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    throw new Error('package.json version must be a valid semantic version')
  }
  if (typeof releaseDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)
    || !Number.isFinite(Date.parse(releaseDate)) || new Date(releaseDate).toISOString().slice(0, 10) !== releaseDate) {
    throw new Error('package.json releaseDate must be a real YYYY-MM-DD date')
  }
  return { version, releaseDate, tag: `v${version}` }
}

export function readReleaseMetadata(root) {
  return releaseMetadata(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')))
}
