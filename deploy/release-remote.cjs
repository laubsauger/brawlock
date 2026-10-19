// Targeted release operations, streamed over verified SSH. Never prints protected env.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
process.umask(0o077)
const fail = (message) => { throw new Error(message) }
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
function write(file, value) {
  const pending = file + '.partial-' + crypto.randomUUID()
  const fd = fs.openSync(pending, 'wx', 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  // Atomic publication without replacing another release's ownership marker.
  try { fs.linkSync(pending, file) } finally { fs.unlinkSync(pending) }
}
function directory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (fs.lstatSync(dir).isSymbolicLink() || fs.statSync(dir).uid !== 0 || (fs.statSync(dir).mode & 0o777) !== 0o700) fail('Release state/backup directory must be root-owned mode 0700')
}
function pm2(args, runtime) {
  const result = spawnSync('runuser', ['-u', runtime.user, '--', 'env', '-i', `HOME=${runtime.home}`, `USER=${runtime.user}`, `LOGNAME=${runtime.user}`, 'PATH=/usr/local/bin:/usr/bin:/bin', `PM2_HOME=${runtime.pm2Home}`, 'pm2', ...args], { cwd: runtime.home, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 })
  if (result.status !== 0) fail('Targeted non-root PM2 operation failed')
  return result.stdout
}
function apps(runtime) { return JSON.parse(pm2(['jlist'], runtime)) }
function status(app, runtime) {
  const found = apps(runtime).find((item) => item.name === app.name)
  if (!found) fail('Prepared Brawlock PM2 application is missing')
  return found.pm2_env.status
}
function checked(app) {
  const protectedMode = fs.statSync(app.config)
  if (protectedMode.uid !== 0 || (protectedMode.mode & 0o777) !== 0o640) fail('Unexpected protected configuration ownership/mode')
  const config = require(app.config).apps.find((item) => item.name === app.name)
  if (!config || config.cwd !== app.dir) fail('Protected application path does not match release configuration')
  const data = config.env?.DATA_DIR ?? config.env?.AUTH_DATA_DIR
  if (data !== path.join(app.dir, 'data')) fail('Unexpected application data path')
  if (app.port && String(config.env.PORT) !== String(app.port)) fail('Protected game port does not match release configuration')
  return config
}
function webManifest(dir) {
  const result = {}
  function walk(base) {
    for (const name of fs.readdirSync(base).sort()) {
      const file = path.join(base, name), stat = fs.lstatSync(file)
      if (stat.isSymbolicLink()) fail('Unexpected symlink in staged website')
      if (stat.isDirectory()) walk(file)
      else if (stat.isFile()) result[path.relative(dir, file)] = hash(file)
      else fail('Unexpected file in staged website')
    }
  }
  walk(dir)
  return result
}

try {
  if (process.getuid() !== 0) fail('Release SSH identity must be root')
  const request = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'))
  const { op, region, runtime, backupRoot, releaseId, revision, build, webRoot } = request
  for (const value of [backupRoot, webRoot, runtime.home, runtime.pm2Home, region.game.dir, region.game.config, region.accounts?.dir, region.accounts?.config].filter(Boolean)) {
    if (!/^\/[A-Za-z0-9_./-]+$/.test(value) || value.includes('/../') || value.endsWith('/..')) fail('Invalid release path')
  }
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(region.id) || !/^[a-z][a-z0-9-]*$/.test(runtime.user) || runtime.user === 'root'
    || !/^[a-zA-Z0-9_-]{8,100}$/.test(releaseId) || !/^[a-f0-9]{40}$/.test(revision) || !/^[a-f0-9]{12}$/.test(build)
    || !backupRoot.startsWith('/root/')) fail('Invalid release identity')
  if (checked(region.game).env.REGION !== region.id) fail('Protected game region does not match this configured host')
  if (region.accounts) checked(region.accounts)
  const base = path.join(backupRoot, releaseId)
  let result
  if (op === 'inspect') {
    result = { game: { hash: hash(path.join(region.game.dir, 'server.mjs')), version: json(path.join(region.game.dir, 'version.json')), status: status(region.game, runtime) },
      ...(region.accounts ? { accounts: { hash: hash(path.join(region.accounts.dir, 'accounts.mjs')), status: status(region.accounts, runtime) } } : {}) }
  } else if (op === 'stop' || op === 'start-accounts') {
    const app = request.target === 'game' ? region.game : request.target === 'accounts' ? region.accounts : null
    if (!app) fail('Unknown release stop target')
    if (op === 'start-accounts') {
      if (app !== region.accounts) fail('Only the account service has a direct start operation')
      pm2(['startOrRestart', app.config, '--only', app.name, '--update-env'], runtime)
      if (status(app, runtime) !== 'online') fail('Account application is not online')
    } else {
      if (status(app, runtime) !== 'stopped') pm2(['stop', app.name], runtime)
      if (status(app, runtime) !== 'stopped') fail('Application is not stopped')
    }
    // Reboots must preserve the deliberate stopped state during a release.
    pm2(['save'], runtime)
    result = { application: app.name, status: status(app, runtime) }
  } else if (op === 'backup') {
    directory(backupRoot); directory(base)
    const destination = path.join(base, region.id)
    if (fs.existsSync(destination)) {
      const receipt = json(path.join(destination, 'receipt.json'))
      if (receipt.revision !== revision || receipt.accounts !== !!request.includeAccounts) fail('Existing backup belongs to another release operation')
      const files = webManifest(destination)
      delete files['receipt.json']
      if (JSON.stringify(files) !== JSON.stringify(receipt.files)) fail('Existing backup files failed integrity verification')
      const { files: _files, ...summary } = receipt
      result = summary
    } else {
      const targets = [['game', region.game], ...(request.includeAccounts ? [['accounts', region.accounts]] : [])]
      for (const [, app] of targets) if (!app || status(app, runtime) !== 'stopped') fail('A consistent backup requires every targeted application to be stopped')
      const pending = destination + '.partial-' + crypto.randomUUID()
      directory(pending)
      for (const [kind, app] of targets) {
        const dir = path.join(pending, kind)
        directory(dir)
        fs.cpSync(path.join(app.dir, 'data'), path.join(dir, 'data'), { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true })
        for (const name of kind === 'game' ? ['server.mjs', 'version.json'] : ['accounts.mjs']) fs.copyFileSync(path.join(app.dir, name), path.join(dir, name), fs.constants.COPYFILE_EXCL)
        fs.copyFileSync(app.config, path.join(dir, path.basename(app.config)), fs.constants.COPYFILE_EXCL)
      }
      result = { revision, region: region.id, accounts: !!request.includeAccounts, directory: destination, createdAt: new Date().toISOString() }
      write(path.join(pending, 'receipt.json'), { ...result, files: webManifest(pending) })
      fs.renameSync(pending, destination)
    }
  } else if (op === 'web-claim' || op === 'web-verify' || op === 'web-activation') {
    if (!region.globalAuthority) fail('Website operations require the configured global authority')
    directory(backupRoot); directory(base)
    const ownerFile = path.join(base, 'web-owner.json'), destination = path.join(webRoot, 'releases', build)
    const expected = { revision, build, manifest: request.manifest }
    if (op === 'web-claim') {
      if (fs.existsSync(ownerFile)) {
        if (JSON.stringify(json(ownerFile)) !== JSON.stringify(expected)) fail('Website staging ownership conflicts with this release')
      } else {
        if (fs.existsSync(destination)) fail('Website build directory already exists; resume its original release journal')
        write(ownerFile, expected)
      }
      result = { exists: fs.existsSync(destination) }
    } else if (op === 'web-activation') {
      if (JSON.stringify(json(ownerFile)) !== JSON.stringify(expected)) fail('Website activation ownership is missing or conflicts')
      const current = path.join(webRoot, 'current'), next = path.join(webRoot, 'current.next')
      // Only clean up our verified temporary symlink after an interrupted activation.
      if (fs.existsSync(next) || (() => { try { return fs.lstatSync(next).isSymbolicLink() } catch { return false } })()) {
        if (!fs.lstatSync(next).isSymbolicLink() || fs.readlinkSync(next) !== destination) fail('Unexpected pending website activation; inspect it manually')
        fs.unlinkSync(next)
      }
      result = { active: fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink() && fs.realpathSync(current) === destination }
    } else {
      if (JSON.stringify(json(ownerFile)) !== JSON.stringify(expected)) fail('Website staging ownership is missing or conflicts')
      if (JSON.stringify(webManifest(destination)) !== JSON.stringify(request.manifest)) fail('Staged website files do not match the exact workflow artifact')
      // Finish interrupted rsync permissions without activating the website.
      function publicModes(dir) {
        fs.chownSync(dir, 0, 0); fs.chmodSync(dir, 0o755)
        for (const name of fs.readdirSync(dir)) {
          const file = path.join(dir, name)
          if (fs.lstatSync(file).isDirectory()) publicModes(file)
          else { fs.chownSync(file, 0, 0); fs.chmodSync(file, 0o644) }
        }
      }
      publicModes(destination)
      result = { verified: true, build }
    }
  } else fail('Unknown release operation')
  console.log(JSON.stringify(result))
} catch (error) {
  // No environment, PM2 response or provider/secret-file contents reach the caller.
  console.error(error instanceof Error && !error.code ? error.message : 'Remote release operation failed')
  process.exitCode = 1
}
