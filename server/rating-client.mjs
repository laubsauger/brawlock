// Regional sim servers have no rating table. This durable FIFO only delivers mutations
// to the one authority; the stable match key survives lost replies and process restarts.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { validRatingSubmission } from '../src/net/ratingAuthority.ts'

export function remoteRatingAuthority({ url, token, file, log, allowInsecureForTests = false, requestMs = 3000, retryMs = 1000 }) {
  const base = new URL(url)
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Rating authority URL must be an origin')
  if (base.protocol !== 'https:' && !(allowInsecureForTests && base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) throw new Error('Rating authority requires HTTPS')
  if (typeof token !== 'string' || token.length < 32) throw new Error('Rating authority token must contain at least 32 characters')
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS rating_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL, op TEXT NOT NULL, payload TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, last_error TEXT);`)
  const add = db.prepare('INSERT INTO rating_outbox (key,op,payload) VALUES (?,?,?) ON CONFLICT(key) DO NOTHING')
  const get = db.prepare('SELECT * FROM rating_outbox WHERE key=?')
  const first = db.prepare('SELECT * FROM rating_outbox ORDER BY seq LIMIT 1')
  const del = db.prepare('DELETE FROM rating_outbox WHERE key=?')
  const fail = db.prepare('UPDATE rating_outbox SET attempts=attempts+1,next_at=?,last_error=? WHERE key=?')
  let closed = false
  let inflight = null

  async function rpc(op, body) {
    const res = await fetch(`${base.origin}/internal/rating/${op}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(requestMs), redirect: 'error',
    })
    if (!res.ok) throw new Error(`Rating authority returned HTTP ${res.status}`)
    const length = Number(res.headers.get('content-length'))
    if (length > 256 * 1024) throw new Error('Rating authority response too large')
    const text = await res.text()
    if (text.length > 256 * 1024) throw new Error('Rating authority response too large')
    return JSON.parse(text)
  }

  function enqueue(key, op, payload) {
    if (closed) throw new Error('Rating outbox is closed')
    const text = JSON.stringify(payload)
    const old = get.get(key)
    if (old && (old.op !== op || old.payload !== text)) throw new Error('Rating outbox key conflicts with a different request')
    add.run(key, op, text)
  }

  async function drain() {
    const delivered = new Map()
    for (let i = 0; i < 16 && !closed; i++) {
      const row = first.get()
      if (!row || row.next_at > Date.now()) break
      try {
        const value = await rpc(row.op, JSON.parse(row.payload))
        if (closed) break
        if (row.op === 'record' && !['rated', 'unrated', 'unavailable'].includes(value?.status)) throw new Error('Invalid rating authority verdict')
        if (row.op === 'rename' && typeof value?.changed !== 'boolean') throw new Error('Invalid rating rename response')
        // An authority storage error is retryable; it is never a delivered verdict.
        if (row.op === 'record' && value.status === 'unavailable') throw new Error('Rating authority could not save the match')
        del.run(row.key)
        delivered.set(row.key, row.op === 'record' ? value : value.changed)
        log('info', 'rating.outbox.delivered', { operation: row.op, attempts: row.attempts + 1 })
      } catch (error) {
        if (closed) break
        const delay = Math.min(60_000, retryMs * 2 ** Math.min(row.attempts, 10))
        fail.run(Date.now() + delay, String(error), row.key)
        log('error', 'rating.outbox.pending', { operation: row.op, attempts: row.attempts + 1, retryMs: delay, error: String(error) })
        break // FIFO also keeps a later rename after its earlier match submission.
      }
    }
    return delivered
  }

  function flush() {
    if (closed) return Promise.resolve(new Map())
    if (!inflight) inflight = drain().finally(() => { inflight = null })
    return inflight
  }
  const timer = setInterval(() => { void flush().catch((e) => log('error', 'rating.outbox.error', { error: String(e) })) }, retryMs)
  timer.unref()

  return {
    async record(submission) {
      if (!validRatingSubmission(submission)) throw new Error('Invalid rating submission')
      enqueue(submission.key, 'record', submission)
      const sent = await flush()
      return sent.get(submission.key) ?? { status: 'unavailable', reason: 'Global Elo is temporarily unavailable. This match is saved and queued for retry.' }
    },
    async rename(device, name) {
      if (typeof device !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(device)
        || typeof name !== 'string' || !name || name.length > 24 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Invalid rating display label')
      const key = randomUUID()
      enqueue(key, 'rename', { device, name })
      const sent = await flush()
      return sent.get(key) === true
    },
    async read(path) {
      const value = await rpc('read', { path })
      if (![200, 400, 404].includes(value?.status) || !Object.hasOwn(value, 'body')) throw new Error('Invalid rating authority read response')
      return value
    },
    close() {
      if (closed) return
      closed = true
      clearInterval(timer)
      db.close()
    },
    // Operational inspection for tests / server health; never includes private payloads.
    pending() { return closed ? 0 : Number(db.prepare('SELECT COUNT(*) AS n FROM rating_outbox').get().n) },
    flush,
  }
}
