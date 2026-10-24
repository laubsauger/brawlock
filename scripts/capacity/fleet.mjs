// Operator-only direct HTTPS/WSS pilot on an empty Europe region. SSH is control-plane only.
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { isIP } from 'node:net'
import { acquireFleetLock, validateConfig } from '../../deploy/release.mjs'

const fleet = validateConfig(JSON.parse(readFileSync('deploy/release.config.json', 'utf8')))
const region = process.argv[2], target = fleet.regions.find(r => r.id === region), mode = process.argv[3] ?? 'pilot'
if (region !== 'eu' || !target || !['pilot', 'components', 'ceiling-humans', 'ceiling-bots', 'bot-cost-rooms'].includes(mode)) throw new Error('Usage: node scripts/capacity/fleet.mjs eu [pilot|ceiling-humans|ceiling-bots|bot-cost-rooms|components]')
const run = `${region}-${Date.now()}`, dir = resolve(`artifacts/capacity/${run}`), remote = `/var/lib/brawlock/capacity/${run}`
const unit = `brawlock-capacity-${run}`, timer = `${unit}-cleanup`
mkdirSync(dir, { recursive: true })
writeFileSync(`${dir}/operator.json`, JSON.stringify({ pid: process.pid, run, mode }))
const buildDir = `${dir}/build`; mkdirSync(buildDir)
for (const name of ['server.mjs', 'worker.mjs', 'bot-cost.mjs', 'manifest.json', ...(mode === 'bot-cost-rooms' ? ['server.mjs.map'] : [])]) copyFileSync(`artifacts/capacity/build/${name}`, `${buildDir}/${name}`)
const token = randomBytes(32).toString('hex'), base = `${target.origin}/_capacity/${run}`
const stages = mode === 'ceiling-humans' ? [4, 6, 8, 10, 12, 16].map(rooms => ({ rooms, humans: 10, players: 10, seconds: 75 }))
  : mode === 'ceiling-bots' ? [4, 8, 12, 16, 24, 32].map(rooms => ({ rooms, humans: 1, players: 10, seconds: 75 }))
  : mode === 'bot-cost-rooms' ? [2, 5, 10].map(players => ({ rooms: 4, humans: 1, players, seconds: 120 }))
  : [1, 10].flatMap(humans => [1, 2, 4].map(rooms => ({ rooms, humans, players: 10, seconds: 60 })))
writeFileSync(`${dir}/run.json`, JSON.stringify({ run, region, base, token, stages, buildDir, findCeiling: mode.startsWith('ceiling-'), out: `${dir}/results` }), { mode: 0o600 })
// Independent cleanup is installed before drain/routing, and works without the operator.
writeFileSync(`${dir}/cleanup.cjs`, `const {execFileSync}=require('node:child_process'); const fs=require('node:fs');
const errors=[];
try { execFileSync('systemctl',['stop','${unit}.service'],{stdio:'pipe'}); } catch(e) { if(e.status!==5) errors.push('Capacity stop: '+e.message); }
try { require('./route.cjs')('${remote}/server.json','remove'); } catch(e) { errors.push(e.message); }
const app=require(${JSON.stringify(target.game.config)}).apps.find(a=>a.name===${JSON.stringify(target.game.name)});
const token=fs.readFileSync(app.env.MAINTENANCE_SECRET_FILE,'utf8').trim();
fetch('http://127.0.0.1:'+app.env.PORT+'/internal/maintenance',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({draining:false,message:null}),signal:AbortSignal.timeout(10000)}).then(async r=>{if(!r.ok)throw new Error('Reopen HTTP '+r.status);console.log(JSON.stringify(await r.json()));if(errors.length)throw new Error(errors.join('; '));}).catch(e=>{console.error(e.message);process.exitCode=1;});
`, { mode: 0o600 })
const execute = promisify(execFile)
const ssh = script => execute('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target.host, script], { timeout: 70_000 })
const health = async () => { const r = await fetch(`${target.origin}/health`, { headers: { connection: 'close' }, signal: AbortSignal.timeout(5000), redirect: 'error' }); if (!r.ok) throw new Error(`Health HTTP ${r.status}`); return r.json() }
const pause = ms => new Promise(r => setTimeout(r, ms))
let guardInstalled = false, interrupted = false
process.on('SIGINT', () => { interrupted = true }); process.on('SIGTERM', () => { interrupted = true })
const unlock = await acquireFleetLock(fleet.appOrigin)
try {
  const executable = (await ssh('command -v node')).stdout.trim()
  if (!/^\/[A-Za-z0-9_./-]+$/.test(executable)) throw new Error('Expected an absolute remote Node executable')
  target.node = executable
  const address = (await ssh('printf \'%s\\n\' "$SSH_CONNECTION"')).stdout.trim().split(' ')[0]
  if (!isIP(address)) throw new Error('Cannot identify generator source IP')
  const hostname = new URL(target.origin).hostname
  const snippet = `\n    # isolated capacity run ${run}\n    location ^~ /_capacity/${run}/ {\n        allow ${address};\n        deny all;\n        access_log off;\n        proxy_pass http://127.0.0.1:5388/;\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection "upgrade";\n        proxy_set_header Host $host;\n        proxy_set_header X-Forwarded-For $remote_addr;\n        proxy_buffering off;\n        proxy_read_timeout 3600s;\n        proxy_send_timeout 3600s;\n        tcp_nodelay on;\n    }\n`
  writeFileSync(`${dir}/server.json`, JSON.stringify({ run, port: 5388, data: `${remote}/data`, token,
    route: { file: `/etc/nginx/sites-available/${hostname}`, hostname, run, snippet } }), { mode: 0o600 })
  const before = await health()
  if (before.rooms || before.players || before.connections || before.maintenance.draining) throw new Error('Region must be empty and open before this pilot')
  writeFileSync(`${dir}/production-before.json`, JSON.stringify(before, null, 2))
  await ssh(`install -d -m 750 -o root -g brawlock '${remote}'; install -d -o brawlock -g brawlock -m 700 '${remote}/data'`)
  await execute('scp', ['-q', mode === 'components' ? `${buildDir}/bot-cost.mjs` : `${buildDir}/server.mjs`, 'scripts/capacity/route.cjs', `${dir}/server.json`, `${dir}/cleanup.cjs`, `${target.host}:${remote}/`], { timeout: 30_000 })
  await ssh(`chown root:brawlock '${remote}/'*.mjs '${remote}/server.json'; chmod 640 '${remote}/'*.mjs '${remote}/server.json'; chmod 600 '${remote}/cleanup.cjs' '${remote}/route.cjs'; systemd-run --unit='${timer}' --on-active=14m ${target.node} '${remote}/cleanup.cjs'`)
  guardInstalled = true
  const fresh = await health()
  if (fresh.rooms || fresh.players || fresh.connections || fresh.maintenance.draining) throw new Error('Region changed while preparing; refusing to drain')
  const drained = await execute('bash', ['deploy/maintenance.sh', 'drain', 'Brief server capacity check. Please use the other region.'], { env: { ...process.env, DEPLOY_HOST: target.host }, timeout: 30_000 })
  const status = JSON.parse(drained.stdout)
  console.log(JSON.stringify({ event: 'maintenance', ...status }))
  if (!status.ready || status.rooms || status.players || status.connections) throw new Error('Region is not empty and safe to benchmark')
  if (interrupted) throw new Error('Interrupted')
  if (mode === 'components') {
    const result = await ssh(`systemd-run --quiet --wait --pipe --unit='${unit}' --uid=brawlock --gid=brawlock --property=MemoryMax=512M --property=RuntimeMaxSec=60 --property=NoNewPrivileges=yes ${target.node} --max-old-space-size=384 '${remote}/bot-cost.mjs'`)
    const profile = JSON.parse(result.stdout)
    writeFileSync(`${dir}/bot-cost.json`, JSON.stringify(profile, null, 2))
    console.log(JSON.stringify({ event: 'components.end', region, rows: profile.rows.length }))
  } else {
    const profiler = mode === 'bot-cost-rooms' ? `--cpu-prof --cpu-prof-interval=1000 --cpu-prof-dir='${remote}/data' --cpu-prof-name=cpu.cpuprofile` : ''
    await ssh(`systemd-run --unit='${unit}' --uid=brawlock --gid=brawlock --property=MemoryMax=512M --property=RuntimeMaxSec=13min --property=NoNewPrivileges=yes --working-directory='${remote}' ${target.node} --max-old-space-size=384 --disable-warning=ExperimentalWarning ${profiler} '${remote}/server.mjs' '${remote}/server.json'`)
    await ssh(`${target.node} '${remote}/route.cjs' '${remote}/server.json' install`)
    let ready = false
    for (let attempt = 0; attempt < 20 && !interrupted; attempt++) {
      const r = await fetch(`${base}/health`, { headers: { connection: 'close' }, signal: AbortSignal.timeout(2000), redirect: 'error' })
      if (r.ok) { const h = await r.json(); if (h.region !== `capacity-${run}`) throw new Error('Wrong capacity target'); ready = true; break }
      if (r.status !== 502) throw new Error(`Direct test route HTTP ${r.status}`)
      await pause(250)
    }
    if (!ready) throw new Error('Direct isolated server not ready')
    const child = spawn(process.execPath, ['scripts/capacity/run.mjs', `${dir}/run.json`], { stdio: ['ignore', 'pipe', 'inherit'] })
    child.stdout.on('data', d => process.stdout.write(d))
    const timerPoll = setInterval(() => { if (interrupted) child.kill('SIGTERM') }, 250)
    try {
      const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) })
      if (code !== 0) throw new Error(`Capacity coordinator exited ${code}`)
    } finally { clearInterval(timerPoll) }
  }
} finally {
  try {
    if (guardInstalled) {
      // Leave the independent timer installed if cleanup fails.
      const cleanup = await ssh(`${target.node} '${remote}/cleanup.cjs'`)
      console.log(cleanup.stdout.trim())
      if (mode === 'bot-cost-rooms') await execute('scp', ['-q', `${target.host}:${remote}/data/cpu.cpuprofile`, `${dir}/cpu.cpuprofile`], { timeout: 30_000 })
      const after = await health()
      writeFileSync(`${dir}/production-after.json`, JSON.stringify(after, null, 2))
      if (after.maintenance.draining) throw new Error('Production did not reopen cleanly; inspect region')
      if (mode !== 'components') {
        const removed = await fetch(`${base}/health`, { headers: { connection: 'close' }, signal: AbortSignal.timeout(5000), redirect: 'error' })
        if (removed.status !== 404) throw new Error('Temporary route was not removed')
      }
      await ssh(`systemctl stop '${timer}.timer'`)
      const logs = await ssh(`journalctl --unit='${unit}.service' --no-pager --output=cat`)
      writeFileSync(`${dir}/server.log`, logs.stdout)
    }
  } finally { await unlock() }
  console.log(JSON.stringify({ event: 'fleet.cleaned', region, run, output: dir }))
}
