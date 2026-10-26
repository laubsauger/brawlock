// Run on the target host as root, after the base runtime/protected secrets exist.
// Dry-run by default. Never prints environment values or rewrites credential data.
// ssh HOST 'node --input-type=commonjs - REGION ACCOUNT_ORIGIN --apply' < deploy/configure-region.cjs
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const [region, accountsUrl, option] = process.argv.slice(2)
if (!/^[a-z][a-z0-9-]{0,31}$/.test(region ?? '') || !accountsUrl || (option !== undefined && option !== '--apply')) throw new Error('Usage: node - REGION ACCOUNT_ORIGIN [--apply]')
const url = new URL(accountsUrl)
if (url.origin !== accountsUrl || url.username || url.password || (url.protocol !== 'https:' && accountsUrl !== 'http://127.0.0.1:5352')) throw new Error('Use an exact HTTPS account origin, or the US loopback service')
const file = '/etc/brawlock/ecosystem.config.cjs'
const config = require(file)
const app = config.apps.find((a) => a.name === 'brawlock-server')
if (!app || app.env.REGION !== region || app.cwd !== '/opt/apps/brawlock-server') throw new Error('Protected config does not match the requested region/runtime')
const credential = '/etc/brawlock/maintenance-secret'
if (app.env.ACCOUNTS_AUTHORITY_URL && app.env.ACCOUNTS_AUTHORITY_URL !== accountsUrl) throw new Error('Changing an existing account authority requires a reviewed migration')
if (app.env.MAINTENANCE_SECRET_FILE && app.env.MAINTENANCE_SECRET_FILE !== credential) throw new Error('Unexpected existing maintenance credential path')
const original = fs.readFileSync(file, 'utf8')
let text = original
// Both supported syntaxes occur in the checked-in template and deployed configs.
const envMarker = /(?:"env"|'env'|\benv)\s*:\s*\{/g
if ([...text.matchAll(envMarker)].length !== 1) throw new Error('Expected one reviewed env block')
const fields = []
if (!app.env.ACCOUNTS_AUTHORITY_URL) fields.push(`ACCOUNTS_AUTHORITY_URL: ${JSON.stringify(accountsUrl)},`)
if (!app.env.MAINTENANCE_SECRET_FILE) fields.push(`MAINTENANCE_SECRET_FILE: ${JSON.stringify(credential)},`)
if (fields.length) text = text.replace(envMarker, (marker) => `${marker}\n        ${fields.join('\n        ')}`)
const origins = app.env.ALLOWED_ORIGINS
if (typeof origins !== 'string' || !origins) throw new Error('Production requires an explicit origin allowlist')
// the first-party site, and itch.io's HTML game host for the embedded client (docs/ITCH.md)
const addOrigin = ['https://brawlock.osc.link', 'https://html-classic.itch.zone'].filter((o) => !origins.split(',').map((s) => s.trim()).includes(o))
if (addOrigin.length) {
  const pattern = /(?:"ALLOWED_ORIGINS"|'ALLOWED_ORIGINS'|\bALLOWED_ORIGINS)\s*:\s*(['"])([^'"\n]*)\1/
  const found = text.match(pattern)
  if (!found || found[2] !== origins) throw new Error('Origin allowlist must be a reviewed literal')
  text = text.replace(pattern, `ALLOWED_ORIGINS: ${JSON.stringify([origins, ...addOrigin].join(','))}`)
}
const gid = Number(execFileSync('id', ['-g', 'brawlock'], { encoding: 'utf8' }).trim())
const configStat = fs.statSync(file)
if (configStat.uid !== 0 || configStat.gid !== gid || (configStat.mode & 0o777) !== 0o640) throw new Error('Protected config must be root:brawlock0640')
const createCredential = !fs.existsSync(credential)
if (!createCredential) {
  const stat = fs.statSync(credential)
  if (stat.uid !== 0 || stat.gid !== gid || (stat.mode & 0o777) !== 0o640 || fs.readFileSync(credential, 'utf8').trim().length < 32) throw new Error('Existing maintenance credential is invalid; it will not be rotated automatically')
}
const changed = text !== original
console.log(JSON.stringify({ region, accountOrigin: accountsUrl, configChange: changed, addGameOrigins: addOrigin, createMaintenanceCredential: createCredential, apply: option === '--apply' }))
if (option !== '--apply') process.exit(0)
if (changed) {
  const backup = `/root/brawlock-backups/region-config-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 })
  fs.copyFileSync(file, `${backup}/ecosystem.config.cjs`, fs.constants.COPYFILE_EXCL)
}
if (createCredential) {
  fs.writeFileSync(credential, randomBytes(48).toString('base64url') + '\n', { flag: 'wx', mode: 0o600 })
  fs.chownSync(credential, 0, gid)
  fs.chmodSync(credential, 0o640)
}
if (changed) {
  if (fs.readFileSync(file, 'utf8') !== original) throw new Error('Protected config changed during preparation; inspect and retry')
  const next = `${file}.next`
  const fd = fs.openSync(next, 'wx', 0o600)
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.chownSync(next, 0, gid)
  fs.chmodSync(next, 0o640)
  fs.renameSync(next, file)
}
console.log('Regional configuration ready. No service restart, data reset or credential rotation performed.')
