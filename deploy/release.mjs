#!/usr/bin/env node
// Routine releases and verified source tags. No provisioning, branch publication, history reset or rollback.
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, fsyncSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { releaseMetadata } from '../scripts/release-version.mjs'
import { releaseTag, tagReceipt } from './release-tags.mjs'

const toolDir = dirname(fileURLToPath(import.meta.url))
const usage = 'node deploy/release.mjs --revision SHA [--apply] [--resume JOURNAL_DIRECTORY] [--config FILE] [--admission]'
const fail = (message) => { throw new Error(message) }
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const hash = (file) => sha256(readFileSync(file))

export function parseOptions(args) {
  const result = { apply: false, admission: false, revision: '', config: join(toolDir, 'release.config.json'), resume: null }
  const seen = new Set()
  while (args.length) {
    const flag = args.shift()
    if (seen.has(flag)) fail('Duplicate release option')
    seen.add(flag)
    if (flag === '--apply') result.apply = true
    else if (flag === '--admission') result.admission = true
    else if (['--revision', '--config', '--resume'].includes(flag) && args.length) result[flag.slice(2)] = args.shift()
    else fail(usage)
  }
  if (!/^[a-f0-9]{7,40}$/.test(result.revision)) fail(usage)
  return result
}

export function validateConfig(config) {
  const origin = (value) => {
    const url = new URL(value)
    if (url.origin !== value || url.protocol !== 'https:') fail('Fleet app/region origins must be exact HTTPS origins')
  }
  origin(config.appOrigin)
  const media = new URL(config.mediaOrigin)
  if (media.protocol !== 'https:' || media.username || media.password || media.search || media.hash || !config.mediaOrigin.endsWith('/')) fail('Invalid media origin')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.github?.repository) || !/^[A-Za-z0-9_.-]+\.yml$/.test(config.github.workflow) || !/^[A-Za-z0-9_-]+$/.test(config.github.artifact)) fail('Invalid GitHub workflow configuration')
  // Existing helpers intentionally target these prepared Brawlock paths and runtime.
  if (config.appOrigin !== 'https://brawlock.osc.link' || config.mediaOrigin !== 'https://laubsauger.github.io/brawlock/' || config.webRoot !== '/var/www/brawlock'
    || config.backupRoot !== '/root/brawlock-backups' || JSON.stringify(config.runtime) !== JSON.stringify({ user: 'brawlock', home: '/var/lib/brawlock', pm2Home: '/var/lib/brawlock/.pm2' })) fail('Existing deployment helpers require the prepared Brawlock app/media/runtime paths')
  if (!Array.isArray(config.regions) || config.regions.length < 1 || config.regions.length > 8 || config.regions.filter((r) => r.globalAuthority === true).length !== 1) fail('Configure exactly one shared global authority')
  const ids = new Set(), hosts = new Set(), origins = new Set()
  for (const region of config.regions) {
    origin(region.origin)
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(region.id) || !/^[A-Za-z][A-Za-z0-9 -]{0,39}$/.test(region.label) || !/^root@[A-Za-z0-9.-]+$/.test(region.host)) fail('Invalid region identity/SSH host')
    if (ids.has(region.id) || hosts.has(region.host) || origins.has(region.origin)) fail('Duplicate region, host or origin')
    ids.add(region.id); hosts.add(region.host); origins.add(region.origin)
    if (region.game?.name !== 'brawlock-server' || region.game.config !== '/etc/brawlock/ecosystem.config.cjs' || !/^\/opt\/apps\/[A-Za-z0-9_-]+$/.test(region.game.dir) || !Number.isInteger(region.game.port) || region.game.port < 1 || region.game.port > 65535) fail('Invalid prepared game configuration')
    if (region.globalAuthority ? region.accounts?.name !== 'brawlock-accounts' || region.accounts.dir !== '/opt/apps/brawlock-accounts' || region.accounts.config !== '/etc/brawlock/accounts.config.cjs' : region.accounts !== undefined) fail('Only the shared authority may configure the prepared account service')
  }
  return config
}

function manifest(dir) {
  const result = {}
  function walk(base) {
    for (const name of readdirSync(base).sort()) {
      const file = join(base, name), stat = lstatSync(file)
      if (stat.isSymbolicLink()) result[relative(dir, file)] = sha256(`symlink:${readlinkSync(file)}`)
      else if (stat.isDirectory()) walk(file)
      else if (stat.isFile()) result[relative(dir, file)] = hash(file)
      else fail('Unexpected artifact file type')
    }
  }
  walk(dir)
  return result
}

function save(file, value) {
  const pending = file + '.next'
  const fd = openSync(pending, 'w', 0o600)
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(pending, file)
}

// Exported for failure-injection tests; production supplies the concrete phase list below.
export async function runStages(stages, state, persist, keepDrained, progress = console.log) {
  try {
    for (const { id, run } of stages) {
      if (Object.hasOwn(state.steps, id)) { progress(`Already complete: ${id}`); continue }
      progress(`Release: ${id}`)
      state.steps[id] = (await run()) ?? true
      delete state.error
      persist()
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : 'Release phase failed'
    if (state.drainStarted) {
      try { await keepDrained() } catch { state.drainError = 'Could not confirm every region remains drained' }
      for (const key of Object.keys(state.steps)) if (key.startsWith('reopen:') || key === 'final-proof' || key === 'receipt') delete state.steps[key]
    }
    persist()
    throw error
  }
}

export async function command(cmd, args, { cwd, env = {}, input, logDir, label = cmd, timeout = 20 * 60 * 1000 } = {}) {
  return new Promise((done, reject) => {
    const fd = logDir ? openSync(join(logDir, `${Date.now()}-${randomUUID().slice(0, 8)}.log`), 'wx', 0o600) : null
    const child = spawn(cmd, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', ...env }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', size = 0, finished = false
    const kill = (signal) => { try { process.kill(-child.pid, signal) } catch {} }
    const timer = setTimeout(() => { kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 2000).unref() }, timeout)
    const finish = (error) => {
      if (finished) return
      finished = true; clearTimeout(timer)
      if (fd !== null) closeSync(fd)
      error ? reject(error) : done(output.trim())
    }
    child.stdout.on('data', (chunk) => {
      if (finished) return
      if (fd !== null) writeFileSync(fd, chunk)
      size += chunk.length
      if (size > 8 * 1024 * 1024) { kill('SIGTERM'); finish(new Error(`${label}: output limit exceeded`)); return }
      output += chunk
    })
    child.stderr.on('data', (chunk) => { if (!finished && fd !== null) writeFileSync(fd, chunk) })
    child.once('error', () => finish(new Error(`${label}: command unavailable`)))
    child.once('close', (code, signal) => finish(code === 0 ? null : new Error(`${label} failed (${signal ?? code}); inspect private release logs`)))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

// A kernel-owned local lock survives neither exit nor SIGKILL. No stale lock-file guessing.
export async function acquireFleetLock(appOrigin) {
  const port = 40000 + Number.parseInt(sha256(appOrigin).slice(0, 8), 16) % 20000
  const server = createServer((socket) => socket.destroy())
  await new Promise((done, reject) => {
    server.once('error', () => reject(new Error(`Fleet release lock unavailable on local port ${port}; another release or process is using it`)))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, done)
  })
  return () => new Promise((done, reject) => server.close((error) => error ? reject(error) : done()))
}

export function workflowMatchesConfig(text, config) {
  const servers = /VITE_GAME_SERVERS:\s*'([^'\n]+)'/.exec(text)
  const assets = /VITE_ASSET_BASE_URL:\s*'([^'\n]+)'/.exec(text)
  const accounts = /VITE_ACCOUNTS_ENABLED:\s*'([^'\n]+)'/.exec(text)
  const expected = config.regions.map((r) => ({ id: r.id, label: r.label, url: r.origin.replace(/^https:/, 'wss:') }))
  if (!servers || JSON.stringify(JSON.parse(servers[1])) !== JSON.stringify(expected) || assets?.[1] !== config.mediaOrigin || accounts?.[1] !== 'true') fail('Fleet configuration differs from the approved Pages workflow build settings; update both explicitly')
}

export async function assertStopSafety(regions, state, inspect, maintenance) {
  for (const region of regions) {
    const actual = await inspect(region)
    if (actual.game.status === 'stopped') {
      if (!state.steps[`stop:${region.id}`] && !state.stopIntents?.[region.id]) fail('A game was stopped outside this release journal')
    } else {
      if (actual.game.status !== 'online') fail('Unexpected game process state before stopping')
      const value = await maintenance(region)
      if (!value.draining || !value.ready) fail('Live maintenance is no longer drained and ready; finish active matches/deliveries before resuming')
    }
  }
}

async function requestJson(url) {
  const response = await fetch(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000) })
  if (!response.ok) { await response.body?.cancel(); fail(`Public verification failed: HTTP ${response.status}`) }
  const text = await response.text()
  if (text.length > 1024 * 1024) fail('Unexpected public verification response size')
  try { return JSON.parse(text) } catch { fail('Invalid public verification JSON') }
}

async function poll(test, description, timeout, interval = 5000) {
  const deadline = Date.now() + timeout
  let nextProgress = 0
  do {
    const result = await test()
    if (result) return result
    if (Date.now() >= nextProgress) { console.log(`Waiting: ${description}`); nextProgress = Date.now() + 15000 }
    await sleep(interval)
  } while (Date.now() < deadline)
  fail(`Timed out: ${description}`)
}

export async function main(args = process.argv.slice(2)) {
  const opts = parseOptions(args)
  const config = validateConfig(readJson(resolve(opts.config)))
  if (Number(process.versions.node.split('.')[0]) < 22) fail('Node 22+ is required')
  if (opts.admission) {
    const [major, minor] = process.versions.node.split('.').map(Number)
    if (major < 24 || major === 24 && minor < 11) fail('--admission requires Node 24.11+')
  }
  const repo = await command('git', ['rev-parse', '--show-toplevel'])
  const revision = await command('git', ['rev-parse', '--verify', `${opts.revision}^{commit}`], { cwd: repo })
  const release = releaseMetadata(JSON.parse(await command('git', ['show', `${revision}:package.json`], { cwd: repo })))
  const head = await command('git', ['rev-parse', 'HEAD'], { cwd: repo })
  const blockers = []
  if (revision !== head) blockers.push('The requested revision must be the current HEAD; no checkout/reset is performed')
  if (await command('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repo })) blockers.push('Tracked changes are present; review and commit them before a release')
  const required = ['deploy/release.mjs', 'deploy/release.test.mjs', 'deploy/release-tags.mjs', 'scripts/release-version.mjs', 'deploy/release-remote.cjs', 'deploy/release.config.json', 'scripts/release/verify-fleet.mjs', 'deploy/deploy.sh', 'deploy/accounts.sh', 'deploy/web.sh', 'deploy/maintenance.sh']
  const tracked = (await command('git', ['ls-files', '--', ...required], { cwd: repo })).split('\n')
  if (required.some((file) => !tracked.includes(file))) blockers.push('The orchestrator and every deployment helper must already be committed in the approved revision')
  const remote = await command('git', ['remote', 'get-url', 'origin'], { cwd: repo })
  if (![ `https://github.com/${config.github.repository}.git`, `https://github.com/${config.github.repository}`, `git@github.com:${config.github.repository}.git` ].includes(remote)) fail('origin does not match the configured GitHub repository')
  if (opts.apply && !opts.resume) {
    if (blockers.length) fail(blockers.join('; '))
    const published = await command('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'], { cwd: repo })
    if (published.split(/\s/)[0] !== revision) fail('The exact requested revision must already be the origin/main tip; this tool never commits or pushes')
  }
  const authority = config.regions.find((r) => r.globalAuthority)
  const ordered = [authority, ...config.regions.filter((r) => r !== authority)]
  const plan = [ 'archive approved source; npm ci; serial regression tests; typecheck; client/game/account builds',
    'monitor existing exact-SHA Pages workflow and download its matching first-party artifact',
    'inspect prepared runtimes and stage the matching website', 'drain all regions; wait for complete matches and all deliveries',
    'stop game processes and account authority; save private consistent backups',
    'deploy changed account bundle; deploy and verify global authority game then other regions',
    'verify hashes, protocol, shared leaderboard and matching Pages media; activate first-party website',
    'verify app/media versions; reopen regions; final fleet verification; write receipt',
    `publish immutable ${release.tag} source tag after successful proof (metadata-only retry on failure)` ]
  if (!opts.apply) {
    console.log(JSON.stringify({ mode: 'plan', revision, ...release, regions: ordered.map(({ id, host, origin, globalAuthority }) => ({ id, host, origin, globalAuthority })), stages: plan,
      resume: opts.resume ? resolve(opts.resume) : null, admission: opts.admission, blockers: opts.resume ? [] : blockers, note: 'No builds, network calls, remote changes or workflow dispatch. A new apply additionally verifies the live origin/main tip and SSH keys, and requires an existing exact-SHA Pages run. Resume uses its frozen approved revision.' }, null, 2))
    return
  }
  const unlock = await acquireFleetLock(config.appOrigin)
  try {
  process.umask(0o077)
  const requestedDir = opts.resume ? resolve(opts.resume) : mkdtempSync(join(tmpdir(), 'brawlock-release-'))
  if (lstatSync(requestedDir).isSymbolicLink()) fail('Release journal directory must not be a symlink')
  const dir = realpathSync(requestedDir)
  const stateFile = join(dir, 'journal.json')
  const toolHash = sha256([fileURLToPath(import.meta.url), join(toolDir, 'release-remote.cjs'), join(toolDir, 'release-tags.mjs'), join(toolDir, '../scripts/release-version.mjs')].map((file) => readFileSync(file).toString()).join('\n'))
  const state = opts.resume ? readJson(stateFile) : { v: 1, revision, toolHash, configHash: sha256(JSON.stringify(config)), releaseId: `${new Date().toISOString().replace(/[-:.]/g, '')}-${revision.slice(0, 12)}`, admission: opts.admission, steps: {} }
  if (state.v !== 1 || state.revision !== revision || state.toolHash !== toolHash || state.configHash !== sha256(JSON.stringify(config)) || state.admission !== opts.admission) fail('Resume journal/revision/tool/config/admission mismatch')
  if (lstatSync(dir).isSymbolicLink() || (lstatSync(dir).mode & 0o777) !== 0o700) fail('Release journal directory must have mode 0700')
  mkdirSync(join(dir, 'logs'), { recursive: true, mode: 0o700 })
  const publishTag = async () => {
    const receiptFile = join(dir, 'receipt.json')
    const receipt = readJson(receiptFile)
    if (receipt.revision !== revision || Object.keys(release).some((key) => receipt[key] !== release[key])) fail('Release receipt version/revision mismatch')
    try {
      receipt.tagPublication = await tagReceipt(receipt, config.github.repository, (cmd, args) => command(cmd, args, { cwd: repo, logDir: join(dir, 'logs') }))
      save(receiptFile, receipt)
    } catch (error) {
      throw new Error(`Deployment is verified and regions are open; release tag publication failed. Resume this journal to retry publication only. ${error.message}`)
    }
  }
  if (state.steps.receipt && !state.error) {
    const receipt = readJson(join(dir, 'receipt.json'))
    if (receipt.revision !== revision || receipt.net !== state.steps.build.net) fail('Completed release receipt does not match its journal')
    await publishTag()
    console.log(JSON.stringify({ ok: true, alreadyCompleted: true, receipt: join(dir, 'receipt.json'), revision, ...release, note: 'Retained original deployment evidence and confirmed its immutable tag; no new deployment or fleet verification was performed.' }))
    return
  }
  const persist = () => save(stateFile, state)
  persist()
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
  const resumeArgs = [process.execPath, fileURLToPath(import.meta.url), '--revision', revision, '--apply', '--resume', dir, '--config', resolve(opts.config), ...(opts.admission ? ['--admission'] : [])]
  console.log(`Release journal: ${dir}\nResume: ${resumeArgs.map(quote).join(' ')}`)
  await releaseTag({ repository: config.github.repository, tag: release.tag, revision }, (cmd, args) => command(cmd, args, { cwd: repo, logDir: join(dir, 'logs') }))
  const source = join(dir, 'source'), build = revision.slice(0, 12), packageDir = join(dir, 'deploy-package')
  const publicVersionMatches = (value) => value.build === build && Object.keys(release).every((key) => value[key] === release[key])
  const gitDir = join(dir, 'git-metadata')
  const env = { GIT_DIR: gitDir, GIT_WORK_TREE: source, GIT_INDEX_FILE: join(dir, 'git-index'), GITHUB_SHA: revision, GITHUB_REPOSITORY: config.github.repository,
    VITE_GAME_SERVERS: JSON.stringify(config.regions.map((r) => ({ id: r.id, label: r.label, url: r.origin.replace(/^https:/, 'wss:') }))), VITE_ACCOUNTS_ENABLED: 'true', VITE_ASSET_BASE_URL: config.mediaOrigin,
    RSYNC_RSH: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes' }
  const run = (cmd, args, extra = {}) => command(cmd, args, { cwd: source, env, logDir: join(dir, 'logs'), ...extra })
  const snapshot = () => {
    for (const [file, expected] of Object.entries(state.steps.archive.files)) {
      const target = join(source, file)
      if (!existsSync(target) || hash(target) !== expected) fail('Frozen source changed; refusing deployment')
    }
  }
  const helper = async (script, region, args = []) => {
    snapshot()
    return run('bash', [join(source, 'deploy', script), ...args], { env: { ...env, DEPLOY_HOST: region.host, DOMAIN: new URL(region.origin).hostname, REGION: region.id, PORT: String(region.game.port), APP_DIR: region.game.dir } })
  }
  const remoteOp = async (region, op, extra = {}) => {
    const remoteSource = readFileSync(join(source, 'deploy/release-remote.cjs'))
    if (sha256(remoteSource) !== state.steps.archive.files['deploy/release-remote.cjs']) fail('Frozen remote helper changed; refusing root SSH operation')
    const payload = Buffer.from(JSON.stringify({ op, region, runtime: config.runtime, backupRoot: config.backupRoot, webRoot: config.webRoot, releaseId: state.releaseId, revision, build, ...extra })).toString('base64')
    return JSON.parse(await run('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', region.host, `node - '${payload}'`], { input: remoteSource, label: `${region.id} ${op}`, timeout: 120000 }))
  }
  const maintenance = async (region, action) => {
    const value = JSON.parse(await helper('maintenance.sh', region, [action]))
    if (value.region !== region.id) fail('Maintenance response region does not match the configured host')
    return value
  }
  const fleetArgs = () => [join(source, 'scripts/release/verify-fleet.mjs'), state.steps.build.net, String(state.steps.build.protocol), ...ordered.map((r) => `${r.id}=${r.origin}`), '--origin', config.appOrigin]
  const readyToStop = () => assertStopSafety(ordered, state, (region) => remoteOp(region, 'inspect'), (region) => maintenance(region, 'status'))
  const allGamesStopped = async () => {
    for (const region of ordered) {
      const actual = await remoteOp(region, 'inspect')
      if (actual.game.status !== 'stopped' || !state.steps[`stop:${region.id}`]) fail('Every journaled game process must still be stopped before account changes')
    }
  }
  const stage = (id, fn) => ({ id, run: fn })
  const stages = [
    stage('archive', async () => {
      // Only disposable, incomplete local outputs are replaced. Production backups/stages are never removed.
      rmSync(source, { recursive: true, force: true }); mkdirSync(source)
      await command('git', ['archive', '--format=tar', '--output', join(dir, 'source.tar'), revision], { cwd: repo })
      await command('tar', ['-xf', join(dir, 'source.tar'), '-C', source])
      // Private detached metadata/index lets existing helpers read the frozen SHA,
      // even if the shared checkout advances while a drained release is paused.
      rmSync(gitDir, { recursive: true, force: true })
      const isolatedGit = Object.fromEntries(Object.keys(process.env).filter((key) => key.startsWith('GIT_')).map((key) => [key, undefined]))
      await command('git', ['init', '--bare', '--quiet', gitDir], { cwd: repo, env: isolatedGit })
      const common = resolve(repo, await command('git', ['rev-parse', '--git-common-dir'], { cwd: repo }))
      writeFileSync(join(gitDir, 'HEAD'), revision + '\n')
      writeFileSync(join(gitDir, 'objects/info/alternates'), join(common, 'objects') + '\n')
      mkdirSync(join(gitDir, 'refs/remotes/origin'), { recursive: true })
      writeFileSync(join(gitDir, 'refs/remotes/origin/main'), revision + '\n')
      await command('git', ['read-tree', revision], { cwd: source, env })
      return { files: manifest(source) }
    }),
    stage('build', async () => {
      snapshot()
      workflowMatchesConfig(readFileSync(join(source, '.github/workflows/deploy.yml'), 'utf8'), config)
      await run('npm', ['ci'])
      await run(process.execPath, ['--test', '--test-concurrency=1', 'deploy/release.test.mjs', 'scripts/analytics-model.test.mjs', 'scripts/analytics-report.test.mjs'])
      await run('npm', ['test', '--', '--maxWorkers=1'])
      await run('npm', ['run', 'typecheck'])
      await run('npm', ['run', 'build', '--', '--base=/'])
      await run('npm', ['run', 'server:build'])
      await run('npm', ['run', 'accounts:build'])
      const packaged = join(dir, 'local-package')
      rmSync(packaged, { recursive: true, force: true })
      await run(process.execPath, ['scripts/package-client.mjs', 'dist', packaged])
      const version = readJson(join(source, 'dist-server/version.json'))
      const clientVersion = readJson(join(source, 'dist/version.json'))
      if (Object.keys(release).some((key) => version[key] !== release[key] || clientVersion[key] !== release[key])) fail('Client/server semantic release metadata mismatch')
      const protocol = /export const PROTOCOL_VERSION = (\d+)/.exec(readFileSync(join(source, 'src/net/protocol.ts'), 'utf8'))
      if (version.commit !== build || !/^[a-f0-9]{12}$/.test(version.net) || !protocol || readJson(join(source, 'dist/version.json')).build !== build) fail('Frozen build version/protocol mismatch')
      return { ...release, net: version.net, protocol: Number(protocol[1]), gameHash: hash(join(source, 'dist-server/server.mjs')), accountsHash: hash(join(source, 'dist-accounts/accounts.mjs')) }
    }),
    stage('pages-artifact', async () => {
      const base = ['--repo', config.github.repository]
      const existing = await poll(async () => {
        const runs = JSON.parse(await run('gh', ['run', 'list', ...base, '--workflow', config.github.workflow, '--commit', revision, '--limit', '20', '--json', 'databaseId,headSha,status,conclusion,url']))
        if (runs.some((item) => item.headSha !== revision)) fail('GitHub returned a different source revision')
        return runs[0]
      }, 'existing exact-SHA Pages run (no branch dispatch)', 60000)
      const completed = await poll(async () => {
        const value = JSON.parse(await run('gh', ['run', 'view', String(existing.databaseId), ...base, '--json', 'headSha,status,conclusion,url']))
        if (value.headSha !== revision) fail('Pages workflow source SHA mismatch')
        if (value.status !== 'completed') return false
        if (value.conclusion !== 'success') fail('Exact-SHA Pages workflow did not succeed; no dispatch or branch push is attempted')
        return value
      }, 'exact-SHA Pages publication', 20 * 60 * 1000)
      rmSync(packageDir, { recursive: true, force: true }); mkdirSync(packageDir)
      await run('gh', ['run', 'download', String(existing.databaseId), ...base, '--name', config.github.artifact, '--dir', join(packageDir, 'web')])
      const downloadedVersion = readJson(join(packageDir, 'web/version.json'))
      if (!publicVersionMatches(downloadedVersion)) fail('Downloaded workflow artifact build/version mismatch')
      cpSync(join(dir, 'local-package/hosting.json'), join(packageDir, 'hosting.json'))
      const files = manifest(join(packageDir, 'web'))
      if (Object.values(files).length === 0) fail('Empty workflow artifact')
      return { runId: existing.databaseId, url: completed.url, files }
    }),
    stage('inspect', async () => {
      const values = {}
      for (const region of ordered) {
        values[region.id] = await remoteOp(region, 'inspect')
        if (values[region.id].game.status !== 'online' || region.accounts && values[region.id].accounts.status !== 'online') fail('Prepared Brawlock applications must be online before a new release')
      }
      return { regions: values, accountsChanged: values[authority.id].accounts.hash !== state.steps.build.accountsHash }
    }),
    stage('stage-web', async () => {
      const claim = await remoteOp(authority, 'web-claim', { manifest: state.steps['pages-artifact'].files })
      if (!claim.exists) await helper('web.sh', authority, [packageDir, build, '--stage-only'])
      else await run('rsync', ['-az', '--checksum', `${packageDir}/web/`, `${authority.host}:${config.webRoot}/releases/${build}/`])
      return remoteOp(authority, 'web-verify', { manifest: state.steps['pages-artifact'].files })
    }),
    ...ordered.map((region) => stage(`drain:${region.id}`, async () => {
      state.drainStarted = true; persist()
      const value = await maintenance(region, 'drain')
      if (!value.draining) fail('Region did not enter maintenance')
      return true
    })),
    stage('ready', async () => {
      await poll(async () => {
        const pending = []
        for (const region of ordered) {
          const value = await maintenance(region, 'status')
          if (!value.draining) fail('A region reopened during release preparation')
          if (!value.ready) pending.push({ region: region.id, activeMatches: value.activeMatches, pendingRatings: value.pendingRatings, pendingRewards: value.pendingRewards, pendingReleases: value.pendingReleases })
        }
        if (pending.length) console.log(JSON.stringify({ waitingForDrain: pending }))
        return pending.length === 0
      }, 'all complete matches and pending deliveries', 45 * 60 * 1000, 15000)
      return true
    }),
    ...ordered.map((region) => stage(`stop:${region.id}`, async () => {
      await readyToStop()
      state.stopIntents ??= {}
      state.stopIntents[region.id] = true; persist()
      return remoteOp(region, 'stop', { target: 'game' })
    })),
    stage('stop-accounts', async () => { await allGamesStopped(); return remoteOp(authority, 'stop', { target: 'accounts' }) }),
    ...ordered.map((region) => stage(`backup:${region.id}`, () => remoteOp(region, 'backup', { includeAccounts: !!region.accounts }))),
    stage('accounts', async () => {
      await allGamesStopped()
      const current = (await remoteOp(authority, 'inspect')).accounts
      // An interrupted deploy may have finished remotely before the journal was saved.
      if (!(current.status === 'online' && current.hash === state.steps.build.accountsHash)) {
        if (current.status !== 'stopped') fail('Account process changed outside the stopped release; review it before resuming')
        if (state.steps.inspect.accountsChanged) await helper('accounts.sh', authority)
        else await remoteOp(authority, 'start-accounts', { target: 'accounts' })
      }
      return { changed: state.steps.inspect.accountsChanged }
    }),
    ...ordered.map((region) => stage(`game:${region.id}`, async () => {
      await readyToStop()
      const before = await remoteOp(region, 'inspect')
      if (before.game.status === 'online') {
        const current = await maintenance(region, 'status')
        if (!current.draining || !current.ready) fail('A resumed game deployment requires fresh live drain/readiness before reload')
      } else if (before.game.status !== 'stopped' || !state.steps[`stop:${region.id}`]) fail('Game process is not in the journaled stopped state')
      // deploy.sh rebuilds from the same immutable archived files and existing protected config.
      if (!(before.game.status === 'online' && before.game.hash === state.steps.build.gameHash && before.game.version.commit === build && before.game.version.net === state.steps.build.net)) await helper('deploy.sh', region)
      const value = await remoteOp(region, 'inspect')
      if (value.game.hash !== state.steps.build.gameHash || value.game.version.commit !== build || value.game.version.net !== state.steps.build.net || value.game.status !== 'online'
        || Object.keys(release).some((key) => value.game.version[key] !== release[key])
        || region.accounts && (value.accounts.hash !== state.steps.build.accountsHash || value.accounts.status !== 'online')) fail('Deployed application hash/version/status mismatch')
      const publicHealth = await requestJson(`${region.origin}/health`)
      if (publicHealth.build !== state.steps.build.net || publicHealth.protocol !== state.steps.build.protocol || publicHealth.region !== region.id || publicHealth.maintenance?.draining !== true) fail('Updated region identity/version/drain mismatch')
      return { gameHash: value.game.hash, commit: value.game.version.commit, net: value.game.version.net }
    })),
    stage('shared-services', async () => {
      await run(process.execPath, fleetArgs())
      await requestJson(`${config.appOrigin}/api/account/config`)
      await poll(async () => {
        const boards = []
        for (const region of ordered) boards.push(await requestJson(`${region.origin}/leaderboard?period=all`))
        if (boards.some((board) => !Array.isArray(board.entries) || board.period !== 'all' || board.region !== '')) fail('Invalid shared leaderboard response')
        return boards.every((board) => JSON.stringify(board) === JSON.stringify(boards[0]))
      }, 'one identical global leaderboard through every region', 60000)
      await poll(async () => publicVersionMatches(await requestJson(`${config.mediaOrigin}version.json`)), 'matching Pages media version', 180000)
      return true
    }),
    stage('activate-web', async () => {
      await remoteOp(authority, 'web-verify', { manifest: state.steps['pages-artifact'].files })
      const value = await remoteOp(authority, 'web-activation', { manifest: state.steps['pages-artifact'].files })
      if (!value.active) await helper('web.sh', authority, [packageDir, build, '--activate-staged'])
      return true
    }),
    stage('public-versions', async () => {
      await poll(async () => publicVersionMatches(await requestJson(`${config.appOrigin}/version.json`)) && publicVersionMatches(await requestJson(`${config.mediaOrigin}version.json`)), 'matching first-party app and Pages versions', 180000)
      return true
    }),
    ...ordered.map((region) => stage(`reopen:${region.id}`, async () => {
      const value = await maintenance(region, 'reopen')
      if (value.draining) fail('Region remains drained')
      return true
    })),
    stage('final-proof', async () => {
      const args = fleetArgs()
      if (opts.admission) args.push('--admission')
      const value = JSON.parse(await run(process.execPath, args))
      if (!value.ok || value.regions.some((region) => region.draining)) fail('Final fleet proof did not confirm every region reopened')
      return value
    }),
    stage('receipt', () => {
      const receipt = { revision, build, ...release, net: state.steps.build.net, protocol: state.steps.build.protocol, completedAt: new Date().toISOString(), pages: state.steps['pages-artifact'].url,
        hashes: { game: state.steps.build.gameHash, accounts: state.steps.build.accountsHash }, regions: ordered.map((r) => ({ id: r.id, origin: r.origin, backup: state.steps[`backup:${r.id}`].directory })), proof: state.steps['final-proof'] }
      save(join(dir, 'receipt.json'), receipt)
      return { file: join(dir, 'receipt.json'), revision, build, net: receipt.net }
    }),
  ]
  if (state.steps.archive) snapshot()
  await runStages(stages, state, persist, async () => {
    console.error('Release failed. Keeping all reachable regions drained; no automatic rollback or reopening.')
    for (const region of ordered) {
      try { await maintenance(region, 'drain') } catch { console.error(`${region.id}: could not contact maintenance; a stopped service retains its persistent drain state`) }
    }
  })
  await publishTag()
  console.log(JSON.stringify({ ok: true, receipt: state.steps.receipt.file, revision, build, ...release, net: state.steps.receipt.net }))
  } finally { await unlock() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error instanceof Error ? error.message : 'Release failed'); process.exitCode = 1 })
