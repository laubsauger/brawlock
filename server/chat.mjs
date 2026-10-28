// Global chat in the main menu: one channel for every signed-in player. Lines live in memory
// only (the last GLOBAL_CHAT_HISTORY); reports and mutes are kept in their own file, so a
// rollback to a release without chat never meets an unknown account schema.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHmac, randomBytes } from 'node:crypto'
import { KeyedLimiter } from '../src/net/ratelimit.ts'
import { chatText } from '../src/net/chat.ts'
import { GLOBAL_CHAT_HISTORY, GLOBAL_CHAT_REPORTS_TO_HIDE, GLOBAL_CHAT_WAIT_MS } from '../src/net/globalChat.ts'
import { PRESENCE_REGIONS } from '../src/shared/presence.ts'
import { embedCors, embedOrigins } from './embed-origins.mjs'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_report (
  line TEXT PRIMARY KEY, sender_id TEXT NOT NULL, sender TEXT NOT NULL, name TEXT NOT NULL, region TEXT NOT NULL,
  text TEXT NOT NULL, sent_at INTEGER NOT NULL, reported_at INTEGER NOT NULL, reports INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'hidden', 'kept'))
);
CREATE INDEX IF NOT EXISTS chat_report_recent ON chat_report(reported_at DESC);
CREATE TABLE IF NOT EXISTS chat_mute (
  user_id TEXT PRIMARY KEY, sender TEXT NOT NULL UNIQUE, name TEXT NOT NULL, until INTEGER, at INTEGER NOT NULL
);
`
/** long-polls held at once, in total and per address; past that a read answers at once */
const MAX_WAITERS = 2000
const WAITERS_PER_IP = 8
const json = (status, body, headers = {}) => Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } })
const isJson = (request) => request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json'
async function readBody(request) {
  const raw = await request.text()
  if (Buffer.byteLength(raw, 'utf8') > 1024) return undefined
  try {
    const body = JSON.parse(raw)
    return body && typeof body === 'object' && !Array.isArray(body) ? body : undefined
  } catch { return undefined }
}

/**
 * `speaker(request)` names the signed-in account from its session: { id, profile: { name, color }
 * | null }, or null for a guest. `feedback.note` files the first report of a line in the inbox.
 */
export function openChat(file, { origin, secret, speaker, feedback = null, embeds = [], now = Date.now, waitMs = GLOBAL_CHAT_WAIT_MS }) {
  if (typeof secret !== 'string' || !secret) throw new Error('Global chat requires a secret')
  if (typeof speaker !== 'function') throw new Error('Global chat requires a session lookup')
  embedOrigins(embeds)
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file)
  try {
    if (file !== ':memory:') chmodSync(file, 0o600)
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
    db.exec(SCHEMA)
    const getMute = db.prepare('SELECT until FROM chat_mute WHERE user_id=?')
    const getReport = db.prepare('SELECT * FROM chat_report WHERE line=?')
    const fileReport = db.prepare("INSERT INTO chat_report VALUES (?,?,?,?,?,?,?,?,1,'open')")
    const countReport = db.prepare('UPDATE chat_report SET reports=? WHERE line=?')
    const setStatus = db.prepare('UPDATE chat_report SET status=? WHERE line=?')
    const mute = db.prepare('INSERT INTO chat_mute VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET sender=excluded.sender, name=excluded.name, until=excluded.until, at=excluded.at')
    const unmute = db.prepare('DELETE FROM chat_mute WHERE sender=?')
    const recentReports = db.prepare('SELECT r.*, m.until AS muted_until, m.user_id IS NOT NULL AS muted FROM chat_report r LEFT JOIN chat_mute m ON m.user_id=r.sender_id ORDER BY r.reported_at DESC LIMIT 50')
    const activeMutes = db.prepare('SELECT sender, name, until, at FROM chat_mute WHERE until IS NULL OR until>? ORDER BY at DESC')

    // A restart starts the ids over; the epoch tells clients to drop what they hold.
    const epoch = randomBytes(4).toString('hex')
    const senderOf = (userId) => createHmac('sha256', secret).update(`chat-sender:${userId}`).digest('hex').slice(0, 16)
    /** { id, at, userId, sender, name, color, region, text, hidden, kept, reporters } */
    let lines = []
    let nextId = 1
    let version = 0
    /** the last change that brought a hidden line back: clients older than it reload everything */
    let rewritten = 0
    const waiters = new Set()
    const waitersByIp = new Map()
    const reads = new KeyedLimiter(120, 4)
    const posts = new KeyedLimiter(3, 1 / 5)
    const postsByIp = new KeyedLimiter(10, 1 / 2)
    const reports = new KeyedLimiter(6, 6 / 600)
    const lineKey = (line) => `${epoch}:${line.id}`
    const view = (line) => ({ id: line.id, at: line.at, sender: line.sender, name: line.name, color: line.color, region: line.region, text: line.text })
    const mutedUntil = (userId) => {
      const row = getMute.get(userId)
      return row && (row.until === null || row.until > now()) ? row.until : undefined
    }
    function changed(rewrite = false) {
      version++
      if (rewrite) rewritten = version
      for (const wake of [...waiters]) wake()
    }

    async function read(request, url, ip, cors) {
      const params = url.searchParams
      if ([...params.keys()].some((key) => !['epoch', 'after', 'v'].includes(key))) return json(400, { error: 'Invalid chat query.' }, cors)
      const after = Number(params.get('after') ?? 0), seen = Number(params.get('v') ?? -1)
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(seen) || seen < -1) return json(400, { error: 'Invalid chat query.' }, cors)
      const same = params.get('epoch') === epoch
      const held = waitersByIp.get(ip) ?? 0
      if (same && seen === version && waiters.size < MAX_WAITERS && held < WAITERS_PER_IP) {
        waitersByIp.set(ip, held + 1)
        await new Promise((resolve) => {
          const wake = () => {
            if (!waiters.delete(wake)) return
            clearTimeout(timer)
            const left = (waitersByIp.get(ip) ?? 1) - 1
            if (left > 0) waitersByIp.set(ip, left)
            else waitersByIp.delete(ip)
            resolve()
          }
          const timer = setTimeout(wake, waitMs)
          waiters.add(wake)
          request.signal?.addEventListener('abort', wake, { once: true })
        })
      }
      const full = !same || seen < rewritten
      return json(200, {
        epoch, version, full,
        lines: lines.filter((line) => !line.hidden && (full || line.id > after)).map(view),
        hidden: full ? [] : lines.filter((line) => line.hidden).map((line) => line.id),
      }, cors)
    }

    async function post(request, ip) {
      const who = await speaker(request)
      if (!who) return json(401, { error: 'Sign in to chat.' })
      if (!who.profile) return json(403, { error: 'Choose your player name to chat.' })
      const until = mutedUntil(who.id)
      if (until !== undefined) return json(403, { error: 'You are muted in global chat.', until })
      const at = now()
      posts.sweep(at); postsByIp.sweep(at)
      if (!posts.take(who.id, at) || !postsByIp.take(ip, at)) return json(429, { error: 'Messages are arriving too quickly. Wait a moment and try again.' })
      const body = await readBody(request)
      if (!body || Object.keys(body).some((key) => !['text', 'region'].includes(key)) || !PRESENCE_REGIONS.includes(body.region)) return json(400, { error: 'Invalid chat message.' })
      const text = chatText(body.text)
      if (!text) return json(400, { error: 'Type a message of up to 240 characters.' })
      const line = { id: nextId++, at, userId: who.id, sender: senderOf(who.id), name: who.profile.name, color: who.profile.color ?? null,
        region: body.region, text, hidden: false, kept: false, reporters: new Set() }
      lines = [...lines, line].slice(-GLOBAL_CHAT_HISTORY)
      changed()
      return json(201, { line: view(line) })
    }

    async function report(request) {
      const who = await speaker(request)
      if (!who) return json(401, { error: 'Sign in to report a message.' })
      const body = await readBody(request)
      if (!body || Object.keys(body).some((key) => key !== 'id') || !Number.isSafeInteger(body.id)) return json(400, { error: 'Invalid report.' })
      const line = lines.find((candidate) => candidate.id === body.id && !candidate.hidden)
      if (!line) return json(404, { error: 'That message is no longer in the chat.' })
      if (line.userId === who.id) return json(400, { error: 'You cannot report your own message.' })
      if (line.reporters.has(who.id)) return json(200, { reported: true })
      const at = now()
      reports.sweep(at)
      if (!reports.take(who.id, at)) return json(429, { error: 'Too many reports. Try again in a few minutes.' })
      line.reporters.add(who.id)
      const key = lineKey(line)
      if (line.reporters.size === 1) {
        fileReport.run(key, line.userId, line.sender, line.name, line.region, line.text, line.at, at)
        feedback?.note(who.id, `Global chat report: ${line.name} (${line.region}) wrote "${line.text}". Hide the line or mute the player under Operations, Global chat.`)
      } else countReport.run(line.reporters.size, key)
      if (line.reporters.size >= GLOBAL_CHAT_REPORTS_TO_HIDE && !line.kept) {
        line.hidden = true
        setStatus.run('hidden', key)
        changed()
      }
      return json(200, { reported: true })
    }

    return {
      async handler(request) {
        const url = new URL(request.url)
        const from = request.headers.get('origin')
        // An embedded client (itch.io) reads the channel with CORS; it never posts or reports.
        const cors = from && from !== origin && embeds.includes(from) ? embedCors(from) : {}
        const ip = request.headers.get('x-brawlock-client-ip')
        if (!ip) return json(400, { error: 'Missing trusted connection address.' }, cors)
        if (url.pathname === '/api/chat' && request.method === 'GET') {
          if (from && from !== origin && !embeds.includes(from)) return json(403, { error: 'Untrusted origin.' })
          reads.sweep(now())
          if (!reads.take(ip, now())) return json(429, { error: 'Chat is busy. Try again shortly.' }, cors)
          return read(request, url, ip, cors)
        }
        if (!['/api/chat', '/api/chat/report'].includes(url.pathname)) return json(404, { error: 'Not found.' })
        if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' }, cors)
        if (from !== origin) return json(403, { error: 'Chat in the game on its own site.' }, cors)
        if (!isJson(request)) return json(415, { error: 'Expected JSON.' })
        return url.pathname === '/api/chat' ? post(request, ip) : report(request)
      },

      /** Operations › Global chat; the caller has checked the operator. */
      async admin(request) {
        if (request.method === 'GET') {
          return json(200, {
            reports: recentReports.all().map((row) => ({ line: row.line, sender: row.sender, name: row.name, region: row.region, text: row.text,
              sentAt: row.sent_at, reportedAt: row.reported_at, reports: row.reports, status: row.status,
              muted: row.muted && (row.muted_until === null || row.muted_until > now()) ? { until: row.muted_until } : null })),
            mutes: activeMutes.all(now()),
          })
        }
        if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })
        if (!isJson(request)) return json(415, { error: 'Expected JSON.' })
        const body = await readBody(request)
        if (!body || !['hide', 'show', 'mute', 'unmute'].includes(body.action)) return json(400, { error: 'Choose hide, show, mute or unmute.' })
        if (body.action === 'unmute') {
          if (typeof body.sender !== 'string' || !unmute.run(body.sender).changes) return json(404, { error: 'That player is not muted.' })
          return json(200, { ok: true })
        }
        const row = typeof body.line === 'string' ? getReport.get(body.line) : undefined
        if (!row) return json(404, { error: 'Report not found.' })
        const live = row.line.startsWith(`${epoch}:`) ? lines.find((line) => lineKey(line) === row.line) : undefined
        if (body.action === 'mute') {
          if (body.hours !== null && body.hours !== 24) return json(400, { error: 'Mute for 24 hours or for good.' })
          mute.run(row.sender_id, row.sender, row.name, body.hours === null ? null : now() + body.hours * 3600_000, now())
          for (const line of lines) if (line.userId === row.sender_id) line.hidden = true
          setStatus.run('hidden', row.line)
          changed()
          return json(200, { ok: true })
        }
        setStatus.run(body.action === 'hide' ? 'hidden' : 'kept', row.line)
        if (live) {
          live.hidden = body.action === 'hide'
          live.kept = body.action === 'show'
          changed(body.action === 'show')
        }
        return json(200, { ok: true })
      },

      close() {
        for (const wake of [...waiters]) wake()
        db.close()
      },
    }
  } catch (error) { db.close(); throw error }
}
