import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { releaseMetadata, readReleaseMetadata, readReleaseNotes, validateReleaseNotes } from './release-version.mjs'

const pkg = { version: '0.1.0-alpha.6', releaseDate: '2026-10-20' }
const release = releaseMetadata(pkg)
const notes = () => [
  { ...pkg, title: 'Match records and lobby browsing', changes: ['Departing ranked players retain their match result.', 'Browse your record while waiting for a match.'] },
  { version: '0.1.0-alpha.5', releaseDate: '2026-10-19', title: 'Arena polish', changes: ['Improved spell effects and match feedback.'] },
]
function directory(run) {
  const root = mkdtempSync(join(tmpdir(), 'brawlock-release-notes-'))
  try { return run(root) } finally { rmSync(root, { recursive: true, force: true }) }
}
const write = (root, filename, value) => writeFileSync(join(root, filename), JSON.stringify(value))

test('accepts current release and older real dates, preserving the checked-in history', () => {
  const history = notes()
  history.push({ version: '0.1.0-alpha.4', releaseDate: '2026-10-19', title: 'Earlier arena update', changes: ['Improved room controls.'] })
  history.push({ version: '0.0.1', releaseDate: '2024-02-29', title: 'First arena', changes: ['Added the playable arena.'] })
  assert.equal(validateReleaseNotes(history, release), history)
})

test('metadata reads fail when notes are missing, while version-only metadata remains independent', () => directory((root) => {
  write(root, 'package.json', pkg)
  assert.deepEqual(releaseMetadata(pkg), release)
  assert.throws(() => readReleaseMetadata(root), /ENOENT.*release-notes\.json/)
  assert.throws(() => readReleaseNotes(root), /ENOENT.*release-notes\.json/)
}))

test('both metadata and notes readers validate the current package version and date', () => directory((root) => {
  write(root, 'package.json', pkg)
  write(root, 'release-notes.json', notes())
  assert.deepEqual(readReleaseMetadata(root), release)
  assert.deepEqual(readReleaseNotes(root), notes())
  assert.deepEqual(readReleaseNotes(root, release), notes())
  for (const changed of [{ version: '0.1.0-alpha.7' }, { releaseDate: '2026-10-21' }]) {
    write(root, 'package.json', { ...pkg, ...changed })
    assert.throws(() => readReleaseMetadata(root), /newest entry version and releaseDate must match/)
  }
}))

test('rejects malformed history, missing or extra entry fields and duplicate versions', () => {
  for (const history of [null, {}, [], [null], [{ ...notes()[0], internal: true }], [{ ...pkg, title: 'Arena update' }]]) {
    assert.throws(() => validateReleaseNotes(history, release))
  }
  assert.throws(() => validateReleaseNotes([notes()[0], { ...notes()[1], version: pkg.version }], release), /duplicates version/)
})

test('rejects stale notes, invalid semantic versions, impossible dates and out-of-order history', () => {
  for (const changed of [{ version: '0.1.0-alpha.5' }, { releaseDate: '2026-10-19' }]) {
    assert.throws(() => validateReleaseNotes([{ ...notes()[0], ...changed }], release), /newest entry version and releaseDate must match/)
  }
  for (const version of ['0.1', 'v0.1.0', '0.1.0-alpha.01']) {
    assert.throws(() => validateReleaseNotes([notes()[0], { ...notes()[1], version }], release), /semantic version/)
  }
  assert.throws(() => validateReleaseNotes([notes()[0], { ...notes()[1], releaseDate: '2026-02-29' }], release), /real YYYY-MM-DD/)
  assert.throws(() => validateReleaseNotes([notes()[0], { ...notes()[1], releaseDate: '2026-10-21' }], release), /newest first/)
})

test('requires concise nonblank titles and one to eight concise nonblank changes', () => {
  for (const title of ['', '  ', 'a'.repeat(81), 'Two\nlines']) {
    assert.throws(() => validateReleaseNotes([{ ...notes()[0], title }], release), /title/)
  }
  for (const changes of [null, [], [''], ['  '], ['a'.repeat(221)], Array(9).fill('Changed the arena.'), ['Two\nlines']]) {
    assert.throws(() => validateReleaseNotes([{ ...notes()[0], changes }], release), /changes/)
  }
})

test('rejects placeholder titles and changes in current and historical entries', () => {
  for (const placeholder of ['TODO: write the release notes', 'TBD', 'FIXME', 'Lorem ipsum', 'Placeholder', 'Coming soon', '…']) {
    assert.throws(() => validateReleaseNotes([{ ...notes()[0], title: placeholder }], release), /without placeholders/)
    assert.throws(() => validateReleaseNotes([{ ...notes()[0], changes: [placeholder] }], release), /without placeholders/)
    assert.throws(() => validateReleaseNotes([notes()[0], { ...notes()[1], changes: [placeholder] }], release), /without placeholders/)
  }
})
