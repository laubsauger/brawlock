// Private first-party inbox, independent of account and progression schemas.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, timingSafeEqual } from 'node:crypto'
import { KeyedLimiter } from '../src/net/ratelimit.ts'
import { embedCors, embedOrigins } from './embed-origins.mjs'
import { FEEDBACK_BODY_BYTES, FEEDBACK_IMAGE_BYTES, FEEDBACK_IMAGE_DIMENSION, FEEDBACK_UUID, validFeedbackSubmission } from '../src/net/feedback.ts'

const MAX_ADDRESSES = 10_000
const REFILL_MS = 3 * 3600_000 / 5
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const json = (status, body, headers = {}) => Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } })
class FeedbackError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
async function readBody(request) {
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > FEEDBACK_BODY_BYTES)) throw new FeedbackError(413, 'Request is too large.')
  const chunks = []
  let bytes = 0
  if (!request.body) throw new FeedbackError(400, 'Expected JSON.')
  const reader = request.body.getReader()
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > FEEDBACK_BODY_BYTES) {
        await reader.cancel()
        throw new FeedbackError(413, 'Request is too large.')
      }
      chunks.push(next.value)
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
    catch { throw new FeedbackError(400, 'Expected JSON.') }
  } finally { reader.releaseLock() }
}
function imageDimensions(bytes, mime) {
  if (mime === 'image/png') {
    if (bytes.length < 45 || !bytes.subarray(0, 8).equals(pngSignature)) throw new FeedbackError(400, 'Invalid PNG screenshot.')
    let at = 8
    let dimensions = null
    let imageData = false
    while (at + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(at)
      if (length > bytes.length - at - 12) break
      const type = bytes.toString('ascii', at + 4, at + 8)
      if (at === 8 && type !== 'IHDR') break
      if (type === 'IHDR') {
        if (dimensions || length !== 13 || bytes[at + 18] !== 0 || bytes[at + 19] !== 0 || bytes[at + 20] > 1) break
        dimensions = { width: bytes.readUInt32BE(at + 8), height: bytes.readUInt32BE(at + 12) }
      }
      if (type === 'IDAT') imageData = true
      if (type === 'IEND') {
        if (length !== 0 || at + 12 !== bytes.length || bytes.readUInt32BE(at + 8) !== 0xae426082 || !imageData) break
        if (dimensions) return dimensions
        break
      }
      at += length + 12
    }
    throw new FeedbackError(400, 'Invalid PNG screenshot.')
  }
  if (bytes.length < 16 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) throw new FeedbackError(400, 'Invalid JPEG screenshot.')
  let at = 2
  let dimensions = null
  while (at + 2 <= bytes.length) {
    if (bytes[at++] !== 0xff) break
    while (bytes[at] === 0xff) at++
    const marker = bytes[at++]
    if (marker === 0xd9 || marker === 0x00 || marker === undefined) break
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue
    if (at + 2 > bytes.length) break
    const length = bytes.readUInt16BE(at)
    if (length < 2 || at + length > bytes.length) break
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8 || dimensions) break
      dimensions = { width: bytes.readUInt16BE(at + 5), height: bytes.readUInt16BE(at + 3) }
    }
    if (marker === 0xda) {
      if (dimensions && at + length < bytes.length - 2) return dimensions
      break
    }
    at += length
  }
  throw new FeedbackError(400, 'Invalid JPEG screenshot.')
}
function screenshotBytes(screenshot) {
  if (!screenshot) return null
  const bytes = Buffer.from(screenshot.data, 'base64')
  if (bytes.length > FEEDBACK_IMAGE_BYTES || bytes.toString('base64') !== screenshot.data) throw new FeedbackError(400, 'Invalid screenshot size or encoding.')
  const dimensions = imageDimensions(bytes, screenshot.mime)
  if (dimensions.width !== screenshot.width || dimensions.height !== screenshot.height
    || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > FEEDBACK_IMAGE_DIMENSION || dimensions.height > FEEDBACK_IMAGE_DIMENSION) {
    throw new FeedbackError(400, 'Screenshot dimensions do not match its image.')
  }
  return bytes
}

export function openFeedback(file, { origin, token, getAccount, now = Date.now, embeds = [] }) {
  const url = new URL(origin)
  if (url.origin !== origin || !['https:', 'http:'].includes(url.protocol) || url.protocol === 'http:' && url.hostname !== 'localhost') throw new Error('Feedback requires an exact HTTPS origin or HTTP localhost')
  if (typeof token !== 'string' || token.length < 32) throw new Error('Feedback operator token must contain at least 32 characters')
  if (getAccount !== undefined && typeof getAccount !== 'function') throw new Error('Invalid feedback account lookup')
  embedOrigins(embeds)
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file)
  try {
    if (file !== ':memory:') chmodSync(file, 0o600)
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
    const version = Number(db.prepare('PRAGMA user_version').get().user_version)
    if (version === 0) db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE feedback (
        id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, account_id TEXT, received_at INTEGER NOT NULL,
        payload TEXT NOT NULL, screenshot BLOB
      );
      CREATE INDEX feedback_received ON feedback(received_at DESC, id DESC);
      PRAGMA user_version=1;
      COMMIT;`)
    else if (version !== 1) throw new Error('Unsupported feedback schema version')
    // Additive side table: the previous release can still open schema 1 on rollback.
    db.exec(`CREATE TABLE IF NOT EXISTS feedback_delivery (id TEXT PRIMARY KEY, mailed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS feedback_mail_outbox (id INTEGER PRIMARY KEY CHECK(id=1), key TEXT NOT NULL, reports TEXT NOT NULL, payload TEXT NOT NULL);`)
    const mailRows = db.prepare("SELECT id,received_at AS at,json_extract(payload,'$.kind') AS kind,substr(json_extract(payload,'$.message'),1,600) AS message FROM feedback WHERE NOT EXISTS (SELECT 1 FROM feedback_delivery d WHERE d.id=feedback.id) ORDER BY received_at,id LIMIT 25")
    const find = db.prepare('SELECT * FROM feedback WHERE id=?')
    const insert = db.prepare('INSERT INTO feedback(id,fingerprint,account_id,received_at,payload,screenshot) VALUES(?,?,?,?,?,?)')
    const recent = db.prepare(`SELECT id, received_at, account_id, json_extract(payload,'$.kind') AS kind,
      substr(json_extract(payload,'$.message'),1,240) AS message,
      json_extract(payload,'$.context.release') AS release, json_extract(payload,'$.context.build') AS build,
      json_extract(payload,'$.context.screen') AS screen, screenshot IS NOT NULL AS has_screenshot
      FROM feedback ORDER BY received_at DESC,id DESC LIMIT ?`)
    const before = db.prepare(`SELECT id, received_at, account_id, json_extract(payload,'$.kind') AS kind,
      substr(json_extract(payload,'$.message'),1,240) AS message,
      json_extract(payload,'$.context.release') AS release, json_extract(payload,'$.context.build') AS build,
      json_extract(payload,'$.context.screen') AS screen, screenshot IS NOT NULL AS has_screenshot
      FROM feedback WHERE received_at<? OR (received_at=? AND id<?) ORDER BY received_at DESC,id DESC LIMIT ?`)
    const limiter = new KeyedLimiter(3, 5 / 3600)
    const addresses = new Map()
    const expectedToken = Buffer.from(`Bearer ${token}`)
    const checkRetry = (old, fingerprint) => {
      if (old.fingerprint !== fingerprint) throw new FeedbackError(409, 'This feedback ID already contains a different report.')
      return json(200, { id: old.id, receivedAt: old.received_at })
    }
    async function submit(request, embedded) {
      if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' }, { allow: 'POST' })
      if (request.headers.get('origin') !== origin && !embedded) return json(403, { error: 'Origin required.' })
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json(415, { error: 'Expected JSON.' })
      const ip = request.headers.get('x-brawlock-client-ip')
      if (!ip || ip.length > 128) return json(400, { error: 'Missing trusted connection address.' })
      const body = await readBody(request)
      if (!validFeedbackSubmission(body)) return json(400, { error: 'Invalid feedback report.' })
      // an embedded client is cross-site: it never carries the first-party session
      const account = getAccount && !embedded ? await getAccount(request) : null
      if (account !== null && (!account || typeof account.id !== 'string' || !account.id || account.id.length > 128)) throw new Error('Invalid verified feedback account')
      const accountId = account?.id ?? null
      const fingerprint = createHash('sha256').update(canonical({ accountId, submission: body })).digest('hex')
      const old = find.get(body.id)
      if (old) return checkRetry(old, fingerprint)
      const receivedAt = now()
      if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) throw new Error('Invalid feedback clock')
      limiter.sweep(receivedAt)
      for (const [address, last] of addresses) if (receivedAt - last >= REFILL_MS) addresses.delete(address)
      if (!addresses.has(ip) && addresses.size >= MAX_ADDRESSES) return json(429, { error: 'Feedback is busy. Please try again later.' })
      addresses.set(ip, receivedAt)
      if (!limiter.take(ip, receivedAt)) return json(429, { error: 'Too many reports. Please try again later.' }, { 'retry-after': '720' })
      const image = screenshotBytes(body.screenshot)
      const { screenshot, ...submission } = body
      const payload = { ...submission, ...(screenshot ? { screenshot: { mime: screenshot.mime, width: screenshot.width, height: screenshot.height } } : {}) }
      db.exec('BEGIN IMMEDIATE')
      try {
        const existing = find.get(body.id)
        if (existing) {
          const reply = checkRetry(existing, fingerprint)
          db.exec('COMMIT')
          return reply
        }
        insert.run(body.id, fingerprint, accountId, receivedAt, JSON.stringify(payload), image)
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
      return json(201, { id: body.id, receivedAt })
    }
    function inbox(request, url) {
      const receivedToken = Buffer.from(request.headers.get('authorization') ?? '')
      if (request.headers.has('origin') || receivedToken.length !== expectedToken.length || !timingSafeEqual(receivedToken, expectedToken)) return json(403, { error: 'Forbidden.' })
      if (request.method !== 'GET') return json(405, { error: 'Method not allowed.' }, { allow: 'GET' })
      if (url.pathname === '/internal/feedback') {
        if ([...url.searchParams.keys()].some((key) => !['limit', 'before'].includes(key))
          || ['limit', 'before'].some((key) => url.searchParams.getAll(key).length > 1)) return json(400, { error: 'Invalid inbox query.' })
        const limit = Number(url.searchParams.get('limit') ?? '25')
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return json(400, { error: 'Limit must be 1–100.' })
        const cursor = url.searchParams.get('before')
        let rows
        if (cursor === null) rows = recent.all(limit + 1)
        else {
          const split = /^(\d{1,13}):(.+)$/.exec(cursor)
          if (!split || !FEEDBACK_UUID.test(split[2]) || !Number.isSafeInteger(Number(split[1]))) return json(400, { error: 'Invalid inbox cursor.' })
          rows = before.all(Number(split[1]), Number(split[1]), split[2], limit + 1)
        }
        const more = rows.length > limit
        const reports = rows.slice(0, limit).map((r) => ({ id: r.id, receivedAt: r.received_at, accountId: r.account_id,
          kind: r.kind, message: r.message, release: r.release, build: r.build, screen: r.screen, hasScreenshot: r.has_screenshot === 1 }))
        const last = reports.at(-1)
        return json(200, { reports, nextBefore: more ? `${last.receivedAt}:${last.id}` : null })
      }
      const id = url.pathname.slice('/internal/feedback/'.length)
      if (!FEEDBACK_UUID.test(id) || url.search) return json(404, { error: 'Report not found.' })
      const row = find.get(id)
      if (!row) return json(404, { error: 'Report not found.' })
      const report = JSON.parse(row.payload)
      if (report.screenshot) report.screenshot.data = Buffer.from(row.screenshot).toString('base64')
      return json(200, { ...report, receivedAt: row.received_at, accountId: row.account_id })
    }
    return {
      async handler(request) {
        const from = request.headers.get('origin')
        const cors = from !== origin && embeds.includes(from) ? embedCors(from) : null
        try {
          const url = new URL(request.url)
          if (url.pathname === '/api/feedback') {
            if (cors && request.method === 'OPTIONS') return new Response(null, { status: 204, headers: embedCors(from, true) })
            const response = await submit(request, cors !== null)
            if (cors) for (const [name, value] of Object.entries(cors)) response.headers.set(name, value)
            return response
          }
          if (url.pathname === '/internal/feedback' || url.pathname.startsWith('/internal/feedback/')) return inbox(request, url)
          return json(404, { error: 'Not found.' })
        } catch (error) {
          return json(error instanceof FeedbackError ? error.status : 500,
            { error: error instanceof FeedbackError ? error.message : 'Feedback could not be saved. Please try again.' }, cors ?? {})
        }
      },
      mailBatch() { return mailRows.all() },
      mailDelivery(build) {
        db.exec('BEGIN IMMEDIATE')
        try {
          let row = db.prepare('SELECT key,reports,payload FROM feedback_mail_outbox WHERE id=1').get()
          if (!row) {
            const reports = mailRows.all()
            if (!reports.length) { db.exec('COMMIT'); return null }
            const key = `feedback/${createHash('sha256').update(reports.map((r) => r.id).join(':')).digest('hex')}`
            row = { key, reports: JSON.stringify(reports.map((r) => r.id)), payload: JSON.stringify(build(reports)) }
            db.prepare('INSERT INTO feedback_mail_outbox VALUES (1,?,?,?)').run(row.key, row.reports, row.payload)
          }
          db.exec('COMMIT')
          return { key: row.key, payload: row.payload }
        } catch (error) { db.exec('ROLLBACK'); throw error }
      },
      completeMail(key) {
        db.exec('BEGIN IMMEDIATE')
        try {
          const row = db.prepare('SELECT reports FROM feedback_mail_outbox WHERE id=1 AND key=?').get(key)
          if (!row) throw new Error('Feedback mail batch is not pending')
          const mark = db.prepare('INSERT OR IGNORE INTO feedback_delivery SELECT id,? FROM feedback WHERE id=?')
          for (const id of JSON.parse(row.reports)) mark.run(now(), id)
          db.prepare('DELETE FROM feedback_mail_outbox WHERE id=1 AND key=?').run(key)
          db.exec('COMMIT')
        } catch (error) { db.exec('ROLLBACK'); throw error }
      },
      lastMailedAt() { return db.prepare('SELECT MAX(mailed_at) AS at FROM feedback_delivery').get().at },
      markMailed(ids) {
        const mark = db.prepare('INSERT OR IGNORE INTO feedback_delivery SELECT id,? FROM feedback WHERE id=?')
        db.exec('BEGIN IMMEDIATE')
        try { for (const id of ids) mark.run(now(), id); db.exec('COMMIT') }
        catch (error) { db.exec('ROLLBACK'); throw error }
      },
      mailPending() { return db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE NOT EXISTS (SELECT 1 FROM feedback_delivery d WHERE d.id=feedback.id)').get().n },
      close() { db.close() },
    }
  } catch (error) { db.close(); throw error }
}
