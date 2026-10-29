// Leaderboard storage (M4.3) on Node's built-in SQLite (node:sqlite: no native
// dependency; unflagged since Node 22.13, it prints an ExperimentalWarning that pm2's
// node_args silence). Implements LeaderboardStore (src/net/leaderboard.ts).
// One file, WAL journal; every match is one transaction, so a crash or `pm2 reload`
// keeps either the whole match or none of it.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { addRecordedMatch, cleanBuild, emptyTotals } from '../src/game/stats.ts'
import { recordSeconds } from '../src/shared/recordTime.ts'

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
CREATE TABLE IF NOT EXISTS player_public_ids (
  device TEXT PRIMARY KEY REFERENCES players(device), public_id TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS player_details (
  device TEXT PRIMARY KEY REFERENCES players(device), detail TEXT NOT NULL,
  first_at INTEGER NOT NULL, last_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS match_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_key TEXT UNIQUE NOT NULL, public_id TEXT UNIQUE NOT NULL,
  at INTEGER NOT NULL, region TEXT NOT NULL, room TEXT NOT NULL,
  queue TEXT NOT NULL CHECK(queue IN ('ranked', 'casual', 'custom')),
  ticks INTEGER NOT NULL, rounds INTEGER NOT NULL,
  team_mode TEXT NOT NULL, game_mode TEXT NOT NULL, roster TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS match_history_seats (
  match_id INTEGER NOT NULL REFERENCES match_history(id), device TEXT NOT NULL,
  player INTEGER NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('win', 'loss', 'forfeit')),
  delta REAL, rating REAL,
  PRIMARY KEY(match_id, device)
);
CREATE INDEX IF NOT EXISTS match_history_device ON match_history_seats(device, match_id);
CREATE INDEX IF NOT EXISTS match_history_at ON match_history(at DESC, id DESC);
-- Publication is opt-in. Historical rows with unknown visibility remain unlisted.
CREATE TABLE IF NOT EXISTS match_history_public (
  match_id INTEGER PRIMARY KEY REFERENCES match_history(id)
);
-- Unfinished and partly played ranked combat (src/net/leaderboard.ts unfinishedActivity):
-- the same folded aggregate as player_details, kept apart so complete-match coverage stays
-- exact. No players FK: activity may precede a player's first rated result.
CREATE TABLE IF NOT EXISTS player_activity (
  device TEXT PRIMARY KEY, detail TEXT NOT NULL,
  first_at INTEGER NOT NULL, last_at INTEGER NOT NULL
);
-- Casual quick-play combat, complete and partial games alike (same selection and fold as
-- player_activity), kept apart so ranked coverage and casual game counts stay separate.
CREATE TABLE IF NOT EXISTS player_casual (
  device TEXT PRIMARY KEY, detail TEXT NOT NULL,
  first_at INTEGER NOT NULL, last_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ranked_result_flags (
  match_id INTEGER NOT NULL, device TEXT NOT NULL, forfeited INTEGER NOT NULL CHECK(forfeited IN (0, 1)),
  PRIMARY KEY(match_id, device),
  FOREIGN KEY(match_id, device) REFERENCES results(match_id, device)
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
  publicId: r.public_id,
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
  ...(r.forfeited === null || r.forfeited === undefined ? {} : { forfeited: r.forfeited === 1 }),
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
  const insPublicId = db.prepare('INSERT INTO player_public_ids (device, public_id) VALUES (?, ?) ON CONFLICT(device) DO NOTHING')
  const getPublicDevice = db.prepare('SELECT device FROM player_public_ids WHERE public_id = ?')
  const getDetails = db.prepare('SELECT detail, first_at, last_at FROM player_details WHERE device = ?')
  const upDetails = db.prepare(`INSERT INTO player_details (device, detail, first_at, last_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(device) DO UPDATE SET detail = excluded.detail,
      first_at = MIN(player_details.first_at, excluded.first_at), last_at = MAX(player_details.last_at, excluded.last_at)`)
  const getActivity = db.prepare('SELECT detail, first_at, last_at FROM player_activity WHERE device = ?')
  const upActivity = db.prepare(`INSERT INTO player_activity (device, detail, first_at, last_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(device) DO UPDATE SET detail = excluded.detail,
      first_at = MIN(player_activity.first_at, excluded.first_at), last_at = MAX(player_activity.last_at, excluded.last_at)`)
  const getCasual = db.prepare('SELECT detail, first_at, last_at FROM player_casual WHERE device = ?')
  const upCasual = db.prepare(`INSERT INTO player_casual (device, detail, first_at, last_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(device) DO UPDATE SET detail = excluded.detail,
      first_at = MIN(player_casual.first_at, excluded.first_at), last_at = MAX(player_casual.last_at, excluded.last_at)`)
  const insResultFlags = db.prepare('INSERT INTO ranked_result_flags(match_id, device, forfeited) VALUES (?, ?, ?)')
  const insHistory = db.prepare(`INSERT INTO match_history
    (receipt_key, public_id, at, region, room, queue, ticks, rounds, team_mode, game_mode, roster)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const insHistorySeat = db.prepare('INSERT INTO match_history_seats(match_id, device, player, outcome, delta, rating) VALUES (?, ?, ?, ?, ?, ?)')
  const insPublicHistory = db.prepare('INSERT INTO match_history_public(match_id) VALUES (?)')

  // Add opaque identities to legacy players without changing their results or
  // rating. Old binaries ignore these additive tables and keep working.
  const missingPublicIds = db.prepare('SELECT device FROM players WHERE device NOT IN (SELECT device FROM player_public_ids)')
  function ensurePublicIds() {
    for (const { device } of missingPublicIds.all()) insPublicId.run(device, randomUUID())
  }
  ensurePublicIds()

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
      if (r.forfeited !== undefined) insResultFlags.run(id, r.device, r.forfeited ? 1 : 0)
    }
    for (const p of players) {
      upPlayer.run(p.device, p.name, p.tag, p.rating, p.matches, p.wins, p.roundsPlayed, p.roundsWon, p.kills, p.deaths, p.firstAt, p.lastAt)
      insPublicId.run(p.device, randomUUID())
    }
    for (const r of results) {
      if (!r.stats) continue
      const previous = getDetails.get(r.device)
      const detail = previous ? JSON.parse(previous.detail) : { matches: 0, seconds: 0, damage: 0, totals: emptyTotals(), spells: {}, hallOfFame: {} }
      // The numeric match row is a public reference, never an internal receipt,
      // room token, device ID or client profile ID.
      addRecordedMatch(detail, r.stats, Math.round(recordSeconds(m.ticks)), m.at, String(id))
      upDetails.run(r.device, JSON.stringify(detail), m.at, m.at)
    }
  }

  // Runs only inside a receipt transaction, so a retried submission never folds twice.
  function writeFold(get, up, prefix, { at, rows }) {
    for (const { device, stats, seconds } of rows) {
      const previous = get.get(device)
      const detail = previous ? JSON.parse(previous.detail) : { matches: 0, seconds: 0, damage: 0, totals: emptyTotals(), spells: {}, hallOfFame: {} }
      // Hall of Fame references stay opaque ordinals, never receipt keys or rooms.
      addRecordedMatch(detail, stats, seconds, at, `${prefix}-${detail.matches + 1}`)
      up.run(device, JSON.stringify(detail), at, at)
    }
  }

  // History is independent of ranked player totals: a casual-only account needs
  // neither an Elo row nor a public leaderboard identity to retain its matches.
  function writeHistory(key, h) {
    const fields = ['player', 'name', 'color', 'kind', 'team', 'score', 'roundsPlayed', 'roundsWon', 'kills', 'deaths', 'won', 'forfeited', 'build']
    const roster = h.players.map((p) => {
      const row = Object.fromEntries(fields.filter((field) => Object.hasOwn(p, field)).map((field) => [field, p[field]]))
      if (p.build !== undefined) {
        row.build = cleanBuild(p.build)
        if (!row.build) throw new Error('Invalid recorded match build')
      }
      return row
    })
    const id = insHistory.run(key, randomUUID(), h.at, h.region, h.room, h.queue, h.ticks, h.rounds, h.teamMode, h.gameMode, JSON.stringify(roster)).lastInsertRowid
    if (h.public === true) insPublicHistory.run(id)
    const identities = new Map()
    for (const p of h.players) if (p.device !== undefined && p.kind !== 'bot') identities.set(p.device, (identities.get(p.device) ?? 0) + 1)
    for (const p of h.players) {
      // One browser controlling multiple seats has no unambiguous personal
      // outcome. Exclude every association for that identity, as Elo does.
      if (p.device === undefined || p.kind === 'bot' || identities.get(p.device) !== 1) continue
      const delta = h.deltas?.[p.device]
      insHistorySeat.run(id, p.device, p.player, p.forfeited ? 'forfeit' : p.won ? 'win' : 'loss', delta?.delta ?? null, delta?.rating ?? null)
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
    SELECT p.device AS device, ids.public_id, p.name AS name, p.tag AS tag, p.rating AS rating, p.rating - 1000 AS gain, p.matches, p.wins, p.rounds_played,
      p.rounds_won, p.kills, p.deaths, p.last_at
    FROM players p JOIN player_public_ids ids ON ids.device = p.device
    WHERE p.matches > 0 ${where}`
  const weekSql = (where) => `
    SELECT r.device AS device, ids.public_id, p.name AS name, p.tag AS tag, p.rating AS rating, SUM(r.delta) AS gain, COUNT(*) AS matches, SUM(r.won) AS wins,
      SUM(r.rounds_played) AS rounds_played, SUM(r.rounds_won) AS rounds_won, SUM(r.kills) AS kills,
      SUM(r.deaths) AS deaths, MAX(r.at) AS last_at
    FROM results r JOIN players p ON p.device = r.device JOIN player_public_ids ids ON ids.device = p.device
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
        if (settled.history) writeHistory(key, settled.history)
        if (settled.activity) writeFold(getActivity, upActivity, 'partial', settled.activity)
        if (settled.casual) writeFold(getCasual, upCasual, 'casual', settled.casual)
        insReceipt.run(key, fingerprint, JSON.stringify(settled.rating))
        db.exec('COMMIT')
        return settled.rating
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },

    top(q, limit) {
      // A draining old process can still commit a legacy result during rollout.
      ensurePublicIds()
      return stmt(`SELECT * FROM (${boardSql(q)}) ORDER BY ${order(q)} LIMIT ?`).all(...args(q), limit).map(board)
    },

    rank(q, device) {
      ensurePublicIds()
      const r = stmt(`SELECT * FROM (SELECT b.*, ROW_NUMBER() OVER (ORDER BY ${order(q)}) AS rk FROM (${boardSql(q)}) b) WHERE device = ?`).get(...args(q), device)
      return r ? { rank: r.rk, row: board(r) } : null
    },

    recent(device, limit) {
      return stmt(`SELECT r.*, f.forfeited FROM results r
        LEFT JOIN ranked_result_flags f ON f.match_id = r.match_id AND f.device = r.device
        WHERE r.device = ? ORDER BY r.at DESC, r.match_id DESC LIMIT ?`).all(device, limit).map(result)
    },

    history(device, { queue, limit }) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid match history limit')
      if (queue !== undefined && !['ranked', 'casual', 'custom'].includes(queue)) throw new Error('Invalid match history queue')
      return stmt(`SELECT h.*, s.player, s.outcome, s.delta, s.rating
        FROM match_history_seats s JOIN match_history h ON h.id = s.match_id
        WHERE s.device = ? ${queue === undefined ? '' : 'AND h.queue = ?'}
        ORDER BY h.at DESC, h.id DESC LIMIT ?`)
        .all(device, ...(queue === undefined ? [] : [queue]), limit)
        .map((r) => ({ id: r.public_id, at: r.at, region: r.region, queue: r.queue, ticks: r.ticks, rounds: r.rounds,
          teamMode: r.team_mode, gameMode: r.game_mode, self: r.player, outcome: r.outcome,
          delta: r.delta, rating: r.rating, players: JSON.parse(r.roster) }))
    },

    recentMatches({ queue, limit }) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('Invalid recent matches limit')
      if (queue !== undefined && !['ranked', 'casual', 'custom'].includes(queue)) throw new Error('Invalid recent matches queue')
      return stmt(`SELECT h.* FROM match_history h JOIN match_history_public p ON p.match_id = h.id
        ${queue === undefined ? '' : 'WHERE h.queue = ?'} ORDER BY h.at DESC, h.id DESC LIMIT ?`)
        .all(...(queue === undefined ? [] : [queue]), limit)
        .map(r => ({ id: r.public_id, at: r.at, region: r.region, queue: r.queue, ticks: r.ticks, rounds: r.rounds,
          teamMode: r.team_mode, gameMode: r.game_mode, players: JSON.parse(r.roster) }))
    },

    // Operator-only: who played how much in [since, until], across every queue.
    playerActivity(since, until) {
      const rows = stmt(`SELECT s.device, s.outcome, h.at, h.queue, h.ticks,
          json_extract(r.value, '$.name') AS name, json_extract(r.value, '$.kills') AS kills, json_extract(r.value, '$.deaths') AS deaths
        FROM match_history_seats s JOIN match_history h ON h.id = s.match_id
        LEFT JOIN json_each(h.roster) r ON json_extract(r.value, '$.player') = s.player
        WHERE h.at >= ? AND h.at <= ? ORDER BY h.at, h.id`).all(since, until)
      const players = new Map()
      for (const r of rows) {
        let p = players.get(r.device)
        if (!p) players.set(r.device, p = { device: r.device, name: '', matches: 0, wins: 0, forfeits: 0, seconds: 0, kills: 0, deaths: 0,
          queues: { ranked: 0, casual: 0, custom: 0 }, days: new Set(), firstAt: r.at, lastAt: r.at })
        // ascending order: the last name seen is the current one
        if (r.name) p.name = r.name
        p.matches++
        if (r.outcome === 'win') p.wins++
        if (r.outcome === 'forfeit') p.forfeits++
        p.seconds += recordSeconds(r.ticks)
        p.kills += r.kills ?? 0
        p.deaths += r.deaths ?? 0
        p.queues[r.queue]++
        p.days.add(new Date(r.at).toISOString().slice(0, 10))
        p.lastAt = r.at
      }
      return [...players.values()].map((p) => ({ ...p, seconds: Math.round(p.seconds), days: p.days.size }))
    },

    /** Start of the recorded history, or null while it is empty. */
    historySince() {
      return stmt('SELECT MIN(at) AS at FROM match_history').get().at ?? null
    },

    ratingChanges(devices, since, until) {
      const ids = [...new Set(devices)]
      if (ids.length === 0) return new Map()
      // Historical player rows need no inferred baseline: an empty rated-results window sums to zero.
      const rows = stmt(`SELECT p.device, COALESCE(SUM(r.delta), 0) AS change
        FROM players p LEFT JOIN results r ON r.device = p.device AND r.at >= ? AND r.at <= ?
        WHERE p.device IN (${ids.map(() => '?').join(',')}) GROUP BY p.device`).all(since, until, ...ids)
      return new Map(rows.map((row) => [row.device, row.change]))
    },

    publicDevice(publicId) {
      return getPublicDevice.get(publicId)?.device ?? null
    },

    details(device) {
      const row = getDetails.get(device)
      return row ? { detail: JSON.parse(row.detail), firstAt: row.first_at, lastAt: row.last_at } : null
    },

    activity(device) {
      const row = getActivity.get(device)
      return row ? { detail: JSON.parse(row.detail), firstAt: row.first_at, lastAt: row.last_at } : null
    },

    casual(device) {
      const row = getCasual.get(device)
      return row ? { detail: JSON.parse(row.detail), firstAt: row.first_at, lastAt: row.last_at } : null
    },

    close() {
      db.close()
    },
  }
}
