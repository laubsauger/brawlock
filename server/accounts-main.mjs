// Private loopback service. nginx serves the game and proxies /api/auth + /api/account.
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { toNodeHandler } from 'better-auth/node'
import { openAccounts } from './accounts.mjs'
import { openFeedback } from './feedback.mjs'

process.umask(0o077)

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
const dataDir = required('AUTH_DATA_DIR')
const regionsToken = readFileSync(required('AUTH_REGIONS_TOKEN_FILE'), 'utf8').trim()
const accounts = await openAccounts({
  file: join(dataDir, 'accounts.sqlite'), origin,
  secret: readFileSync(required('AUTH_SECRET_FILE'), 'utf8').trim(), providers,
  regionsToken,
  migrate: process.argv.includes('--migrate'),
})
if (process.argv.includes('--migrate')) {
  accounts.close()
  console.log('Account schema is ready.')
} else {
  const feedback = openFeedback(join(dataDir, 'feedback.sqlite'), {
    origin, token: regionsToken,
    getAccount: async (request) => {
      if (!request.headers.has('cookie')) return null
      const session = await accounts.auth.api.getSession({ headers: request.headers })
      return session ? { id: session.user.id } : null
    },
  })
  const handle = toNodeHandler(async (request) => {
    const path = new URL(request.url).pathname
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
    const limit = req.url?.split('?')[0] === '/api/feedback' ? 512 * 1024 : 32 * 1024
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
    server.close(() => { feedback.close(); accounts.close(); process.exit(0) })
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
