import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const generator = fileURLToPath(new URL('./gen_announcer.mjs', import.meta.url))
const fakeKey = 'sk_announcer_generator_regression_fixture'

function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'brawlock-announcer-'))
  try {
    const envFile = join(dir, '.env')
    writeFileSync(envFile, `ELEVEN_LABS_API_KEY=${fakeKey}\n`)
    const mock = join(dir, 'mock.mjs')
    writeFileSync(mock, `
      globalThis.fetch = async (url, options) => {
        console.log('REQUEST ' + JSON.stringify({ url, ...options }));
        return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
      };
    `)
    const invoke = (...args) => {
      const result = spawnSync(process.execPath, ['--import', mock, generator, '--voice', 'fixture-voice', '--name', 'maverick', '--out', join(dir, 'raw'), ...args], {
        env: { ...process.env, ELEVENLABS_API_KEY: '', ELEVEN_LABS_API_KEY: '', ELEVENLABS_ENV_FILE: envFile },
        encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stderr)
      return result.stdout.split('\n').filter((line) => line.startsWith('REQUEST ')).map((line) => JSON.parse(line.slice(8)))
    }
    run({ dir, invoke })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('pack 2 sends the credential for ordinary and key lines and preserves completed takes', () => fixture(({ invoke }) => {
  const requests = invoke('--pack', '2', '--takes', '1', '--key-takes', '2')
  assert.equal(requests.length, 28)
  for (const request of requests) assert.equal(request.headers['xi-api-key'], fakeKey)
  assert.equal(requests.filter((r) => JSON.parse(r.body).text === 'Fight!').length, 2)
  assert.equal(requests.filter((r) => JSON.parse(r.body).text === 'Round One!').length, 1)
  assert.deepEqual(invoke('--pack', '2', '--takes', '1', '--key-takes', '2'), [])
}))

test('custom narration retains the exact line and voice settings beside its raw take', () => fixture(({ dir, invoke }) => {
  const requests = invoke('--only', 'thunder', '--text', 'Make your own thunder.', '--style', '0.55', '--stability', '0.45')
  assert.equal(requests.length, 1)
  const body = JSON.parse(requests[0].body)
  assert.equal(body.text, 'Make your own thunder.')
  assert.equal(body.model_id, 'eleven_multilingual_v2')
  assert.deepEqual(body.voice_settings, { stability: 0.45, similarity_boost: 0.75, style: 0.55 })
  assert.match(readFileSync(join(dir, 'raw/thunder_take1.prompt.txt'), 'utf8'), /Make your own thunder\./)
}))
