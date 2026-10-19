// Completed, server-observed matches survive both an authority outage and a reboot.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function progressionOutbox({ file, send, log, retryMs = 2000 }) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS reward_outbox (
      match_id TEXT PRIMARY KEY, receipt TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL DEFAULT 0
    );`)
  const get = db.prepare('SELECT receipt FROM reward_outbox WHERE match_id=?')
  const add = db.prepare('INSERT OR IGNORE INTO reward_outbox(match_id, receipt) VALUES (?, ?)')
  const first = db.prepare('SELECT * FROM reward_outbox ORDER BY rowid LIMIT 1')
  const remove = db.prepare('DELETE FROM reward_outbox WHERE match_id=?')
  const failed = db.prepare('UPDATE reward_outbox SET attempts=attempts+1,next_at=? WHERE match_id=?')
  let closed = false
  let inflight = null
  async function drain() {
    const delivered = new Map()
    for (let i = 0; i < 16 && !closed; i++) {
      const row = first.get()
      if (!row || row.next_at > Date.now()) break
      try {
        const response = await send(JSON.parse(row.receipt))
        if (closed) break
        if (!response || typeof response.duplicate !== 'boolean' || !Array.isArray(response.rewards)) throw new Error('Invalid reward receipt response')
        remove.run(row.match_id)
        delivered.set(row.match_id, response.rewards.length ? 'awarded' : 'ineligible')
        log('info', 'progression.delivered', { attempts: row.attempts + 1 })
      } catch {
        if (closed) break
        failed.run(Date.now() + Math.min(60000, retryMs * 2 ** Math.min(row.attempts, 5)), row.match_id)
        log('warn', 'progression.pending', { attempts: row.attempts + 1 })
        break
      }
    }
    return delivered
  }
  function flush() {
    if (closed) return Promise.resolve(new Map())
    if (!inflight) inflight = drain().finally(() => { inflight = null })
    return inflight
  }
  const timer = setInterval(() => { void flush() }, retryMs)
  timer.unref()
  return {
    async record(receipt) {
      if (closed) throw new Error('Progression outbox is closed')
      const raw = JSON.stringify(receipt)
      const previous = get.get(receipt.matchId)
      if (previous && previous.receipt !== raw) throw new Error('Conflicting progression receipt')
      add.run(receipt.matchId, raw)
      const delivered = await flush()
      return delivered.get(receipt.matchId) ?? 'pending'
    },
    pending() { return closed ? 0 : Number(db.prepare('SELECT COUNT(*) AS n FROM reward_outbox').get().n) },
    close() { closed = true; clearInterval(timer); db.close() },
  }
}
