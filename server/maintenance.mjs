import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { validMaintenance } from '../src/net/maintenance.ts'

/** Small independent operator-state database. FULL/WAL transactions survive a
 * process restart or reboot; malformed existing state is a startup error. */
export function openMaintenance(file) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file)
  try {
    chmodSync(file, 0o600)
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='regional_maintenance'").get()) db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE regional_maintenance (
        id INTEGER PRIMARY KEY CHECK(id=1), draining INTEGER NOT NULL CHECK(draining IN (0,1)), message TEXT
      );
      INSERT INTO regional_maintenance(id,draining,message) VALUES(1,0,NULL); COMMIT;`)
    const read = db.prepare('SELECT draining, message FROM regional_maintenance WHERE id=1')
    const write = db.prepare('UPDATE regional_maintenance SET draining=?, message=? WHERE id=1')
    const get = () => {
      const row = read.get()
      const state = { draining: row?.draining === 1, message: row?.message }
      if (!row || ![0, 1].includes(row.draining) || !validMaintenance(state)) throw new Error('Invalid persisted regional maintenance state')
      return state
    }
    get()
    return {
      get,
      set(state) {
        if (!validMaintenance(state)) throw new Error('Invalid regional maintenance state')
        write.run(state.draining ? 1 : 0, state.message)
      },
      close: () => db.close(),
    }
  } catch (error) { db.close(); throw error }
}
