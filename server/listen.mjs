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
  const { port = 5350, host = '127.0.0.1', build = NET_BUILD, config = {}, trustProxy = false, timeScale = 1, log = jsonLog, dataDir = '', clock } = opts
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
  }) : undefined
  const privateAuthority = !authorityUrl && authorityToken ? authority : undefined
  const perf = opts.perf ?? createServerPerf()
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
    },
  )
  const ipOf = (req) => {
    const fwd = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : ''
    return fwd || req.socket.remoteAddress || 'unknown'
  }
  const sockets = new Set()
  const server = http.createServer(async (req, res) => {
    try {
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
                try { reply(200, await privateAuthority.record(body)) }
                catch (error) {
                  log('error', 'rating.authority.error', { error: String(error) })
                  reply(String(error).includes('idempotency key conflicts') ? 409 : 503, { error: 'The rating submission could not be applied.' })
                }
              }
            } else if (path === '/internal/rating/rename') {
              if (!body || typeof body.device !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.device)
                || typeof body.name !== 'string' || !body.name || body.name.length > 24 || /[\u0000-\u001f\u007f]/.test(body.name)
                || Object.keys(body).some((k) => k !== 'device' && k !== 'name')) reply(400, { error: 'invalid display label' })
              else reply(200, { changed: await privateAuthority.rename(body.device, body.name) })
            } else if (path === '/internal/rating/read') {
              if (!body || typeof body.path !== 'string' || body.path.length > 2048 || !/^\/(leaderboard(?:\?|$)|players\/[A-Za-z0-9_-]{8,64}$|profiles\/[0-9a-f-]{36}$)/.test(body.path)
                || Object.keys(body).length !== 1) reply(400, { error: 'invalid rating read' })
              else reply(200, await privateAuthority.read(body.path))
            } else reply(404, { error: 'not found' })
          }
        }
        req.resume()
        return
      }
      const body = await readBody(req)
      const r = await core.http({ method: req.method ?? 'GET', path: req.url ?? '/', ip: ipOf(req), origin: req.headers.origin ?? null, body })
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
    core.attach(admission, wrapSocket(socket, log), ip)
  })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, resolve)
    })
  } catch (error) {
    perf.close()
    core.close()
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
      perf.close()
      core.close()
      for (const s of sockets) s.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
