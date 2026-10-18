// Leaderboard storage (M4.3) on Node's built-in SQLite (node:sqlite: no native
// dependency; unflagged since Node 22.13, it prints an ExperimentalWarning that pm2's
// node_args silence). Implements LeaderboardStore (src/net/leaderboard.ts).
// One file, WAL journal; every match is one transaction, so a crash or `pm2 reload`
// keeps either the whole match or none of it.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL, region TEXT NOT NULL, room TEXT NOT NULL,
  ticks INTEGER NOT NULL, rounds INTEGER NOT NULL, humans INTEGER NOT NULL, bots INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS results (
  match_id INTEGER NOT NULL REFERENCES matches(id),
  device TEXT NOT NULL, name TEXT NOT NULL, at INTEGER NOT NULL, region TEXT NOT NULL,
  won INTEGER NOT NULL, rounds_played INTEGER NOT NULL, rounds_won INTEGER NOT NULL,
  kills INTEGER NOT NULL, deaths INTEGER NOT NULL, delta REAL NOT NULL, rating REAL NOT NULL,
  PRIMARY KEY (match_id, device)
);
CREATE INDEX IF NOT EXISTS results_at ON results(at);
CREATE INDEX IF NOT EXISTS results_device ON results(device, at);
CREATE TABLE IF NOT EXISTS players (
  device TEXT PRIMARY KEY, name TEXT NOT NULL, tag TEXT NOT NULL, rating REAL NOT NULL,
  matches INTEGER NOT NULL, wins INTEGER NOT NULL, rounds_played INTEGER NOT NULL,
  rounds_won INTEGER NOT NULL, kills INTEGER NOT NULL, deaths INTEGER NOT NULL,
  first_at INTEGER NOT NULL, last_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS players_rating ON players(rating DESC);
CREATE TABLE IF NOT EXISTS rating_receipts (
  key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, verdict TEXT NOT NULL
);
`

const player = (r) => ({
  device: r.device,
  name: r.name,
  tag: r.tag,
  rating: r.rating,
  matches: r.matches,
  wins: r.wins,
  roundsPlayed: r.rounds_played,
  roundsWon: r.rounds_won,
  kills: r.kills,
  deaths: r.deaths,
  firstAt: r.first_at,
  lastAt: r.last_at,
})

const board = (r) => ({
  device: r.device,
  name: r.name,
  tag: r.tag,
  rating: r.rating,
  gain: r.gain,
  matches: r.matches,
  wins: r.wins,
  roundsPlayed: r.rounds_played,
  roundsWon: r.rounds_won,
  kills: r.kills,
  deaths: r.deaths,
  lastAt: r.last_at,
})

const result = (r) => ({
  device: r.device,
  name: r.name,
  at: r.at,
  region: r.region,
  won: r.won === 1,
  roundsPlayed: r.rounds_played,
  roundsWon: r.rounds_won,
  kills: r.kills,
  deaths: r.deaths,
  delta: r.delta,
  rating: r.rating,
})

/** Open (or create) the store at `file` (':memory:' for tests). */
export function openLeaderboard(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  db.exec(SCHEMA)

  const insMatch = db.prepare('INSERT INTO matches (at, region, room, ticks, rounds, humans, bots) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const insResult = db.prepare(
    'INSERT INTO results (match_id, device, name, at, region, won, rounds_played, rounds_won, kills, deaths, delta, rating) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const upPlayer = db.prepare(`
    INSERT INTO players (device, name, tag, rating, matches, wins, rounds_played, rounds_won, kills, deaths, first_at, last_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device) DO UPDATE SET name = excluded.name, tag = excluded.tag, rating = excluded.rating,
      matches = excluded.matches, wins = excluded.wins, rounds_played = excluded.rounds_played,
      rounds_won = excluded.rounds_won, kills = excluded.kills, deaths = excluded.deaths,
      first_at = MIN(players.first_at, excluded.first_at), last_at = excluded.last_at`)
  const getPlayer = db.prepare('SELECT * FROM players WHERE device = ?')
  const renamePlayer = db.prepare('UPDATE players SET name = ? WHERE device = ? AND name <> ?')
  const getReceipt = db.prepare('SELECT fingerprint, verdict FROM rating_receipts WHERE key = ?')
  const insReceipt = db.prepare('INSERT INTO rating_receipts (key, fingerprint, verdict) VALUES (?, ?, ?)')

  function receipt(key, fingerprint) {
    const r = getReceipt.get(key)
    if (!r) return null
    if (r.fingerprint !== fingerprint) throw new Error('Rating idempotency key conflicts with a different match')
    return JSON.parse(r.verdict)
  }

  function writeMatch(m, results, players) {
    const id = insMatch.run(m.at, m.region, m.room, m.ticks, m.rounds, m.humans, m.bots).lastInsertRowid
    for (const r of results) {
      insResult.run(id, r.device, r.name, r.at, r.region, r.won ? 1 : 0, r.roundsPlayed, r.roundsWon, r.kills, r.deaths, r.delta, r.rating)
    }
    for (const p of players) {
      upPlayer.run(p.device, p.name, p.tag, p.rating, p.matches, p.wins, p.roundsPlayed, p.roundsWon, p.kills, p.deaths, p.firstAt, p.lastAt)
    }
  }

  function commit(m, results, players, saved) {
    db.exec('BEGIN IMMEDIATE')
    try {
      if (saved && receipt(saved.key, saved.fingerprint)) {
        db.exec('COMMIT')
        return
      }
      writeMatch(m, results, players)
      if (saved) insReceipt.run(saved.key, saved.fingerprint, JSON.stringify(saved.rating))
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }

  // 'all': players by rating. 'week': players with results since ?, by rating gained then.
  // Region filter: devices with a result in that region (each server holds its own region).
  const allSql = (where) => `
    SELECT p.device AS device, p.name AS name, p.tag AS tag, p.rating AS rating, p.rating - 1000 AS gain, p.matches, p.wins, p.rounds_played,
      p.rounds_won, p.kills, p.deaths, p.last_at
    FROM players p
    WHERE p.matches > 0 ${where}`
  const weekSql = (where) => `
    SELECT r.device AS device, p.name AS name, p.tag AS tag, p.rating AS rating, SUM(r.delta) AS gain, COUNT(*) AS matches, SUM(r.won) AS wins,
      SUM(r.rounds_played) AS rounds_played, SUM(r.rounds_won) AS rounds_won, SUM(r.kills) AS kills,
      SUM(r.deaths) AS deaths, MAX(r.at) AS last_at
    FROM results r JOIN players p ON p.device = r.device
    WHERE r.at >= ? ${where}
    GROUP BY r.device`
  const order = (q) => (q.period === 'week' ? 'gain DESC, rating DESC, device' : 'rating DESC, rounds_won DESC, device')
  const regionAll = 'AND EXISTS (SELECT 1 FROM results x WHERE x.device = p.device AND x.region = ?)'
  const stmts = new Map()
  const stmt = (sql) => {
    let s = stmts.get(sql)
    if (!s) stmts.set(sql, (s = db.prepare(sql)))
    return s
  }
  const boardSql = (q) => (q.period === 'week' ? weekSql(q.region ? 'AND r.region = ?' : '') : allSql(q.region ? regionAll : ''))
  const args = (q) => (q.period === 'week' ? [q.since, ...(q.region ? [q.region] : [])] : q.region ? [q.region] : [])

  return {
    rename(device, name) {
      return renamePlayer.run(name, device, name).changes > 0
    },

    players(devices) {
      const out = new Map()
      for (const d of devices) {
        const r = getPlayer.get(d)
        if (r) out.set(d, player(r))
      }
      return out
    },

    commit,
    receipt,
    rememberReceipt(key, fingerprint, rating) {
      if (!receipt(key, fingerprint)) insReceipt.run(key, fingerprint, JSON.stringify(rating))
    },
    commitReceipt(key, fingerprint, rating, m, results, players) {
      commit(m, results, players, { key, fingerprint, rating })
    },
    applyReceipt(key, fingerprint, calculate) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const previous = receipt(key, fingerprint)
        if (previous) {
          db.exec('COMMIT')
          return previous
        }
        const settled = calculate()
        if (settled.commit) writeMatch(...settled.commit)
        insReceipt.run(key, fingerprint, JSON.stringify(settled.rating))
        db.exec('COMMIT')
        return settled.rating
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },

    top(q, limit) {
      return stmt(`SELECT * FROM (${boardSql(q)}) ORDER BY ${order(q)} LIMIT ?`).all(...args(q), limit).map(board)
    },

    rank(q, device) {
      const r = stmt(`SELECT * FROM (SELECT b.*, ROW_NUMBER() OVER (ORDER BY ${order(q)}) AS rk FROM (${boardSql(q)}) b) WHERE device = ?`).get(...args(q), device)
      return r ? { rank: r.rk, row: board(r) } : null
    },

    recent(device, limit) {
      return stmt('SELECT * FROM results WHERE device = ? ORDER BY at DESC, match_id DESC LIMIT ?').all(device, limit).map(result)
    },

    close() {
      db.close()
    },
  }
}
