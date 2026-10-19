import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { acquireFleetLock, assertStopSafety, command, parseOptions, runStages, validateConfig, workflowMatchesConfig } from './release.mjs'

const config = JSON.parse(readFileSync(new URL('./release.config.json', import.meta.url), 'utf8'))
const temp = () => mkdtempSync(join(tmpdir(), 'brawlock-release-test-'))
const quiet = () => {}

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
