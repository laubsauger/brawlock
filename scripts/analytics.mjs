// Credentials remain on the hosts. Only private snapshots with report-scoped random keys cross SSH.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import { renderAnalytics } from './analytics-report.mjs'

const args = process.argv.slice(2)
let days = 30, output = resolve('artifacts/analytics'), input = null
for (let i = 0; i < args.length; i++) {
  const flag = args[i], value = args[++i]
  if (!value) throw new Error('Usage: npm run analytics -- [--days 1..365] [--out DIRECTORY] [--input SNAPSHOT.json]')
  if (flag === '--days') days = Number(value)
  else if (flag === '--out') output = resolve(value)
  else if (flag === '--input') input = resolve(value)
  else throw new Error('Unknown analytics argument: ' + flag)
}
if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('days must be an integer from 1 to 365')

function collect(host, config, name, account) {
  // The remote shell receives only a fixed command; all config data travels on stdin.
  const payload = Buffer.from(JSON.stringify({ config, name, account, days })).toString('base64')
  const code = `const fs=require('node:fs'); const p=JSON.parse(Buffer.from('${payload}','base64'));
    (async()=>{
      const app=require(p.config).apps.find(a=>a.name===p.name);
      if(!app) throw new Error('Missing analytics application');
      const file=p.account?app.env.AUTH_REGIONS_TOKEN_FILE:app.env.MAINTENANCE_SECRET_FILE;
      const port=String(p.account?app.env.AUTH_PORT:app.env.PORT);
      if(!file || !/^\\d+$/.test(port)) throw new Error('Analytics credentials/port not configured');
      const token=fs.readFileSync(file,'utf8').trim();
      const response=await fetch('http://127.0.0.1:'+port+'/internal/analytics?days='+p.days,{headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(10000)});
      if(!response.ok) throw new Error('Analytics HTTP '+response.status+'; deploy the analytics-enabled service first');
      console.log(JSON.stringify(await response.json()));
    })().catch(e=>{console.error(e.message);process.exitCode=1})`
  return new Promise((yes, no) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, 'node --input-type=commonjs -'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', no)
    child.on('close', (status) => {
      if (status !== 0) { no(new Error(`Analytics collection failed on ${host}: ${stderr.trim()}`)); return }
      try { yes(JSON.parse(stdout)) } catch { no(new Error(`Invalid analytics report from ${host}`)) }
    })
    child.stdin.end(code)
  })
}

try {
  let snapshot
  if (input) snapshot = JSON.parse(readFileSync(input, 'utf8'))
  else {
    const fleet = JSON.parse(readFileSync(new URL('../deploy/release.config.json', import.meta.url), 'utf8'))
    const sources = fleet.regions.flatMap((region) => [
      collect(region.host, region.game.config, region.game.name, false),
      ...(region.accounts ? [collect(region.host, region.accounts.config, region.accounts.name, true)] : []),
    ])
    const results = await Promise.allSettled(sources)
    const failures = results.filter((r) => r.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map((r) => r.reason), failures.map((r) => r.reason.message).join('\n'))
    snapshot = { reports: results.map((r) => r.value) }
  }
  const html = renderAnalytics(snapshot)
  mkdirSync(output, { recursive: true, mode: 0o700 })
  writeFileSync(join(output, 'report.json'), JSON.stringify(snapshot), { mode: 0o600 })
  writeFileSync(join(output, 'index.html'), html, { mode: 0o600 })
  console.log(join(output, 'index.html'))
} catch (error) { console.error(error.message); process.exitCode = 1 }
