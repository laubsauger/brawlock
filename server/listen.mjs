import { createMachineMonitor } from './machine-monitor.mjs'
import releasePackage from '../package.json' with { type: 'json' }
// Dedicated server (M4.1, docs/M4.md §11): Node glue for the typed core in src/net/server.ts.
// HTTP routes and WebSocket upgrades at /ws?room=CODE; framing in src/net/wsframe.ts.
// Plain JS because @types/node is not a project dependency.
import http from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { openLeaderboard } from './leaderboard-store.mjs'
import { remoteRatingAuthority } from './rating-client.mjs'
import { iceCredentialEndpoint, turnCredentialIssuer } from './turn-credentials.mjs'
import { createServerPerf } from './perf.mjs'
import { regionalAccounts } from './account-client.mjs'
import { RankedConflictError } from '../src/net/accounts.ts'
import { openMaintenance } from './maintenance.mjs'
import { openAnalytics } from './analytics.mjs'
import { validMaintenance } from '../src/net/maintenance.ts'
import { KeyedLimiter } from '../src/net/ratelimit.ts'
import { localRatingAuthority, validRatingSubmission } from '../src/net/ratingAuthority.ts'
import { FrameDecoder, OP_CLOSE, OP_PING, OP_PONG, OP_TEXT, WS_GUID, decodeText, encodeFrame, encodeText } from '../src/net/wsframe.ts'
import { DEFAULT_SERVER_CONFIG, createServerCore } from '../src/net/server.ts'
import { startClock } from '../src/net/clock.ts'
import { DEFAULT_SETTINGS, createMatch, step } from '../src/sim/index.ts'
import { createBot } from '../src/bots/index.ts'

const MAX_MESSAGE_BYTES = 64 * 1024
/** HTTP request bodies (listings): small JSON objects */
const MAX_BODY_BYTES = 4096

/** The request body as text; '' without one, null when over MAX_BODY_BYTES. */
function readBody(req, maxBytes = MAX_BODY_BYTES) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return Promise.resolve('')
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      resolve(v)
    }
    req.on('data', (c) => {
      size += c.length
      if (size > maxBytes) finish(null)
      else if (!done) chunks.push(c)
    })
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => finish(null))
  })
}
/** netcode compatibility id baked in at build time (vite / esbuild define), else from the env */
export const NET_BUILD = typeof __NET_ID__ !== 'undefined' ? __NET_ID__ : (process.env.NET_ID ?? 'dev-local')

/** JSON lines on stdout (pm2 collects them). */
export function jsonLog(level, event, fields = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }))
}

/** An upgraded socket as a TextSocket (src/net/ws.ts). */
function wrapSocket(socket, log) {
  const decoder = new FrameDecoder(MAX_MESSAGE_BYTES)
  let textCb = null
  let closeCb = null
  const early = []
  let closed = false
  const finish = () => {
    if (closed) return
    closed = true
    closeCb?.()
  }
  socket.on('data', (chunk) => {
    let msgs
    try {
      msgs = decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
    } catch (e) {
      log('warn', 'ws.protocol', { error: e.message })
      socket.destroy()
      finish()
      return
    }
    for (const m of msgs) {
      if (m.opcode === OP_TEXT) {
        const t = decodeText(m.payload)
        if (textCb) textCb(t)
        else if (early.length < 256) early.push(t)
      } else if (m.opcode === OP_PING) socket.write(encodeFrame(OP_PONG, m.payload))
      else if (m.opcode === OP_CLOSE) {
        socket.end(encodeFrame(OP_CLOSE, m.payload.subarray(0, 2)))
        finish()
      }
    }
  })
  socket.on('close', finish)
  socket.on('error', finish)
  return {
    send(text) {
      if (!closed && socket.writable) socket.write(encodeText(text))
    },
    close() {
      if (closed) return
      socket.end(encodeFrame(OP_CLOSE, new Uint8Array([0x03, 0xe8])))
      finish()
    },
    onText(cb) {
      textCb = cb
      for (const t of early.splice(0)) cb(t)
    },
    onClose(cb) {
      closeCb = cb
    },
    bufferedAmount: () => socket.writableLength,
  }
}

/**
 * Start a server. opts: port, host, build, config (ServerConfig overrides), trustProxy
 * (take the client IP from X-Forwarded-For: behind the local nginx), timeScale (tests),
 * log, dataDir (leaderboard.sqlite goes there; '' = no leaderboard), clock (ms since
 * epoch for stored results; tests). Returns { port, core, room(code), createRoom(opts), close() }.
 */
export async function startServer(opts = {}) {
  const { port = 5350, host = '127.0.0.1', build = NET_BUILD, config = {}, trustProxy = false, timeScale = 1, log = jsonLog, dataDir = '', clock = Date.now } = opts
  const turnFile = process.env.TURN_SECRET_FILE ?? ''
  const turnUrlsText = process.env.TURN_URLS
  const hasTurn = opts.turnSecret !== undefined || opts.turnUrls !== undefined || turnFile !== '' || turnUrlsText !== undefined
  let issueIce
  if (hasTurn) {
    if (opts.turnSecret === undefined && !turnFile) throw new Error('TURN_SECRET_FILE is required when TURN is configured')
    let urls = opts.turnUrls
    if (urls === undefined) {
      try { urls = JSON.parse(turnUrlsText ?? '') } catch { throw new Error('TURN_URLS must be a JSON array of ICE URLs') }
    }
    issueIce = turnCredentialIssuer({ secret: opts.turnSecret ?? readFileSync(turnFile, 'utf8').trim(), urls,
      ttlSeconds: opts.turnTtlSeconds ?? Number(process.env.TURN_TTL_SECONDS ?? 86400), now: clock })
  }
  const ice = iceCredentialEndpoint({ issue: issueIce, allowedOrigins: config.allowedOrigins ?? DEFAULT_SERVER_CONFIG.allowedOrigins })
  const authorityUrl = opts.ratingAuthorityUrl ?? process.env.RATING_AUTHORITY_URL ?? ''
  const authorityToken = opts.ratingAuthorityToken ?? process.env.RATING_AUTHORITY_TOKEN ?? ''
  if ((authorityUrl || authorityToken) && !dataDir) throw new Error('Global rating authority requires DATA_DIR for durable storage')
  if (authorityToken && authorityToken.length < 32) throw new Error('Rating authority token must contain at least 32 characters')
  // The US keeps the existing SQLite file. EU gets only a durable delivery outbox,
  // never a second independent leaderboard when the authority cannot be reached.
  const authority = authorityUrl ? remoteRatingAuthority({
    url: authorityUrl, token: authorityToken, file: join(dataDir, 'rating-outbox.sqlite'), log,
    allowInsecureForTests: opts.ratingAuthorityAllowInsecureForTests === true,
    requestMs: opts.ratingAuthorityRequestMs, retryMs: opts.ratingAuthorityRetryMs,
  }) : dataDir ? localRatingAuthority(openLeaderboard(join(dataDir, 'leaderboard.sqlite')), {
    minSeconds: config.leaderboardMinSeconds ?? DEFAULT_SERVER_CONFIG.leaderboardMinSeconds, clock,
    names: (opts.accountsAuthorityUrl ?? process.env.ACCOUNTS_AUTHORITY_URL) ? async (devices) => {
      if (devices.some((device) => !/^a_[A-Za-z0-9_-]{8,60}$/.test(device))) throw new Error('Account-ranked leaderboard contains a non-account identity; complete the season reset before startup')
      const ids = [...new Set(devices.map((device) => device.slice(2)))]
      const names = ids.length ? await accounts.names(ids) : new Map()
      return new Map(devices.map((device) => {
        const name = names.get(device.slice(2))
        if (!name) throw new Error('Missing canonical account name')
        return [device, name]
      }))
    } : undefined,
  }) : undefined
  const privateAuthority = !authorityUrl && authorityToken ? authority : undefined
  const accountsUrl = opts.accountsAuthorityUrl ?? process.env.ACCOUNTS_AUTHORITY_URL ?? ''
  if (accountsUrl && !dataDir) throw new Error('Account progression requires DATA_DIR for durable storage')
  const accounts = accountsUrl ? regionalAccounts({ url: accountsUrl, token: authorityToken, region: config.region, log,
    rewardFile: join(dataDir, 'progression-outbox.sqlite'),
    allowInsecureForTests: opts.accountsAllowInsecureForTests === true }) : undefined
  const perf = opts.perf ?? createServerPerf()
  const machine = createMachineMonitor({ perf })
  const maintenanceFile = process.env.MAINTENANCE_SECRET_FILE
  const maintenanceToken = opts.maintenanceToken ?? (maintenanceFile ? readFileSync(maintenanceFile, 'utf8').trim() : '')
  if (maintenanceToken && maintenanceToken.length < 32) throw new Error('Maintenance token must contain at least 32 characters')
  const maintenance = dataDir ? openMaintenance(join(dataDir, 'maintenance.sqlite')) : undefined
  const analytics = dataDir ? openAnalytics(join(dataDir, 'analytics.sqlite'), { now: clock,
    serverCommit: typeof __RELEASE_COMMIT__ === 'undefined' ? null : __RELEASE_COMMIT__ }) : undefined
  let pendingAuthority = 0
  const core = createServerCore(
    { ...DEFAULT_SERVER_CONFIG, ...config, build },
    {
      createMatch,
      step: perf.wrapStep(step),
      createBot,
      defaultSettings: DEFAULT_SETTINGS,
      // timeScale > 1 (tests): sim time runs faster than wall time; clients must use the same scale
      startClock: timeScale === 1 ? startClock : (onPulse) => startClock((t) => onPulse(t * timeScale)),
      now: () => performance.now() * timeScale,
      random: Math.random,
      build,
      timeScale,
      log,
      ratingAuthority: authority,
      clock,
      accounts,
      maintenance,
      analytics,
      pendingAuthority: () => pendingAuthority,
    },
  )
  const ipOf = (req) => {
    const fwd = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : ''
    return fwd || req.socket.remoteAddress || 'unknown'
  }
  const sockets = new Set()
  const authLimit = new KeyedLimiter(config.quickplaysPerMin ?? DEFAULT_SERVER_CONFIG.quickplaysPerMin, (config.quickplaysPerMin ?? DEFAULT_SERVER_CONFIG.quickplaysPerMin) / 60)
  const origins = config.allowedOrigins ?? DEFAULT_SERVER_CONFIG.allowedOrigins
  let ready = !accounts
  const server = http.createServer(async (req, res) => {
    try {
      if (!ready) { res.writeHead(503, { 'retry-after': '2' }); res.end('Server is starting.'); req.resume(); return }
      if ((req.url ?? '').split('?')[0] === '/internal/monitoring') {
        const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); req.resume() }
        const received = Buffer.from(String(req.headers.authorization ?? ''))
        const expected = Buffer.from(`Bearer ${authorityToken}`)
        if (!authorityToken || req.headers.origin !== undefined || received.length !== expected.length || !timingSafeEqual(received, expected)) reply(403, { error: 'Forbidden.' })
        else if (req.method !== 'GET') reply(405, { error: 'Method not allowed.' })
        else {
          const days = new URL(req.url, 'http://localhost').searchParams.get('reportDays')
          if (days !== null) {
            if (!analytics) reply(503, { error: 'Analytics is not configured.' })
            else if (!Number.isInteger(Number(days)) || Number(days) < 1 || Number(days) > 30) reply(400, { error: 'Invalid report range.' })
            else reply(200, { source: config.region ?? '', ...analytics.report(Number(days)), live: core.stats() })
          } else reply(200, { version: 1, region: config.region ?? '', at: clock(), uptimeSec: process.uptime(),
            release: { version: releasePackage.version, releaseDate: releasePackage.releaseDate,
              commit: typeof __RELEASE_COMMIT__ === 'undefined' ? null : __RELEASE_COMMIT__, net: build },
            ...machine.snapshot(), ...core.stats(), ...core.monitoring(), maintenance: core.maintenance() })
        }
        return
      }
      if ((req.url ?? '').split('?')[0] === '/internal/analytics') {
        const received = Buffer.from(String(req.headers.authorization ?? ''))
        const expected = Buffer.from(`Bearer ${maintenanceToken}`)
        let status, body
        if (!maintenanceToken || req.headers.origin !== undefined || received.length !== expected.length || !timingSafeEqual(received, expected)) { status = 403; body = { error: 'forbidden' } }
        else if (req.method !== 'GET') { status = 405; body = { error: 'method not allowed' } }
        else if (!analytics) { status = 503; body = { error: 'Analytics requires DATA_DIR.' } }
        else {
          const days = Number(new URL(req.url, 'http://localhost').searchParams.get('days') ?? 30)
          if (!Number.isInteger(days) || days < 1 || days > 365) { status = 400; body = { error: 'days must be an integer from 1 to 365' } }
          else { status = 200; body = { source: config.region ?? '', ...analytics.report(days), live: core.stats() } }
        }
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); req.resume(); return
      }
      if ((req.url ?? '').split('?')[0] === '/internal/maintenance') {
        const reply = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify(body))
        }
        const received = Buffer.from(String(req.headers.authorization ?? ''))
        const expected = Buffer.from(`Bearer ${maintenanceToken}`)
        if (!maintenanceToken || req.headers.origin !== undefined || received.length !== expected.length || !timingSafeEqual(received, expected)) reply(403, { error: 'forbidden' })
        else if (req.method === 'GET') reply(200, core.maintenance())
        else if (req.method !== 'POST') reply(405, { error: 'method not allowed' })
        else if (!maintenance) reply(503, { error: 'Persistent regional maintenance requires DATA_DIR.' })
        else if (String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') reply(415, { error: 'expected JSON' })
        else {
          const raw = await readBody(req, 2048)
          if (raw === null) reply(413, { error: 'too large' })
          else {
            let state
            try { state = JSON.parse(raw) } catch { reply(400, { error: 'expected JSON' }); req.resume(); return }
            if (!validMaintenance(state)) reply(400, { error: 'Expected draining and a bounded message (null to use the standard notice).' })
            else {
              const status = core.setMaintenance(state)
              log('info', 'maintenance.changed', { draining: status.draining, activeMatches: status.activeMatches, ready: status.ready })
              reply(200, status)
            }
          }
        }
        req.resume(); return
      }
      if ((req.url ?? '').split('?')[0] === '/ice') {
        const r = ice.handle({ method: req.method ?? 'GET', origin: req.headers.origin ?? null, ip: ipOf(req) })
        res.writeHead(r.status, r.headers)
        res.end(r.status === 204 ? '' : JSON.stringify(r.body))
        req.resume()
        return
      }
      if ((req.url ?? '').split('?')[0].startsWith('/internal/rating/')) {
        const reply = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify(body))
        }
        const received = Buffer.from(String(req.headers.authorization ?? ''))
        const expected = Buffer.from(`Bearer ${authorityToken}`)
        if (!privateAuthority || req.headers.origin || received.length !== expected.length || !timingSafeEqual(received, expected)) {
          reply(403, { error: 'forbidden' })
        } else if (req.method !== 'POST') reply(405, { error: 'method not allowed' })
        else {
          const raw = await readBody(req, 128 * 1024)
          if (raw === null) reply(413, { error: 'too large' })
          else {
            let body
            try { body = JSON.parse(raw) } catch { reply(400, { error: 'expected JSON' }); req.resume(); return }
            const path = (req.url ?? '').split('?')[0]
            if (path === '/internal/rating/record') {
              if (!validRatingSubmission(body)) reply(400, { error: 'invalid rating submission' })
              else {
                pendingAuthority++
                try { reply(200, await privateAuthority.record(body)) }
                catch (error) {
                  log('error', 'rating.authority.error', { error: String(error) })
                  reply(String(error).includes('idempotency key conflicts') ? 409 : 503, { error: 'The rating submission could not be applied.' })
                }
                finally { pendingAuthority-- }
              }
            } else if (path === '/internal/rating/rename') {
              if (!body || typeof body.device !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.device)
                || typeof body.name !== 'string' || !body.name || body.name.length > 24 || /[\u0000-\u001f\u007f]/.test(body.name)
                || Object.keys(body).some((k) => k !== 'device' && k !== 'name')) reply(400, { error: 'invalid display label' })
              else {
                pendingAuthority++
                try { reply(200, { changed: await privateAuthority.rename(body.device, body.name) }) }
                finally { pendingAuthority-- }
              }
            } else if (path === '/internal/rating/read') {
              if (!body || typeof body.path !== 'string' || body.path.length > 2048 || !/^\/(leaderboard(?:\?|$)|players\/[A-Za-z0-9_-]{8,64}(?:\/history(?:\?[^#]*)?)?$|profiles\/[0-9a-f-]{36}(?:\/history(?:\?[^#]*)?)?$)/.test(body.path)
                || Object.keys(body).length !== 1) reply(400, { error: 'invalid rating read' })
              else reply(200, await privateAuthority.read(body.path))
            } else reply(404, { error: 'not found' })
          }
        }
        req.resume()
        return
      }
      const body = await readBody(req)
      let account
      if (accounts && req.method === 'POST' && (req.url ?? '').split('?')[0] === '/ranked') {
        const origin = req.headers.origin ?? null
        if (origins !== null && (!origin || !origins.includes(origin))) { res.writeHead(403); res.end('Origin not allowed.'); return }
        authLimit.sweep(performance.now())
        if (!authLimit.take(ipOf(req), performance.now())) {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60', ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}) })
          res.end('{"error":"Too many ranked requests. Try again in a minute."}'); return
        }
        if (body === null) { res.writeHead(413, { 'content-type': 'application/json' }); res.end('{"error":"Request is too large."}'); return }
        let proof
        try { const data = JSON.parse(body); if (data && Object.keys(data).length === 1) proof = data.accountToken } catch { /* handled as missing proof */ }
        try { account = await accounts.verify(proof) }
        catch {
          res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': req.headers.origin && (config.allowedOrigins ?? []).includes(req.headers.origin) ? req.headers.origin : 'null', vary: 'Origin' })
          res.end('{"error":"Sign in and choose your player name before joining ranked."}'); return
        }
      }
      const r = await core.http({ method: req.method ?? 'GET', path: req.url ?? '/', ip: ipOf(req), origin: req.headers.origin ?? null, body, account })
      const health = req.method === 'GET' && (req.url ?? '').split('?')[0] === '/health' && r.status === 200
      res.writeHead(r.status, r.headers)
      res.end(health ? JSON.stringify({ ...JSON.parse(r.body), perf: perf.snapshot() }) : r.body)
    } catch (e) {
      log('error', 'http.error', { error: String(e) })
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"error":"internal"}')
    }
    req.resume()
  })
  server.on('upgrade', (req, socket) => {
    if (!ready || sockets.size >= (config.maxRooms ?? DEFAULT_SERVER_CONFIG.maxRooms) * 12) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return }
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const ip = ipOf(req)
    const key = req.headers['sec-websocket-key']
    const admission = core.admit(req.url ?? '/', ip, req.headers.origin ?? null)
    if (admission.kind === 'refuse' || typeof key !== 'string' || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
      const status = admission.kind === 'refuse' ? `${admission.status} ${admission.reason}` : '400 Bad Request'
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
      return
    }
    const acceptKey = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey}\r\n\r\n`)
    socket.setNoDelay(true)
    const textSocket = wrapSocket(socket, log)
    if (!accounts || admission.kind !== 'room') { core.attach(admission, textSocket, ip); return }
    let busy = false
    let done = false
    const timer = setTimeout(() => { done = true; textSocket.close() }, 8000)
    textSocket.onClose(() => { done = true; clearTimeout(timer) })
    textSocket.onText(async (text) => {
      if (busy || done) return
      busy = true
      try {
        const hello = JSON.parse(text)
        if (!hello || hello.t !== 'account' || Object.keys(hello).some((key) => !['t', 'token', 'playToken'].includes(key)) || typeof hello.playToken !== 'string') throw new Error('Reload the game to complete account verification.')
        const account = hello.token === null ? null : await accounts.verify(hello.token)
        await core.authorize(admission.code, account)
        if (done) return
        const started = performance.now()
        const permission = await accounts.attachPlay(hello.playToken, admission.code, account?.id ?? null)
        let deadline = started + permission.expiresAt - permission.serverTime - 1000
        let checking = false, closed = false, nextCheck = 0, transferring = false
        const moved = (transfer = false) => {
          if (closed) return
          transferring = transfer
          textSocket.send(JSON.stringify({ t: 'kick', reason: 'Your game was moved to another tab or device.' }))
          textSocket.close()
        }
        const check = setInterval(async () => {
          if (closed) return
          if (performance.now() >= deadline) { moved(); return }
          if (checking || performance.now() < nextCheck) return
          checking = true
          const at = performance.now()
          nextCheck = at + 5000
          try {
            const next = await accounts.checkPlay(hello.playToken, permission.connection)
            if (!next.ok) moved(next.transferring === true)
            else deadline = at + next.expiresAt - next.serverTime - 1000
          } catch { if (performance.now() >= deadline) moved() }
          finally { checking = false }
        }, 1000)
        const permissionClosed = () => { if (closed) return; closed = true; done = true; clearInterval(check); clearTimeout(timer); accounts.detachPlay(permission.connection) }
        textSocket.onClose(permissionClosed)
        if (done) { clearInterval(check); accounts.detachPlay(permission.connection); return }
        const controlled = {
          ...textSocket,
          transferring: () => transferring,
          onText(callback) { textSocket.onText((message) => { if (performance.now() >= deadline) moved(); else if (!closed) callback(message) }) },
          onClose(callback) { textSocket.onClose(() => { permissionClosed(); callback() }) },
        }
        clearTimeout(timer)
        textSocket.send(JSON.stringify({ t: 'account-ready' }))
        core.attach(admission, controlled, ip, account)
      } catch (error) {
        if (done) return
        done = true; clearTimeout(timer)
        textSocket.send(JSON.stringify({ t: 'error', message: error instanceof Error ? error.message : 'Could not verify your account.',
          ...(error instanceof RankedConflictError ? { rankedConflict: error.rankedConflict } : {}) }))
        setTimeout(() => textSocket.close(), 150)
      }
    })
  })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, resolve)
    })
    // Registration fences previous room claims only after this process owns the port.
    analytics?.recover()
    if (accounts) await accounts.register()
    ready = true
  } catch (error) {
    machine.close()
    perf.close()
    core.close()
    analytics?.close()
    server.close()
    throw error
  }
  const sweeper = setInterval(() => { core.sweep(); ice.sweep() }, 5000)
  log('info', 'server.start', { port: server.address().port, host, build, region: config.region ?? '', ratings: authorityUrl ? 'remote-global' : authority ? 'local-global' : 'disabled' })
  return {
    port: server.address().port,
    core,
    async room(code) {
      return core.room(code) ?? core.createRoom({ code })
    },
    createRoom: (o) => core.createRoom(o),
    async close() {
      clearInterval(sweeper)
      machine.close()
      perf.close()
      core.close()
      analytics?.close()
      for (const s of sockets) s.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
