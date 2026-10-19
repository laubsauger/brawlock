// Global ranked occupancy belongs to the account authority, not regional clocks.
// A region releases its previous generation only when a new process registers.
export const ACCOUNT_REGIONS_SCHEMA = `
CREATE TABLE account_regions (
  region TEXT PRIMARY KEY,
  instance TEXT NOT NULL
);
CREATE TABLE ranked_occupancy (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  region TEXT NOT NULL REFERENCES account_regions(region),
  instance TEXT NOT NULL,
  room TEXT NOT NULL
);
`

export const ACCOUNT_CONTROL_SCHEMA = `
ALTER TABLE ranked_occupancy ADD COLUMN device TEXT;
ALTER TABLE ranked_occupancy ADD COLUMN controller TEXT;
ALTER TABLE ranked_occupancy ADD COLUMN disconnected INTEGER NOT NULL DEFAULT 0;
CREATE TABLE ranked_devices (
  device TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES ranked_occupancy(user_id) ON DELETE CASCADE
);
CREATE INDEX ranked_devices_user ON ranked_devices(user_id);
CREATE TABLE ranked_admissions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  device TEXT NOT NULL,
  controller TEXT NOT NULL,
  takeover INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX ranked_admissions_expiry ON ranked_admissions(expires);
`

// Preserve recovery for pre-migration occupancy. Every new claim explicitly
// starts at zero; only the regional simulation can promote it to a played game.
export const ACCOUNT_STARTED_SCHEMA = `
ALTER TABLE ranked_occupancy ADD COLUMN started INTEGER NOT NULL DEFAULT 1 CHECK(started IN (0,1));
`

const REGION = /^[a-z][a-z0-9-]{0,31}$/
const IDENTITY = /^[A-Za-z0-9_-]{8,64}$/
const ROOM = /^[A-Z]{5}$/

function validate(value, pattern, message) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(message)
}

function generation(region, instance) {
  validate(region, REGION, 'Invalid ranked region')
  validate(instance, IDENTITY, 'Invalid ranked region instance')
}

function account(userId) {
  validate(userId, IDENTITY, 'Invalid ranked account')
}

function roomCode(room) {
  validate(room, ROOM, 'Invalid ranked room')
}

/** The caller owns the SQLite connection, foreign-key setup and explicit migration. */
export function accountRegions(db) {
  const registered = db.prepare('SELECT instance FROM account_regions WHERE region = ?')
  const registerRegion = db.prepare('INSERT INTO account_regions(region, instance) VALUES (?, ?) ON CONFLICT(region) DO UPDATE SET instance = excluded.instance')
  const clearRegion = db.prepare('DELETE FROM ranked_occupancy WHERE region = ?')
  const occupied = db.prepare('SELECT region, instance, room, device, controller, disconnected, started FROM ranked_occupancy WHERE user_id = ?')
  const deviceOwner = db.prepare('SELECT o.user_id,o.region,o.room FROM ranked_devices d JOIN ranked_occupancy o ON o.user_id=d.user_id WHERE d.device=?')
  const knownAccount = db.prepare('SELECT id FROM user WHERE id = ?')
  const insert = db.prepare('INSERT INTO ranked_occupancy(user_id, region, instance, room, device, controller, started) VALUES (?, ?, ?, ?, ?, ?, 0)')
  const startAccount = db.prepare('UPDATE ranked_occupancy SET started=1 WHERE region=? AND instance=? AND room=? AND user_id=?')
  const bindDevice = db.prepare('INSERT INTO ranked_devices VALUES (?,?) ON CONFLICT(device) DO NOTHING')
  const transfer = db.prepare('UPDATE ranked_occupancy SET device=?,controller=?,disconnected=0 WHERE user_id=?')
  const disconnect = db.prepare('UPDATE ranked_occupancy SET disconnected=1 WHERE region=? AND instance=? AND room=? AND user_id=? AND controller=?')
  const clearRoom = db.prepare('DELETE FROM ranked_occupancy WHERE region = ? AND instance = ? AND room = ?')
  const clearAccount = db.prepare('DELETE FROM ranked_occupancy WHERE region = ? AND instance = ? AND room = ? AND user_id = ?')

  function transaction(run) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = run()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  function current(region, instance) {
    if (registered.get(region)?.instance !== instance) throw new Error('Ranked region instance is not current')
  }

  function connection(info) {
    if (!info || typeof info.takeover !== 'boolean') throw new Error('Invalid ranked controller')
    validate(info.device, /^[a-f0-9]{64}$/, 'Invalid ranked device')
    validate(info.controller, /^[a-f0-9]{64}$/, 'Invalid ranked controller')
  }

  function access(userId, info) {
    account(userId)
    connection(info)
    const owner = deviceOwner.get(info.device)
    if (owner && owner.user_id !== userId) return { ok: false, conflict: 'device', game: { region: owner.region, room: owner.room } }
    const game = occupied.get(userId)
    if (game && (game.device !== info.device || game.controller !== info.controller) && !info.takeover && !game.disconnected) {
      return { ok: false, conflict: 'controller', game: { region: game.region, room: game.room } }
    }
    return { ok: true }
  }

  return {
    register(region, instance) {
      generation(region, instance)
      transaction(() => {
        if (registered.get(region)?.instance === instance) return
        clearRegion.run(region)
        registerRegion.run(region, instance)
      })
    },
    access,
    started(region, instance, room, userIds) {
      generation(region, instance); roomCode(room)
      if (!Array.isArray(userIds) || userIds.length > 10 || new Set(userIds).size !== userIds.length) throw new Error('Invalid ranked participants')
      for (const id of userIds) account(id)
      transaction(() => {
        current(region, instance)
        for (const id of userIds) startAccount.run(region, instance, room, id)
      })
    },
    disconnect(region, instance, userId, room, controller) {
      generation(region, instance); account(userId); roomCode(room)
      validate(controller, /^[a-f0-9]{64}$/, 'Invalid ranked controller')
      current(region, instance)
      disconnect.run(region, instance, room, userId, controller)
    },
    claim(region, instance, userId, room, info) {
      generation(region, instance)
      account(userId)
      roomCode(room)
      connection(info)
      return transaction(() => {
        current(region, instance)
        const allowed = access(userId, info)
        if (!allowed.ok) return allowed
        const game = occupied.get(userId)
        if (game) {
          if (game.region === region && game.instance === instance && game.room === room) {
            transfer.run(info.device, info.controller, userId)
            bindDevice.run(info.device, userId)
            return { ok: true }
          }
          return { ok: false, game: { region: game.region, room: game.room } }
        }
        if (!knownAccount.get(userId)) throw new Error('Ranked account does not exist')
        insert.run(userId, region, instance, room, info.device, info.controller)
        bindDevice.run(info.device, userId)
        return { ok: true }
      })
    },
    release(region, instance, room, userId) {
      generation(region, instance)
      roomCode(room)
      if (userId !== undefined) account(userId)
      transaction(() => {
        current(region, instance)
        if (userId === undefined) clearRoom.run(region, instance, room)
        else clearAccount.run(region, instance, room, userId)
      })
    },
    game(userId) {
      account(userId)
      const game = occupied.get(userId)
      return game ? { region: game.region, room: game.room } : null
    },
    activeGame(userId) {
      account(userId)
      const game = occupied.get(userId)
      return game?.started === 1 ? { region: game.region, room: game.room } : null
    },
  }
}
