import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { acquireFleetLock, assertStopSafety, command, parseOptions, runStages, validateConfig, workflowMatchesConfig } from './release.mjs'
import { releaseMetadata, readReleaseMetadata } from '../scripts/release-version.mjs'
import { releaseTag, tagReceipt } from './release-tags.mjs'

const config = JSON.parse(readFileSync(new URL('./release.config.json', import.meta.url), 'utf8'))
const temp = () => mkdtempSync(join(tmpdir(), 'brawlock-release-test-'))
const quiet = () => {}

test('release metadata is explicit, valid SemVer and a real calendar date', () => {
  const expected = { version: '0.1.0-alpha.1', releaseDate: '2026-10-19', tag: 'v0.1.0-alpha.1' }
  assert.deepEqual(releaseMetadata(expected), expected)
  assert.equal(releaseMetadata({ version: '1.2.3-rc.2+build.01', releaseDate: '2024-02-29' }).tag, 'v1.2.3-rc.2+build.01')
  for (const version of ['v1.0.0', '01.0.0', '1.0', '1.0.0-alpha.01', '1.0.0-']) {
    assert.throws(() => releaseMetadata({ ...expected, version }), /semantic version/)
  }
  for (const releaseDate of [undefined, '2026-02-29', '2026-04-31', '2026-1-19', 'today']) {
    assert.throws(() => releaseMetadata({ ...expected, releaseDate }), /real YYYY-MM-DD/)
  }
  const pkg = readReleaseMetadata(resolve('.'))
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
  assert.equal(pkg.version, lock.version)
  assert.equal(pkg.version, lock.packages[''].version)
})

const tagIdentity = { repository: 'laubsauger/brawlock', tag: 'v0.1.0-alpha.1', revision: 'a'.repeat(40) }
const tagRef = (sha = tagIdentity.revision, type = 'commit') => ({ ref: `refs/tags/${tagIdentity.tag}`, object: { sha, type } })

test('tag preflight distinguishes an absent exact tag from prefix matches, conflicts and API failures', async () => {
  const calls = []
  const run = async (cmd, args) => { calls.push([cmd, ...args]); return JSON.stringify([{ ...tagRef(), ref: `refs/tags/${tagIdentity.tag}0` }]) }
  assert.equal((await releaseTag(tagIdentity, run)).published, false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'gh')
  await assert.rejects(releaseTag(tagIdentity, async () => JSON.stringify([tagRef('b'.repeat(40))])), /different revision/)
  await assert.rejects(releaseTag(tagIdentity, async () => { throw new Error('API unavailable') }), /API unavailable/)
  await assert.rejects(releaseTag(tagIdentity, async () => '{}'), /Invalid GitHub tag response/)
})

test('tag publication creates only an absent immutable ref and is idempotent on retry', async () => {
  const calls = []
  let exists = false
  const run = async (cmd, args) => {
    calls.push([cmd, ...args])
    if (args.includes('POST')) { exists = true; return JSON.stringify(tagRef()) }
    return JSON.stringify(exists ? [tagRef()] : [])
  }
  assert.equal((await releaseTag({ ...tagIdentity, publish: true }, run)).published, true)
  assert.equal((await releaseTag({ ...tagIdentity, publish: true }, run)).published, true)
  assert.equal(calls.filter((call) => call.includes('POST')).length, 1)
  assert.ok(calls.every((call) => !call.includes('PATCH') && !call.includes('DELETE')))
  assert.ok(calls[1].includes(`sha=${tagIdentity.revision}`))
})

test('annotated release tags resolve to their commit before checking version reuse', async () => {
  const calls = []
  const result = await releaseTag(tagIdentity, async (_cmd, args) => {
    calls.push(args)
    return JSON.stringify(args[1].includes('/commits/') ? { sha: tagIdentity.revision } : [tagRef('b'.repeat(40), 'tag')])
  })
  assert.equal(result.published, true)
  assert.equal(calls.length, 2)
})

test('only completed fleet receipts can publish; publication failure preserves proof for metadata-only retry', async () => {
  const receipt = { ...tagIdentity, version: '0.1.0-alpha.1', releaseDate: '2026-10-19', proof: { ok: true, regions: [{ draining: false }] } }
  let calls = 0
  const run = async () => { calls++; throw new Error('API unavailable') }
  for (const proof of [undefined, { ok: false }, { ok: true, regions: [] }, { ok: true, regions: [{ draining: true }] }]) {
    await assert.rejects(tagReceipt({ ...receipt, proof }, tagIdentity.repository, run), /completed, reopened/)
  }
  assert.equal(calls, 0)
  const original = structuredClone(receipt)
  await assert.rejects(tagReceipt(receipt, tagIdentity.repository, run), /API unavailable/)
  assert.deepEqual(receipt, original)
  const result = await tagReceipt(receipt, tagIdentity.repository, async () => JSON.stringify([tagRef()]))
  assert.equal(result.published, true)
  assert.deepEqual(receipt, original)
})

test('fleet verification CLI runs through a symlink instead of silently returning success', () => {
  const dir = temp()
  try {
    const alias = join(dir, 'fleet-alias.mjs')
    symlinkSync(realpathSync(new URL('../scripts/release/verify-fleet.mjs', import.meta.url)), alias)
    const result = spawnSync(process.execPath, [alias, 'invalid'], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(JSON.parse(result.stderr).ok, false)
    assert.match(JSON.parse(result.stderr).error, /Usage:/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('explicit apply; strict options/config and workflow fleet binding', () => {
  assert.equal(parseOptions(['--revision', 'abcdef0']).apply, false)
  assert.equal(parseOptions(['--revision', 'abcdef0', '--apply']).apply, true)
  assert.throws(() => parseOptions(['--revision', 'main', '--apply']))
  assert.throws(() => parseOptions(['--revision', 'abcdef0', '--apply', '--apply']))
  assert.equal(validateConfig(config), config)
  assert.throws(() => validateConfig({ ...config, appOrigin: 'https://brawlock.osc.link/other' }))
  const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8')
  workflowMatchesConfig(workflow, config)
  const changed = structuredClone(config)
  changed.regions[1].label = 'Something else'
  assert.throws(() => workflowMatchesConfig(workflow, changed), /differs/)
})

test('fake command failure before drain never stops/deploys/reopens; resume skips completed gates', async () => {
  const state = { steps: {} }, calls = []
  let failBuild = true
  const fake = async (name) => { calls.push(name); if (name === 'build' && failBuild) throw new Error('injected build failure'); return true }
  const stages = ['archive', 'build', 'drain', 'stop', 'deploy', 'reopen'].map((id) => ({ id, run: () => fake(id) }))
  await assert.rejects(runStages(stages, state, quiet, () => fake('keep-drained'), quiet), /injected/)
  assert.deepEqual(calls, ['archive', 'build'])
  failBuild = false
  await runStages(stages, state, quiet, () => fake('keep-drained'), quiet)
  assert.deepEqual(calls, ['archive', 'build', 'build', 'drain', 'stop', 'deploy', 'reopen'])
})

test('fake account deploy failure preserves backup checkpoint and keeps drained, without reopening', async () => {
  const state = { steps: {}, drainStarted: false }, calls = []
  let failDeploy = true
  const fake = async (name) => {
    calls.push(name)
    if (name === 'drain') state.drainStarted = true
    if (name === 'accounts' && failDeploy) throw new Error('injected account failure')
    return { receipt: name }
  }
  const stages = ['drain', 'stop', 'backup', 'accounts', 'game', 'reopen:us', 'final-proof'].map((id) => ({ id, run: () => fake(id) }))
  await assert.rejects(runStages(stages, state, quiet, () => fake('keep-drained'), quiet), /injected/)
  assert.deepEqual(calls, ['drain', 'stop', 'backup', 'accounts', 'keep-drained'])
  assert.deepEqual(state.steps.backup, { receipt: 'backup' })
  failDeploy = false
  await runStages(stages, state, quiet, () => fake('keep-drained'), quiet)
  assert.equal(calls.filter((id) => id === 'backup').length, 1)
  assert.deepEqual(calls.slice(-4), ['accounts', 'game', 'reopen:us', 'final-proof'])
})

test('failure after partial reopen re-drains and invalidates reopen records for retry', async () => {
  const state = { steps: { 'reopen:us': true }, drainStarted: true }, calls = []
  const stages = [{ id: 'final-proof', run: async () => { throw new Error('injected proof failure') } }]
  await assert.rejects(runStages(stages, state, quiet, async () => calls.push('drain-all'), quiet), /injected/)
  assert.deepEqual(calls, ['drain-all'])
  assert.equal(Object.hasOwn(state.steps, 'reopen:us'), false)
  assert.equal(Object.hasOwn(state.steps, 'final-proof'), false)
})

test('fresh live readiness overrides journaled ready before stop; no HTTP failure is treated as empty', async () => {
  const regions = [{ id: 'us' }, { id: 'eu' }]
  const state = { steps: { ready: true, 'stop:us': true } }
  const inspect = async (r) => ({ game: { status: r.id === 'us' ? 'stopped' : 'online' } })
  await assert.rejects(assertStopSafety(regions, state, inspect, async () => ({ draining: false, ready: false })), /no longer drained/)
  await assert.rejects(assertStopSafety(regions, state, inspect, async () => { throw new Error('HTTP unavailable') }), /HTTP unavailable/)
  await assertStopSafety(regions, state, inspect, async () => ({ draining: true, ready: true }))
  await assert.rejects(assertStopSafety(regions, { steps: { ready: true } }, inspect, async () => ({ draining: true, ready: true })), /outside this release/)
})

test('receipt journal-write failure also re-drains and clears terminal completion checkpoints', async () => {
  const state = { steps: { 'reopen:us': true, 'final-proof': { ok: true } }, drainStarted: true }
  let writes = 0, drains = 0
  await assert.rejects(runStages([{ id: 'receipt', run: async () => ({ file: 'receipt.json' }) }], state,
    () => { if (++writes === 1) throw new Error('injected journal write failure') }, async () => { drains++ }, quiet), /injected/)
  assert.equal(drains, 1)
  assert.equal(Object.hasOwn(state.steps, 'receipt'), false)
  assert.equal(Object.hasOwn(state.steps, 'final-proof'), false)
  assert.equal(Object.hasOwn(state.steps, 'reopen:us'), false)
})

test('command drains large stdout/stderr before resolving and closes timeout resources', async () => {
  const dir = temp()
  try {
    const text = await command(process.execPath, ['-e', 'process.stderr.write("e".repeat(256*1024));process.stdout.write("x".repeat(1024*1024),()=>process.exit(0))'], { logDir: dir })
    assert.equal(text.length, 1024 * 1024)
    const start = Date.now()
    await assert.rejects(command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100, logDir: dir }), /failed/)
    assert.ok(Date.now() - start < 3000)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('frozen detached Git metadata/index stays on approved commit while checkout/main advance', async () => {
  const dir = temp(), cwd = resolve(new URL('..', import.meta.url).pathname)
  try {
    const revision = await command('git', ['rev-parse', 'HEAD~1'], { cwd })
    const latest = await command('git', ['rev-parse', 'HEAD'], { cwd })
    assert.notEqual(revision, latest)
    const metadata = join(dir, 'metadata'), source = join(dir, 'source')
    mkdirSync(source)
    const isolatedGit = Object.fromEntries(Object.keys(process.env).filter((key) => key.startsWith('GIT_')).map((key) => [key, undefined]))
    await command('git', ['init', '--bare', '--quiet', metadata], { env: isolatedGit })
    const common = resolve(cwd, await command('git', ['rev-parse', '--git-common-dir'], { cwd }))
    writeFileSync(join(metadata, 'HEAD'), revision + '\n')
    writeFileSync(join(metadata, 'objects/info/alternates'), join(common, 'objects') + '\n')
    mkdirSync(join(metadata, 'refs/remotes/origin'), { recursive: true })
    writeFileSync(join(metadata, 'refs/remotes/origin/main'), latest + '\n')
    const env = { GIT_DIR: metadata, GIT_WORK_TREE: source, GIT_INDEX_FILE: join(dir, 'index') }
    await command('git', ['read-tree', revision], { env })
    assert.equal(await command('git', ['rev-parse', 'HEAD'], { env }), revision)
    assert.equal(await command('git', ['rev-parse', 'origin/main'], { env }), latest)
    assert.equal(await command('git', ['rev-parse', '--show-toplevel'], { env }), realpathSync(source))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('exclusive fleet lock prevents parallel resumes and kernel releases it on process death', async () => {
  const origin = `https://${randomUUID()}.invalid`
  const unlock = await acquireFleetLock(origin)
  await assert.rejects(acquireFleetLock(origin), /lock unavailable/)
  await unlock()
  const moduleUrl = new URL('./release.mjs', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireFleetLock } from ${JSON.stringify(moduleUrl)};await acquireFleetLock(${JSON.stringify(origin)});console.log('locked')`], { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await new Promise((done, reject) => { child.stdout.once('data', done); child.once('error', reject); child.once('exit', () => reject(new Error('lock fixture exited early'))) })
    await assert.rejects(acquireFleetLock(origin), /lock unavailable/)
    const exited = new Promise((done) => child.once('exit', done))
    child.kill('SIGKILL'); await exited
    const release = await acquireFleetLock(origin)
    await release()
  } finally { child.kill('SIGKILL') }
})
