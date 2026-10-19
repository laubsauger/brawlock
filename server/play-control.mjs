import { createHash, randomBytes, randomUUID } from 'node:crypto'

export const PLAY_TTL_MS = 30000
export const PLAY_SCHEMA = `
CREATE TABLE play_sessions (
  id TEXT PRIMARY KEY, secret TEXT NOT NULL UNIQUE,
  user_id TEXT UNIQUE REFERENCES user(id) ON DELETE CASCADE,
  device TEXT NOT NULL UNIQUE, controller TEXT NOT NULL, target TEXT NOT NULL,
  expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, released INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE play_connections (
  session_id TEXT PRIMARY KEY REFERENCES play_sessions(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL UNIQUE, region TEXT NOT NULL, instance TEXT NOT NULL, room TEXT NOT NULL
);
CREATE INDEX play_expiry ON play_sessions(expires);
`
const MODES = ['local', 'practice', 'host', 'p2p', 'join', 'server', 'casual', 'ranked']
const hash = (token) => createHash('sha256').update(token).digest('hex')

export function playTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !MODES.includes(value.mode)
    || Object.keys(value).some((key) => !['mode', 'region', 'code'].includes(key))
    || !(value.region === null || typeof value.region === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value.region))
    || !(value.code === null || typeof value.code === 'string' && /^[A-Z]{5}$/.test(value.code))) throw new Error('Invalid game destination')
  return { mode: value.mode, region: value.region, code: value.code }
}

/** One active game per account OR browser, independent of game mode. */
export function createPlayControl(db, { now = Date.now } = {}) {
  const sweep = db.prepare('DELETE FROM play_sessions WHERE expires<=?')
  const lookup = db.prepare('SELECT * FROM play_sessions WHERE secret=?')
  const blockers = db.prepare('SELECT * FROM play_sessions WHERE device=? OR (user_id IS NOT NULL AND user_id=?) ORDER BY id')
  const attached = db.prepare('SELECT * FROM play_connections WHERE session_id=?')
  const removeReleased = db.prepare('DELETE FROM play_sessions WHERE id=? AND released=1 AND NOT EXISTS(SELECT 1 FROM play_connections WHERE session_id=?)')
  function transaction(run) {
    db.exec('BEGIN IMMEDIATE')
    try { const result = run(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function owned(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid game permission')
    return lookup.get(hash(token))
  }
  function valid(row) { return row && row.expires > now() && !row.revoked && !row.released }
  function clock(row) { return { id: row.id, expiresAt: row.expires, serverTime: now() } }
  function actor(identity) {
    if (!identity || !/^[a-f0-9]{64}$/.test(identity.device) || !/^[a-f0-9]{64}$/.test(identity.controller)
      || !(identity.userId === null || typeof identity.userId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(identity.userId))) throw new Error('Invalid game identity')
  }
  return {
    acquire(identity, target) {
      actor(identity); const destination = playTarget(target)
      return transaction(() => {
        sweep.run(now())
        const occupied = blockers.all(identity.device, identity.userId)
        if (occupied.length) {
          const row = occupied[0]
          return { ok: false, conflict: { id: row.id, target: JSON.parse(row.target), kind: row.device === identity.device ? 'device' : 'account', sameAccount: row.user_id === identity.userId } }
        }
        if (db.prepare('SELECT COUNT(*) AS n FROM play_sessions').get().n >= 10000) throw new Error('Game session capacity reached')
        const id = randomUUID(), token = randomBytes(32).toString('base64url'), expires = now() + PLAY_TTL_MS
        db.prepare('INSERT INTO play_sessions(id,secret,user_id,device,controller,target,expires) VALUES (?,?,?,?,?,?,?)')
          .run(id, hash(token), identity.userId, identity.device, identity.controller, JSON.stringify(destination), expires)
        return { ok: true, token, id, expiresAt: expires, serverTime: now() }
      })
    },
    heartbeat(token, target, identity) {
      actor(identity)
      const destination = playTarget(target)
      return transaction(() => {
        const row = owned(token)
        if (!valid(row) || row.user_id !== identity.userId || row.device !== identity.device || row.controller !== identity.controller) return { ok: false }
        const expires = now() + PLAY_TTL_MS
        db.prepare('UPDATE play_sessions SET expires=?,target=? WHERE id=?').run(expires, JSON.stringify(destination), row.id)
        return { ok: true, ...clock({ ...row, expires }) }
      })
    },
    takeover(identity, id) {
      actor(identity)
      // Request revocation. Never grant the next game before the old owner yields or expires.
      const row = blockers.all(identity.device, identity.userId).find((entry) => entry.id === id)
      if (!row) return { ok: true }
      db.prepare('UPDATE play_sessions SET revoked=1 WHERE id=?').run(row.id)
      return { ok: true }
    },
    release(token) {
      transaction(() => {
        const row = owned(token)
        if (!row) return
        db.prepare('UPDATE play_sessions SET released=1 WHERE id=?').run(row.id)
        removeReleased.run(row.id, row.id)
      })
    },
    attach(token, region, instance, room, accountId) {
      return transaction(() => {
        const row = owned(token)
        if (!valid(row)) throw new Error('Your game permission expired or moved to another tab. Return to the menu and try again.')
        if (accountId && row.user_id !== accountId) throw new Error('Game permission belongs to a different account')
        if (db.prepare('SELECT instance FROM account_regions WHERE region=?').get(region)?.instance !== instance) throw new Error('Game server instance is not current')
        if (attached.get(row.id)) throw new Error('Your previous game connection is still closing. Try again in a moment.')
        const target = JSON.parse(row.target)
        if (!['join', 'server', 'casual', 'ranked'].includes(target.mode)) throw new Error('This permission belongs to a local or player-hosted game')
        if (target.region && target.region !== region || target.code && target.code !== room) throw new Error('Game permission has a different destination')
        const connection = randomUUID()
        db.prepare('INSERT INTO play_connections VALUES (?,?,?,?,?)').run(row.id, connection, region, instance, room)
        db.prepare('UPDATE play_sessions SET target=? WHERE id=?').run(JSON.stringify({ mode: target.mode === 'join' ? 'server' : target.mode, region, code: room }), row.id)
        return { ok: true, connection, ...clock(row) }
      })
    },
    check(token, connection) {
      const row = owned(token)
      if (!valid(row) || attached.get(row.id)?.connection_id !== connection) return { ok: false }
      return { ok: true, ...clock(row) }
    },
    detach(region, instance, connection) {
      transaction(() => {
        const row = db.prepare('DELETE FROM play_connections WHERE region=? AND instance=? AND connection_id=? RETURNING session_id').get(region, instance, connection)
        if (row) removeReleased.run(row.session_id, row.session_id)
      })
    },
    register(region, instance) {
      db.prepare('DELETE FROM play_connections WHERE region=? AND instance<>?').run(region, instance)
      db.prepare('DELETE FROM play_sessions WHERE released=1 AND NOT EXISTS(SELECT 1 FROM play_connections WHERE session_id=play_sessions.id)').run()
    },
  }
}
