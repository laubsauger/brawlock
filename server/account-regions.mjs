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
  const occupied = db.prepare('SELECT region, instance, room FROM ranked_occupancy WHERE user_id = ?')
  const knownAccount = db.prepare('SELECT id FROM user WHERE id = ?')
  const insert = db.prepare('INSERT INTO ranked_occupancy(user_id, region, instance, room) VALUES (?, ?, ?, ?)')
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

  return {
    register(region, instance) {
      generation(region, instance)
      transaction(() => {
        if (registered.get(region)?.instance === instance) return
        clearRegion.run(region)
        registerRegion.run(region, instance)
      })
    },
    claim(region, instance, userId, room) {
      generation(region, instance)
      account(userId)
      roomCode(room)
      return transaction(() => {
        current(region, instance)
        const game = occupied.get(userId)
        if (game) {
          if (game.region === region && game.instance === instance && game.room === room) return { ok: true }
          return { ok: false, game: { region: game.region, room: game.room } }
        }
        if (!knownAccount.get(userId)) throw new Error('Ranked account does not exist')
        insert.run(userId, region, instance, room)
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
  }
}
