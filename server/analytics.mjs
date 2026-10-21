// First-party operational analytics. No names, IPs, emails, cookies or raw IDs.
import { DatabaseSync } from 'node:sqlite'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { analyticsSeries } from './analytics-series.mjs'
import { analyticsFacts } from './analytics-facts.mjs'

const DAY = 86400000
const SESSION_GAP = 30 * 60000
const HEARTBEAT_GAP = 90000
const dayOf = (at) => new Date(at).toISOString().slice(0, 10)

/** Independent database: creating it never migrates or resets account/rating data. */
export function openAnalytics(file, { now = Date.now, serverCommit = null } = {}) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file)
  try {
    chmodSync(file, 0o600)
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    let version = Number(db.prepare('PRAGMA user_version').get().user_version)
    if (version === 0) db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE analytics_meta (id INTEGER PRIMARY KEY CHECK(id=1), secret TEXT NOT NULL, since INTEGER NOT NULL);
      CREATE TABLE visitors (person TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('guest','account')), first_at INTEGER NOT NULL, last_at INTEGER NOT NULL);
      CREATE TABLE activity (
        day TEXT NOT NULL, person TEXT NOT NULL REFERENCES visitors(person), region TEXT NOT NULL,
        sessions INTEGER NOT NULL, active_ms INTEGER NOT NULL,
        PRIMARY KEY(day,person,region)
      );
      CREATE TABLE peaks (day TEXT PRIMARY KEY, online INTEGER NOT NULL);
      CREATE TABLE matches (
        id TEXT PRIMARY KEY, region TEXT NOT NULL, queue TEXT NOT NULL, game_mode TEXT NOT NULL, team_mode TEXT NOT NULL,
        started_at INTEGER NOT NULL, ended_at INTEGER,
        status TEXT NOT NULL CHECK(status IN ('running','completed','abandoned','interrupted')),
        seconds REAL NOT NULL DEFAULT 0, rounds INTEGER NOT NULL DEFAULT 0, bots INTEGER NOT NULL
      );
      CREATE INDEX matches_started ON matches(started_at);
      CREATE TABLE participants (
        match_id TEXT NOT NULL REFERENCES matches(id), person TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('guest','account')), PRIMARY KEY(match_id,person)
      );
      PRAGMA user_version=1; COMMIT;`)
    else if (![1, 2, 3, 4].includes(version)) throw new Error('Unsupported analytics schema version')
    if (version === 0) version = 1
    if (version === 1) db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE browser_meta (id INTEGER PRIMARY KEY CHECK(id=1), since INTEGER NOT NULL);
      CREATE TABLE browsers (
        device TEXT PRIMARY KEY, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, guest_person TEXT REFERENCES visitors(person),
        first_guest_at INTEGER, converted_at INTEGER
      );
      CREATE TABLE browser_activity (
        day TEXT NOT NULL, device TEXT NOT NULL REFERENCES browsers(device), PRIMARY KEY(day,device)
      );
      CREATE TABLE browser_accounts (
        device TEXT NOT NULL REFERENCES browsers(device), person TEXT NOT NULL REFERENCES visitors(person),
        first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, PRIMARY KEY(device,person)
      );
      PRAGMA user_version=2; COMMIT;`)
    if (version <= 2) db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE dimension_meta (id INTEGER PRIMARY KEY CHECK(id=1), since INTEGER NOT NULL);
      ALTER TABLE matches ADD COLUMN build TEXT;
      ALTER TABLE matches ADD COLUMN commit_id TEXT;
      ALTER TABLE matches ADD COLUMN room TEXT;
      ALTER TABLE browsers ADD COLUMN converted_region TEXT;
      ALTER TABLE browsers ADD COLUMN converted_build TEXT;
      CREATE TABLE traffic_facts (
        day TEXT NOT NULL,person TEXT NOT NULL REFERENCES visitors(person),device TEXT NOT NULL,region TEXT NOT NULL,
        build TEXT NOT NULL,net TEXT NOT NULL,screen TEXT NOT NULL,sessions INTEGER NOT NULL,active_ms INTEGER NOT NULL,
        PRIMARY KEY(day,person,device,region,build,net,screen)
      );
      INSERT INTO traffic_facts SELECT day,person,'',region,'','','',sessions,active_ms FROM activity;
      CREATE TABLE presence_samples (id INTEGER PRIMARY KEY,at INTEGER NOT NULL);
      CREATE INDEX presence_sample_at ON presence_samples(at);
      CREATE TABLE presence_sample_counts (
        sample INTEGER NOT NULL REFERENCES presence_samples(id),region TEXT NOT NULL,build TEXT NOT NULL,net TEXT NOT NULL,
        screen TEXT NOT NULL,kind TEXT NOT NULL,people INTEGER NOT NULL
      );
      PRAGMA user_version=3; COMMIT;`)
    // the room's full options per match (betting, bounties, economy...), for debugging reports
    if (version <= 3) db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE matches ADD COLUMN settings TEXT;
      PRAGMA user_version=4; COMMIT;`)
    db.prepare('INSERT OR IGNORE INTO analytics_meta VALUES (1,?,?)').run(randomBytes(32).toString('hex'), now())
    db.prepare('INSERT OR IGNORE INTO browser_meta VALUES (1,?)').run(now())
    db.prepare('INSERT OR IGNORE INTO dimension_meta VALUES (1,?)').run(now())
    const meta = db.prepare('SELECT secret,since FROM analytics_meta WHERE id=1').get()
    const identitySince = db.prepare('SELECT since FROM browser_meta WHERE id=1').get().since
    const dimensionSince = db.prepare('SELECT since FROM dimension_meta WHERE id=1').get().since
    const key = (kind, id) => {
      if (!['guest', 'account', 'device'].includes(kind) || typeof id !== 'string' || !id || id.length > 256) throw new Error('Invalid analytics identity')
      return createHmac('sha256', meta.secret).update(`${kind}:${id}`).digest('hex')
    }
    const transaction = (fn) => {
      db.exec('BEGIN IMMEDIATE')
      try { const value = fn(); db.exec('COMMIT'); return value } catch (error) { db.exec('ROLLBACK'); throw error }
    }
    const visitor = db.prepare('SELECT last_at FROM visitors WHERE person=?')
    const browser = db.prepare('SELECT last_at,first_guest_at,converted_at FROM browsers WHERE device=?')
    const touchBrowser = db.prepare(`INSERT INTO browsers(device,first_at,last_at,guest_person,first_guest_at,converted_at) VALUES (?,?,?,?,?,?) ON CONFLICT(device) DO UPDATE SET
      last_at=MAX(last_at,excluded.last_at),guest_person=COALESCE(guest_person,excluded.guest_person),
      first_guest_at=COALESCE(first_guest_at,excluded.first_guest_at),converted_at=COALESCE(converted_at,excluded.converted_at)`)
    const browserDay = db.prepare('INSERT OR IGNORE INTO browser_activity VALUES (?,?)')
    const linkAccount = db.prepare(`INSERT INTO browser_accounts VALUES (?,?,?,?) ON CONFLICT(device,person)
      DO UPDATE SET last_at=MAX(last_at,excluded.last_at)`)
    const touch = db.prepare('INSERT INTO visitors VALUES (?,?,?,?) ON CONFLICT(person) DO UPDATE SET last_at=MAX(last_at,excluded.last_at)')
    const activity = db.prepare(`INSERT INTO activity VALUES (?,?,?,?,?) ON CONFLICT(day,person,region)
      DO UPDATE SET sessions=sessions+excluded.sessions,active_ms=active_ms+excluded.active_ms`)
    const peak = db.prepare('INSERT INTO peaks VALUES (?,?) ON CONFLICT(day) DO UPDATE SET online=MAX(online,excluded.online)')
    const participant = db.prepare('INSERT OR IGNORE INTO participants VALUES (?,?,?)')
    const context = db.prepare(`INSERT INTO traffic_facts VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(day,person,device,region,build,net,screen)
      DO UPDATE SET sessions=sessions+excluded.sessions,active_ms=active_ms+excluded.active_ms`)
    let lastSample = Number(db.prepare('SELECT MAX(at) AS at FROM presence_samples').get().at ?? -Infinity)
    const addSeats = (id, devices) => {
      for (const device of new Set(devices)) {
        const account = /^a_[A-Za-z0-9_-]{8,60}$/.test(device)
        const kind = account ? 'account' : 'guest'
        participant.run(id, key(kind, account ? device.slice(2) : device), kind)
      }
    }
    return {
      // Call only after binding the regional port: a duplicate process that fails
      // to listen must not mark the live process's games interrupted.
      recover() { db.prepare("UPDATE matches SET status='interrupted',ended_at=? WHERE status='running'").run(now()) },
      presence({ device, accountId, region, online, build = '', net = '', screen = '', sample }) {
        if (typeof region !== 'string' || !region || !Number.isInteger(online) || online < 0) throw new Error('Invalid analytics presence')
        const at = now(), kind = accountId ? 'account' : 'guest', person = key(kind, accountId ?? device), deviceKey = key('device', device)
        transaction(() => {
          const previous = visitor.get(person)
          const previousBrowser = browser.get(deviceKey)
          // Signing in/out on an active browser continues its visit, rather than starting a second one.
          const previousAt = Math.max(previous?.last_at ?? -Infinity, previousBrowser?.last_at ?? -Infinity)
          const gap = Math.max(0, at - previousAt)
          const sessions = gap >= SESSION_GAP ? 1 : 0
          // Split a heartbeat across midnight so each day's time stays accurate.
          const elapsed = gap <= HEARTBEAT_GAP ? gap : 0
          const midnight = Date.parse(dayOf(at) + 'T00:00:00Z')
          const todayMs = Math.min(elapsed, at - midnight)
          touch.run(person, kind, at, at)
          touchBrowser.run(deviceKey, at, at, kind === 'guest' ? person : null, kind === 'guest' ? at : null,
            kind === 'account' && previousBrowser?.first_guest_at != null ? at : null)
          browserDay.run(dayOf(at), deviceKey)
          if (kind === 'account') linkAccount.run(deviceKey, person, at, at)
          activity.run(dayOf(at), person, region, sessions, todayMs)
          context.run(dayOf(at), person, deviceKey, region, build, net, screen, sessions, todayMs)
          if (elapsed > todayMs) activity.run(dayOf(at - DAY), person, region, 0, elapsed - todayMs)
          if (elapsed > todayMs) context.run(dayOf(at - DAY), person, deviceKey, region, build, net, screen, 0, elapsed - todayMs)
          if (kind === 'account' && previousBrowser?.first_guest_at != null && previousBrowser.converted_at == null) {
            db.prepare('UPDATE browsers SET converted_region=?,converted_build=? WHERE device=?').run(region, build, deviceKey)
          }
          peak.run(dayOf(at), online)
          if (sample && at - lastSample >= 30000) {
            const id = db.prepare('INSERT INTO presence_samples(at) VALUES (?)').run(at).lastInsertRowid
            const add = db.prepare('INSERT INTO presence_sample_counts VALUES (?,?,?,?,?,?,?)')
            for (const row of sample) add.run(id, row.region, row.build, row.net, row.screen, row.kind, row.people)
            lastSample = at
          }
        })
      },
      start({ id, region, queue, settings, devices, bots, build = null, room = null }) {
        if (!['casual', 'ranked', 'custom'].includes(queue) || typeof id !== 'string' || !id || !Number.isInteger(bots) || bots < 0) throw new Error('Invalid analytics match')
        transaction(() => {
          db.prepare(`INSERT INTO matches(id,region,queue,game_mode,team_mode,started_at,status,bots,build,commit_id,room,settings) VALUES (?,?,?,?,?,?,'running',?,?,?,?,?)`)
            .run(id, region, queue, settings.gameMode, settings.teamMode, now(), bots, build, serverCommit, room, JSON.stringify(settings))
          addSeats(id, devices)
        })
      },
      join(id, device) {
        if (!db.prepare("SELECT 1 FROM matches WHERE id=? AND status='running'").get(id)) throw new Error('Analytics match is not running')
        addSeats(id, [device])
      },
      finish(id, match) {
        transaction(() => {
          const changed = db.prepare("UPDATE matches SET status='completed',ended_at=?,seconds=?,rounds=? WHERE id=? AND status='running'")
            .run(now(), match.ticks / 60, match.rounds, id)
          if (!changed.changes) throw new Error('Analytics match is not running')
          addSeats(id, match.seats.map((seat) => seat.device))
        })
      },
      abandon(id) {
        db.prepare("UPDATE matches SET status='abandoned',ended_at=? WHERE id=? AND status='running'").run(now(), id)
      },
      report(days = 30) {
        if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('Analytics days must be an integer from 1 to 365')
        const at = now(), endDay = dayOf(at), from = Date.parse(endDay + 'T00:00:00Z') - (days - 1) * DAY
        const fromDay = dayOf(from)
        const seen = db.prepare(`SELECT v.kind,COUNT(DISTINCT v.person) AS seen,
          COUNT(DISTINCT CASE WHEN v.first_at>=? THEN v.person END) AS new
          FROM visitors v JOIN activity a ON a.person=v.person WHERE a.day>=? AND a.day<=? GROUP BY v.kind`).all(from, fromDay, endDay)
        const traffic = db.prepare(`SELECT a.day,v.kind,COUNT(DISTINCT a.person) AS seen,SUM(a.sessions) AS sessions,SUM(a.active_ms) AS activeMs,
          COUNT(DISTINCT CASE WHEN date(v.first_at/1000,'unixepoch')=a.day THEN v.person END) AS new
          FROM activity a JOIN visitors v ON v.person=a.person WHERE a.day>=? AND a.day<=? GROUP BY a.day,v.kind`).all(fromDay, endDay)
        const matches = db.prepare(`SELECT region,queue,COUNT(*) AS started,
          SUM(status='completed') AS completed,SUM(status='abandoned') AS abandoned,SUM(status='interrupted') AS interrupted,SUM(status='running') AS running,
          SUM(CASE WHEN status='completed' THEN seconds ELSE 0 END) AS completedSeconds,
          SUM(CASE WHEN status='completed' THEN rounds ELSE 0 END) AS completedRounds,SUM(bots) AS botSeats
          FROM matches WHERE started_at>=? AND started_at<=? GROUP BY region,queue`).all(from, at)
        const participation = db.prepare(`SELECT m.region,m.queue,p.kind,COUNT(*) AS participations,COUNT(DISTINCT p.person) AS uniquePlayers
          FROM participants p JOIN matches m ON m.id=p.match_id WHERE m.started_at>=? AND m.started_at<=? GROUP BY m.region,m.queue,p.kind`).all(from, at)
        const matchDays = db.prepare(`SELECT date(started_at/1000,'unixepoch') AS day,COUNT(*) AS started,
          SUM(status='completed') AS completed,SUM(status='abandoned') AS abandoned,SUM(status='interrupted') AS interrupted
          FROM matches WHERE started_at>=? AND started_at<=? GROUP BY day`).all(from, at)
        const peaks = db.prepare('SELECT day,online FROM peaks WHERE day>=? AND day<=?').all(fromDay, endDay)
        const browsers = db.prepare(`SELECT COUNT(DISTINCT b.device) AS seen,
          COUNT(DISTINCT CASE WHEN b.first_at>=? THEN b.device END) AS new
          FROM browsers b JOIN browser_activity a ON a.device=b.device WHERE a.day>=? AND a.day<=?`).get(from, fromDay, endDay)
        const conversions = db.prepare('SELECT COUNT(*) AS n FROM browsers WHERE converted_at>=? AND converted_at<=?').get(from, at).n
        const browserDays = db.prepare(`SELECT a.day,COUNT(*) AS seen,
          SUM(date(b.first_at/1000,'unixepoch')=a.day) AS new
          FROM browser_activity a JOIN browsers b ON b.device=a.device WHERE a.day>=? AND a.day<=? GROUP BY a.day`).all(fromDay, endDay)
        const conversionDays = db.prepare(`SELECT date(converted_at/1000,'unixepoch') AS day,COUNT(*) AS n
          FROM browsers WHERE converted_at>=? AND converted_at<=? GROUP BY day`).all(from, at)
        const daily = Array.from({ length: days }, (_, i) => {
          const day = dayOf(from + i * DAY)
          const seenBrowsers = browserDays.find((r) => r.day === day)
          return { day, browsers: { seen: seenBrowsers?.seen ?? 0, new: seenBrowsers?.new ?? 0, guestToAccount: conversionDays.find((r) => r.day === day)?.n ?? 0 }, traffic: traffic.filter((r) => r.day === day), matches: matchDays.find((r) => r.day === day) ?? { day, started: 0, completed: 0, abandoned: 0, interrupted: 0 }, peakOnline: peaks.find((r) => r.day === day)?.online ?? 0 }
        })
        return { version: 3, generatedAt: at, trackingSince: meta.since, identityTrackingSince: identitySince, dimensionTrackingSince: dimensionSince, browsers: { ...browsers, guestToAccount: conversions }, days, from: fromDay, through: endDay,
          visitors: seen, lifetimeVisitors: db.prepare('SELECT kind,COUNT(*) AS seen FROM visitors GROUP BY kind').all(), matches, participation, daily,
          series: analyticsSeries(db, { at, days, trackingSince: meta.since }), facts: analyticsFacts(db, { at, days }) }
      },
      close() { db.close() },
    }
  } catch (error) { db.close(); throw error }
}
