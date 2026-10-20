#!/usr/bin/env node
// Private operator export. Authority credentials stay on the account host.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const idPattern = new RegExp(`^${UUID}$`)
const cursorPattern = new RegExp(`^\\d{1,13}:${UUID}$`)
const usage = 'Usage: node scripts/feedback.mjs (--collect | --input FILE.json) [--out DIRECTORY] [--limit 1..100] [--before TIMESTAMP:UUID]'
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const record = (value) => !!value && typeof value === 'object' && !Array.isArray(value)

export function parseArgs(args) {
  const options = { collect: false, input: null, output: resolve('artifacts/feedback'), limit: 100, before: null }
  const seen = new Set()
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (seen.has(flag)) throw new Error('Repeated feedback argument: ' + flag)
    seen.add(flag)
    if (flag === '--collect') { options.collect = true; continue }
    if (!['--input', '--out', '--limit', '--before'].includes(flag)) throw new Error(usage)
    const value = args[++i]
    if (!value || value.startsWith('--')) throw new Error(usage)
    if (flag === '--input') options.input = resolve(value)
    else if (flag === '--out') options.output = resolve(value)
    else if (flag === '--limit') options.limit = Number(value)
    else options.before = value
  }
  if (options.collect === !!options.input) throw new Error(usage)
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new Error('limit must be an integer from 1 to 100')
  if (options.before !== null && !cursorPattern.test(options.before)) throw new Error('before must be the exact TIMESTAMP:UUID nextBefore cursor')
  if (options.input && (seen.has('--limit') || seen.has('--before'))) throw new Error('--limit and --before apply only to --collect')
  return options
}

function validateReport(report) {
  if (!record(report) || !idPattern.test(report.id) || !['bug', 'feedback'].includes(report.kind)
    || typeof report.message !== 'string' || !record(report.context)
    || !Number.isSafeInteger(report.receivedAt) || report.receivedAt < 0
    || !(report.accountId === null || typeof report.accountId === 'string')) throw new Error('Invalid feedback detail: expected an ID, kind, message, context, receivedAt and accountId')
  const image = report.screenshot
  if (image !== undefined && (!record(image) || !['image/png', 'image/jpeg'].includes(image.mime)
    || !Number.isInteger(image.width) || image.width < 1 || image.width > 32768
    || !Number.isInteger(image.height) || image.height < 1 || image.height > 32768
    || typeof image.data !== 'string' || image.data.length === 0 || image.data.length > 4_000_000
    || image.data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data))) throw new Error('Invalid feedback screenshot: expected base64 PNG or JPEG')
}

/** Local input accepts an array of details, one detail, or a previous {reports,nextBefore} export. */
export function normalizeSnapshot(value, source = 'Local input') {
  const reports = Array.isArray(value) ? value : record(value) && Array.isArray(value.reports) ? value.reports : record(value) && Object.hasOwn(value, 'id') ? [value] : null
  if (!reports) throw new Error('Expected an array of feedback details, one detail, or an export with reports')
  reports.forEach(validateReport)
  if (new Set(reports.map((report) => report.id)).size !== reports.length) throw new Error('Duplicate feedback IDs in input')
  const nextBefore = record(value) && value.nextBefore !== undefined ? value.nextBefore : null
  if (nextBefore !== null && (typeof nextBefore !== 'string' || !cursorPattern.test(nextBefore))) throw new Error('Invalid feedback pagination cursor')
  return { collectedAt: Date.now(), source, reports: [...reports].sort((a, b) => b.receivedAt - a.receivedAt || b.id.localeCompare(a.id)), nextBefore }
}

function collect(authority, options) {
  const payload = Buffer.from(JSON.stringify({ config: authority.accounts.config, name: authority.accounts.name, limit: options.limit, before: options.before })).toString('base64')
  // Fixed SSH command; configuration travels on stdin, never shell interpolation.
  const code = `const fs=require('node:fs');const p=JSON.parse(Buffer.from('${payload}','base64'));
    (async()=>{
      const app=require(p.config).apps.find(a=>a.name===p.name);
      if(!app)throw new Error('Missing feedback account application');
      const file=app.env.AUTH_REGIONS_TOKEN_FILE,port=String(app.env.AUTH_PORT);
      if(!file||!/^\\d+$/.test(port))throw new Error('Feedback credentials/port not configured');
      const token=fs.readFileSync(file,'utf8').trim();
      const get=async(path)=>{const response=await fetch('http://127.0.0.1:'+port+path,{headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('Feedback HTTP '+response.status+'; deploy the feedback-enabled account service first');return response.json()};
      const page=await get('/internal/feedback?limit='+p.limit+(p.before?'&before='+encodeURIComponent(p.before):''));
      if(!Array.isArray(page.reports)||page.reports.length>p.limit)throw new Error('Invalid feedback inbox response');
      const reports=[];
      for(const entry of page.reports){if(!entry||!/${idPattern.source}/.test(entry.id))throw new Error('Invalid feedback report ID');const detail=await get('/internal/feedback/'+entry.id);if(detail.id!==entry.id)throw new Error('Feedback detail ID mismatch');reports.push(detail)}
      console.log(JSON.stringify({reports,nextBefore:page.nextBefore}));
    })().catch(e=>{console.error(e.message);process.exitCode=1})`
  return new Promise((yes, no) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', authority.host, 'node --input-type=commonjs -'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', overflow = false
    child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 96_000_000) { overflow = true; child.kill() } })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-16000) })
    child.on('error', no)
    child.on('close', (status) => {
      if (overflow) { no(new Error('Feedback collection exceeded the private export size limit')); return }
      if (status !== 0) { no(new Error('Feedback collection failed: ' + stderr.trim())); return }
      try { yes(JSON.parse(stdout)) } catch { no(new Error('Invalid feedback export from account authority')) }
    })
    child.stdin.on('error', no)
    child.stdin.end(code)
  })
}

export function renderFeedback(snapshot) {
  const field = (label, value) => value === undefined || value === null ? '' : `<div><dt>${label}</dt><dd>${escape(typeof value === 'object' ? JSON.stringify(value) : value)}</dd></div>`
  const reports = snapshot.reports.map((report) => {
    const c = report.context, connection = c.connection, device = c.device
    const search = [report.id, report.kind, report.message, report.accountId, report.contactEmail, JSON.stringify(c)].filter((v) => v !== undefined && v !== null).join(' ')
    const image = report.screenshot
    return `<article data-kind="${escape(report.kind)}" data-search="${escape(search.toLowerCase())}" id="report-${report.id}">
      <header><span class="kind ${report.kind}">${report.kind === 'bug' ? 'Bug report' : 'Feedback'}</span><time datetime="${new Date(report.receivedAt).toISOString()}">${escape(new Date(report.receivedAt).toISOString())}</time><a class="id" href="#report-${report.id}">${report.id}</a></header>
      <div class="report-body"><div><p class="message">${escape(report.message)}</p><dl class="facts">${field('Account', report.accountId ?? 'Guest')}${field('Contact', report.contactEmail)}${field('Release', c.release)}${field('Build', c.build)}${field('Netcode', c.netcode)}${field('Screen', c.screen)}${field('Panel', c.panel)}${field('Region', connection?.region)}${field('Room', connection?.room)}${field('Connection', connection?.transport)}${field('RTT / loss', connection ? `${connection.rttMs ?? 'Unrecorded'} ms / ${connection.lossPct ?? 'Unrecorded'}%` : undefined)}${field('Viewport', device ? `${device.width} × ${device.height} · DPR ${device.dpr}` : undefined)}</dl></div>
      ${image ? `<details class="screenshot"><summary>Screenshot · ${image.width} × ${image.height}</summary><img loading="lazy" alt="Player-attached screenshot for report ${report.id}" src="data:${image.mime};base64,${image.data}"><a download="${report.id}.${image.mime === 'image/png' ? 'png' : 'jpg'}" href="data:${image.mime};base64,${image.data}">Save screenshot</a></details>` : '<p class="no-image">No screenshot attached.</p>'}</div>
      <details><summary>Captured context · game, device, settings, recent events and errors</summary><pre>${escape(JSON.stringify(c, null, 2))}</pre></details>
    </article>`
  }).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Brawlock · Private feedback inbox</title><style>
  :root{color-scheme:dark;font:16px/1.5 system-ui,sans-serif;background:#100d0b;color:#eee1ce}*{box-sizing:border-box}body{margin:0}main{max-width:1400px;margin:auto;padding:32px 24px}h1{margin:0;font:700 36px/1.2 Georgia,serif;color:#edc88b}h2,p{margin:0}main>header p{margin-top:8px;color:#b7aa99}.toolbar{position:sticky;top:0;z-index:1;display:flex;flex-wrap:wrap;gap:16px;align-items:end;margin:24px 0;padding:16px;background:#211a14;border:1px solid #5b4630;border-radius:8px}.toolbar label{display:flex;flex-direction:column;gap:6px;font-size:14px}.toolbar label:first-child{flex:1;min-width:min(100%,260px)}input,select{font:inherit;color:inherit;background:#120e0a;border:1px solid #81633b;border-radius:4px;padding:9px}input:focus-visible,select:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid #edc88b;outline-offset:3px}article{padding:18px;margin:16px 0;border:1px solid #51402e;border-radius:8px;background:#1b1510}article[hidden]{display:none}article>header{display:flex;flex-wrap:wrap;align-items:center;gap:12px;color:#b7aa99;font-size:13px}.kind{padding:3px 9px;border-radius:4px;font-weight:700}.bug{background:#632d25;color:#ffc7b7}.feedback{background:#21423a;color:#b2e4d0}.id{margin-left:auto;font-family:monospace}a{color:#edc88b;overflow-wrap:anywhere}.report-body{display:grid;grid-template-columns:minmax(0,1fr) minmax(240px,360px);gap:24px;margin:18px 0}.message{white-space:pre-wrap;overflow-wrap:anywhere;font-size:18px;color:#fff2df}.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px 18px;margin:18px 0 0}.facts div{min-width:0}dt{font-size:12px;color:#aa9985}dd{margin:0;overflow-wrap:anywhere;font-size:14px}.no-image{align-self:center;color:#aa9985}.screenshot img{display:block;max-width:100%;max-height:420px;object-fit:contain;margin:12px 0;background:#090807}summary{cursor:pointer;color:#d8ba8e}pre{max-height:600px;overflow:auto;padding:16px;background:#0c0907;border-radius:4px;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 ui-monospace,monospace}.empty,footer{color:#b7aa99;font-size:14px}footer{margin-top:24px}code{overflow-wrap:anywhere}@media(max-width:700px){main{padding:20px 12px}.report-body{grid-template-columns:1fr}.toolbar{position:static}h1{font-size:28px}.id{margin-left:0}.facts{grid-template-columns:repeat(2,minmax(0,1fr))}}
  </style></head><body><main><header><h1>Player feedback</h1><p>Private operator inbox · ${escape(snapshot.source)} · exported ${escape(new Date(snapshot.collectedAt).toISOString())}</p></header><section class="toolbar" aria-label="Feedback filters"><label>Search reports and captured context<input id="search" type="search" placeholder="Message, release, room, account, error…"></label><label>Report type<select id="kind"><option value="all">All reports</option><option value="bug">Bug reports</option><option value="feedback">Feedback</option></select></label><p id="count" role="status" aria-live="polite">${snapshot.reports.length} reports</p></section><section id="reports" aria-label="Feedback reports">${reports}</section><p id="empty" class="empty"${snapshot.reports.length ? ' hidden' : ''}>No reports match these filters.</p><footer><p>Standalone private export; screenshots and context stay in these local files. <a href="report.json">Full JSON export</a>.</p>${snapshot.nextBefore ? `<p>Older reports: <code>node scripts/feedback.mjs --collect --before ${escape(snapshot.nextBefore)}</code></p>` : ''}</footer></main><script>
  const search=document.querySelector('#search'),kind=document.querySelector('#kind'),cards=[...document.querySelectorAll('#reports>article')];
  const filter=()=>{const query=search.value.trim().toLowerCase();let count=0;for(const card of cards){card.hidden=(kind.value!=='all'&&card.dataset.kind!==kind.value)||(query!==''&&!card.dataset.search.includes(query));if(!card.hidden)count++}document.querySelector('#count').textContent=count+' of '+cards.length+' reports';document.querySelector('#empty').hidden=count!==0};
  search.addEventListener('input',filter);kind.addEventListener('change',filter);filter();
  </script></body></html>`
}

export function writeExport(output, snapshot) {
  const html = renderFeedback(snapshot), json = JSON.stringify(snapshot)
  if (existsSync(output) && (!lstatSync(output).isDirectory() || lstatSync(output).isSymbolicLink())) throw new Error('Feedback output must be a real directory')
  mkdirSync(output, { recursive: true, mode: 0o700 })
  chmodSync(output, 0o700)
  for (const [name, content] of [['report.json', json], ['index.html', html]]) {
    const temporary = join(output, `.${name}.${randomUUID()}.tmp`)
    try {
      writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 })
      chmodSync(temporary, 0o600)
      renameSync(temporary, join(output, name))
    } finally { rmSync(temporary, { force: true }) }
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args)
  let snapshot
  if (options.input) snapshot = normalizeSnapshot(JSON.parse(readFileSync(options.input, 'utf8')))
  else {
    const fleet = JSON.parse(readFileSync(new URL('../deploy/release.config.json', import.meta.url), 'utf8'))
    const authorities = fleet.regions.filter((region) => region.globalAuthority && region.accounts)
    if (authorities.length !== 1) throw new Error('Expected exactly one feedback account authority')
    snapshot = normalizeSnapshot(await collect(authorities[0], options), 'Account authority · ' + authorities[0].id)
  }
  writeExport(options.output, snapshot)
  console.log(join(options.output, 'index.html'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1 })
}
