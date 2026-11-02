import { openFeedbackMail } from './feedback-mail.mjs'
import fleet from '../deploy/release.config.json' with { type: 'json' }
import releasePackage from '../package.json' with { type: 'json' }
import analyticsCSS from '../scripts/analytics-report.css'
import { openMonitoring, startMonitoring } from './monitoring.mjs'
import { createAdmin } from './admin.mjs'
import { createServerPerf } from './perf.mjs'
import { createMachineMonitor } from './machine-monitor.mjs'
// Private loopback service. nginx serves the game and proxies /api/auth + /api/account.
import http from 'node:http'
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { toNodeHandler } from 'better-auth/node'
import { openAccounts } from './accounts.mjs'
import { openFeedback } from './feedback.mjs'
import { openChat } from './chat.mjs'
import { openDaily } from './daily.mjs'
import { createVerifierPool } from './daily-verifier.mjs'

process.umask(0o077)

/** Write this build's daily verifier (and keep the newest ten). */
function installVerifier(dir) {
  if (typeof __DAILY_BUNDLE__ === 'undefined') return
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `${__DAILY_BUNDLE__.id}.mjs`)
  try { statSync(file) } catch { writeFileSync(file, __DAILY_BUNDLE__.code, { mode: 0o600 }) }
  const all = readdirSync(dir).filter((f) => /^[0-9a-f]{12}\.mjs$/.test(f)).map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.at - a.at)
  for (const { f } of all.slice(10)) unlinkSync(join(dir, f))
}

const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required for the account authority`)
  return value
}
const providers = {}
for (const provider of ['google', 'discord', 'microsoft']) {
  const prefix = `AUTH_${provider.toUpperCase()}`
  const clientId = process.env[`${prefix}_CLIENT_ID`]
  const secretFile = process.env[`${prefix}_SECRET_FILE`]
  if (!clientId && !secretFile) continue
  if (!clientId || !secretFile) throw new Error(`${prefix} requires both CLIENT_ID and SECRET_FILE`)
  providers[provider] = { clientId, clientSecret: readFileSync(secretFile, 'utf8').trim() }
}
const origin = required('AUTH_ORIGIN')
// comma list of hosts that embed the game client (itch.io); guest play and feedback only
const embeds = (process.env.AUTH_EMBED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const dataDir = required('AUTH_DATA_DIR')
const regionsToken = readFileSync(required('AUTH_REGIONS_TOKEN_FILE'), 'utf8').trim()
const secret = readFileSync(required('AUTH_SECRET_FILE'), 'utf8').trim()
const accounts = await openAccounts({
  file: join(dataDir, 'accounts.sqlite'), origin,
  secret, providers,
  regionsToken, embeds,
  migrate: process.argv.includes('--migrate'),
})
if (process.argv.includes('--migrate')) {
  accounts.close()
  console.log('Account schema is ready.')
} else {
  const feedback = openFeedback(join(dataDir, 'feedback.sqlite'), {
    origin, token: regionsToken, embeds,
    getAccount: async (request) => {
      if (!request.headers.has('cookie')) return null
      const session = await accounts.auth.api.getSession({ headers: request.headers })
      return session ? { id: session.user.id } : null
    },
  })
  const chat = openChat(join(dataDir, 'chat.sqlite'), { origin, secret, embeds, feedback, speaker: accounts.speaker })
  // the daily Gauntlet: one verifier per client build. This build's comes inside the bundle and is
  // written beside the earlier ones, so runs played on the previous build still verify mid-day.
  const verifierDir = process.env.DAILY_VERIFIER_DIR ?? join(dataDir, 'daily-verifiers')
  installVerifier(verifierDir)
  const daily = openDaily(join(dataDir, 'daily.sqlite'), { origin, embeds, speaker: accounts.speaker, names: accounts.profileNames, reward: accounts.dailyReward,
    verifier: createVerifierPool(verifierDir) })
  const mail = openFeedbackMail({ origin, feedback,
    apiKey: process.env.RESEND_API_KEY ?? '', from: process.env.FEEDBACK_MAIL_FROM ?? '' })
  const perf = createServerPerf()
  const machine = createMachineMonitor({ perf })
  const store = openMonitoring(join(dataDir, 'monitoring.sqlite'))
  const collector = startMonitoring({ store, regions: fleet.regions, token: regionsToken, appOrigin: origin,
    localSample: () => ({ version: 1, ...machine.snapshot(), online: accounts.presence(), uptimeSec: process.uptime(),
      release: { version: releasePackage.version, releaseDate: releasePackage.releaseDate, commit: typeof __RELEASE_COMMIT__ === 'undefined' ? null : __RELEASE_COMMIT__ } }) })
  const admin = createAdmin({ accounts, store, collector, regions: fleet.regions, token: regionsToken, origin, feedback, chat, daily, css: analyticsCSS, mail })
  const handle = toNodeHandler(async (request) => {
    const path = new URL(request.url).pathname
    if (path.startsWith('/api/admin/')) return admin(request)
    if (path === '/api/chat' || path === '/api/chat/report') return chat.handler(request)
    if (path === '/api/daily' || path.startsWith('/api/daily/')) return daily.handler(request)
    return path === '/api/feedback' || path === '/internal/feedback' || path.startsWith('/internal/feedback/')
      ? feedback.handler(request) : accounts.handler(request)
  })
  const server = http.createServer(async (req, res) => {
    // Only nginx may set forwarding headers; never use a browser-supplied auth IP.
    req.headers['x-brawlock-client-ip'] = process.env.TRUST_PROXY === '1'
      ? String(req.headers['x-real-ip'] ?? req.socket.remoteAddress) : req.socket.remoteAddress
    // Better Auth has its own parser; bound the stream before handing it over.
    const chunks = []
    let bytes = 0
    const route = req.url?.split('?')[0]
    // a daily run's tape is at most 96 KiB compressed (base64 in JSON)
    const limit = route === '/api/feedback' ? 512 * 1024 : route === '/api/daily/submit' ? 160 * 1024 : 32 * 1024
    try {
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length
        if (bytes > limit) {
          res.writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end('{"error":"Request is too large."}')
          req.resume()
          return
        }
        chunks.push(chunk)
      }
      const bounded = Readable.from(chunks)
      Object.assign(bounded, { headers: req.headers, method: req.method, url: req.url, socket: req.socket })
      await handle(bounded, res)
    } catch {
      // Do not write provider responses, tokens, emails or cookies to logs.
      console.error('Account request failed.')
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end('{"error":"Account service could not complete the request."}')
    }
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  server.listen(Number(process.env.AUTH_PORT ?? 5352), '127.0.0.1', () => console.log('Account authority listening on loopback.'))
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    server.close(async () => { await collector.close(); await mail.close(); machine.close(); perf.close(); store.close(); chat.close(); daily.close(); feedback.close(); accounts.close(); process.exit(0) })
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
