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
  const release = releaseMetadata(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')))
  readReleaseNotes(root, release)
  return release
}

const NOTE_KEYS = ['version', 'releaseDate', 'title', 'changes']
const PLACEHOLDER = /\b(?:TODO|TBD|FIXME|lorem ipsum)\b|^\s*(?:placeholder(?: text)?|coming soon|insert .+ here|write .+ here|\.{3}|…)\s*[.!]?\s*$/i
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
  && !/[\r\n\u0000-\u001f\u007f]/.test(value) && !PLACEHOLDER.test(value)

/** Checked-in, player-facing notes travel with their exact release metadata. */
export function validateReleaseNotes(notes, release) {
  const current = releaseMetadata(release)
  if (!Array.isArray(notes) || notes.length === 0) throw new Error('release-notes.json must contain a nonempty release history')
  const versions = new Set()
  let previousDate = null
  for (const [index, entry] of notes.entries()) {
    const label = `release-notes.json entry ${index + 1}`
    if (!object(entry) || Object.keys(entry).length !== NOTE_KEYS.length || Object.keys(entry).some((key) => !NOTE_KEYS.includes(key))) {
      throw new Error(`${label} must contain exactly version, releaseDate, title and changes`)
    }
    try { releaseMetadata(entry) }
    catch (error) { throw new Error(`${label}: ${error.message}`, { cause: error }) }
    if (versions.has(entry.version)) throw new Error(`${label} duplicates version ${entry.version}`)
    versions.add(entry.version)
    if (previousDate !== null && entry.releaseDate > previousDate) throw new Error('release-notes.json must be newest first by releaseDate')
    previousDate = entry.releaseDate
    if (!text(entry.title, 80)) throw new Error(`${label} title must be nonblank text of at most 80 characters, without placeholders`)
    if (!Array.isArray(entry.changes) || entry.changes.length < 1 || entry.changes.length > 8
      || entry.changes.some((change) => !text(change, 220))) {
      throw new Error(`${label} changes must contain 1–8 nonblank items of at most 220 characters, without placeholders`)
    }
  }
  if (notes[0].version !== current.version || notes[0].releaseDate !== current.releaseDate) {
    throw new Error('release-notes.json newest entry version and releaseDate must match package.json')
  }
  return notes
}

export function readReleaseNotes(root, release = releaseMetadata(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')))) {
  return validateReleaseNotes(JSON.parse(readFileSync(join(root, 'release-notes.json'), 'utf8')), release)
}
