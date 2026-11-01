// Temporary directories for server tests (plain JS: @types/node is not a dependency).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gunzipSync, gzipSync } from 'node:zlib'

export function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function removeDir(dir) {
  rmSync(dir, { recursive: true, force: true })
}

/** A file in a test directory. */
export function writeTestFile(dir, name, text) {
  writeFileSync(join(dir, name), text)
}

/** gzip + base64 and back, as the daily's tapes travel. */
export function gzipBase64(text) {
  return gzipSync(text).toString('base64')
}
export function gunzipBase64(b64) {
  return gunzipSync(Buffer.from(b64, 'base64')).toString('utf8')
}

/** Raw SQLite fixtures use the same Node-only test bridge as temporary directories. */
export function openTestDatabase(file) {
  return new DatabaseSync(file)
}
