// Temporary directories for server tests (plain JS: @types/node is not a dependency).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function removeDir(dir) {
  rmSync(dir, { recursive: true, force: true })
}
