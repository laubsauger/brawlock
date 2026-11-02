// The daily Gauntlet's board (docs/moonshot/specs/daily.md): attempt tokens with a salt, tape
// submission, verification with the build's own verifier, the Best and First try boards, streaks
// with a grace day, and the day's Embers. Its rows live in their own file (daily.sqlite), so a
// rollback to a release without the daily never meets an unknown account schema.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { KeyedLimiter } from '../src/net/ratelimit.ts'
import { DAY_MS, dayOf, defineDay } from '../src/game/daily/calendar.ts'
import { embedCors, embedOrigins } from './embed-origins.mjs'
import { VerifierBusy } from './daily-verifier.mjs'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS daily_attempt (
  id TEXT PRIMARY KEY, day INTEGER NOT NULL, daily_id TEXT NOT NULL, salt INTEGER NOT NULL,
  account_id TEXT, device TEXT NOT NULL, ordinal INTEGER NOT NULL, issued_at INTEGER NOT NULL, submitted_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('open', 'verified', 'rejected', 'expired')), reason TEXT,
  waves INTEGER, time_ticks INTEGER, bounty INTEGER, end_tick INTEGER, fight_ticks INTEGER, casts INTEGER, tape_hash TEXT, tape BLOB,
  flags TEXT, hidden INTEGER NOT NULL DEFAULT 0, claimed_at INTEGER
);
CREATE INDEX IF NOT EXISTS daily_board ON daily_attempt(day, status, waves DESC, time_ticks);
CREATE INDEX IF NOT EXISTS daily_account ON daily_attempt(day, account_id);
CREATE INDEX IF NOT EXISTS daily_device ON daily_attempt(day, device);
`
/** ranked attempts per player per day; later ones are practice */
export const DAILY_RANKED_ATTEMPTS = 20
/** an attempt token is good this long */
export const DAILY_TOKEN_MS = 60 * 60_000
/** a day's board closes this long after the day ends */
export const DAILY_CLOSE_MS = 30 * 60_000
/** the day's reward, and every seventh day of a streak */
export const DAILY_EMBERS = 15
export const DAILY_STREAK_EMBERS = 75
/** an idle run earns nothing: at least this much fighting and this many casts */
const REWARD_FIGHT_SECONDS = 30
const REWARD_CASTS = 5
/** the run's rate (DAILY_HZ in src/game/daily/run.ts) */
const HZ = 30
const TAPE_GZ_MAX = 96 * 1024
const TAPE_JSON_MAX = 1024 * 1024
const BODY_MAX = 160 * 1024
const BOARD_SIZE = 50
/** flags for the operator, never automatic rejections */
const ORDERS_PER_SECOND_FLAG = 8
const LATE_FLAG_MS = 15 * 60_000
/** tapes are kept this long (Watch, disputes); rows stay for streaks */
const TAPE_DAYS = 14
const ROW_DAYS = 400

const json = (status, body, headers = {}) => Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } })
const isJson = (request) => request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json'
const device = (v) => typeof v === 'string' && v.length >= 8 && v.length <= 128 && !/[\u0000-\u001f\u007f]/.test(v)
const attemptId = (v) => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v)

/**
 * Consecutive days played up to `today`, with one grace day per 7: a single missed day keeps the
 * streak when the last grace was at least 7 days earlier; days the service issued no token to
 * anyone never break it; today not played yet does not break it either. Returns the count, and
 * whether the most recent miss was forgiven (a smouldering flame).
 */
export function streakOf(played, outage, today, from = today - ROW_DAYS) {
  let count = 0
  let lastGrace = -Infinity
  let smoulder = false
  for (let d = from; d <= today; d++) {
    if (played.has(d)) { count++; continue }
    if (outage(d) || d === today) continue
    if (count > 0 && d - lastGrace >= 7) {
      lastGrace = d
      smoulder = true
      continue
    }
    count = 0
    smoulder = false
  }
  return { count, smoulder }
}

/**
 * `speaker(request)`: the signed-in account { id, profile } or null. `names(ids)`: account names (a
 * Map, null for none). `reward(accountId, day, base)`: credits the day's Embers once
 * (progression). `verifier`: { ids(), run(dailyId, input) } (daily-verifier.mjs).
 */
export function openDaily(file, { origin, embeds = [], speaker, names, reward, verifier, now = Date.now }) {
  if (typeof speaker !== 'function' || typeof names !== 'function' || typeof reward !== 'function' || !verifier) throw new Error('The daily needs sessions, names, rewards and a verifier')
  embedOrigins(embeds)
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file)
  try {
    if (file !== ':memory:') chmodSync(file, 0o600)
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
    db.exec(SCHEMA)
    const insert = db.prepare("INSERT INTO daily_attempt(id, day, daily_id, salt, account_id, device, ordinal, issued_at, status) VALUES (?,?,?,?,?,?,?,?,'open')")
    const get = db.prepare('SELECT * FROM daily_attempt WHERE id=?')
    const countFor = db.prepare('SELECT COUNT(*) AS n FROM daily_attempt WHERE day=? AND (account_id=? OR (account_id IS NULL AND ? IS NULL AND device=?))')
    const verifiedFor = db.prepare("SELECT * FROM daily_attempt WHERE day=? AND status='verified' AND hidden=0 AND (account_id=? OR (account_id IS NULL AND ? IS NULL AND device=?)) ORDER BY waves DESC, time_ticks, submitted_at")
    const firstFor = db.prepare('SELECT * FROM daily_attempt WHERE day=? AND (account_id=? OR (account_id IS NULL AND ? IS NULL AND device=?)) ORDER BY ordinal LIMIT 1')
    const settle = db.prepare("UPDATE daily_attempt SET status='verified', submitted_at=?, waves=?, time_ticks=?, bounty=?, end_tick=?, fight_ticks=?, casts=?, tape_hash=?, tape=?, flags=? WHERE id=? AND status='open'")
    const reject = db.prepare("UPDATE daily_attempt SET status='rejected', submitted_at=?, reason=?, tape_hash=? WHERE id=? AND status='open'")
    const expire = db.prepare("UPDATE daily_attempt SET status='expired' WHERE id=? AND status='open'")
    const claimRow = db.prepare('UPDATE daily_attempt SET account_id=?, claimed_at=? WHERE id=? AND account_id IS NULL')
    const verifiedDay = db.prepare("SELECT * FROM daily_attempt WHERE day=? AND status='verified' AND hidden=0 ORDER BY waves DESC, time_ticks, submitted_at")
    const firstDay = db.prepare('SELECT * FROM daily_attempt WHERE day=? AND ordinal=1 AND account_id IS NOT NULL AND hidden=0')
    const playedDays = db.prepare("SELECT DISTINCT day FROM daily_attempt WHERE status='verified' AND day>=? AND (account_id=? OR (account_id IS NULL AND ? IS NULL AND device=?))")
    const serviceDays = db.prepare('SELECT DISTINCT day FROM daily_attempt WHERE day>=?')
    const dropTapes = db.prepare('UPDATE daily_attempt SET tape=NULL WHERE day<? AND tape IS NOT NULL')
    const dropRows = db.prepare('DELETE FROM daily_attempt WHERE day<?')
    // Operations › Daily: flagged or hidden verified runs, and per-day numbers
    const reviewRows = db.prepare("SELECT id, day, account_id, device, ordinal, submitted_at, waves, time_ticks, bounty, casts, end_tick, flags, hidden FROM daily_attempt WHERE day>=? AND status='verified' AND (flags IS NOT NULL OR hidden=1) ORDER BY day DESC, submitted_at DESC LIMIT 200")
    const setHidden = db.prepare("UPDATE daily_attempt SET hidden=? WHERE id=? AND status='verified'")
    const dayPlayers = db.prepare("SELECT day, COALESCE(account_id, 'device:' || device) AS who, COUNT(*) AS attempts, MAX(CASE WHEN status='verified' THEN waves ELSE 0 END) AS best FROM daily_attempt WHERE day>=? GROUP BY day, who")
    const tokensByPlayer = new KeyedLimiter(1, 1 / 20)
    const tokensByIp = new KeyedLimiter(60, 60 / 3600)
    const reads = new KeyedLimiter(60, 1)
    let pruned = -1

    const closesAt = (day) => (day + 1) * DAY_MS + DAILY_CLOSE_MS
    const prune = (today) => {
      if (pruned === today) return
      pruned = today
      dropTapes.run(today - TAPE_DAYS)
      dropRows.run(today - ROW_DAYS)
    }
    /** (account, device) bindings for the prepared statements */
    const whoArgs = (who) => [who.account, who.account, who.device]
    const bestOf = (rows) => {
      const seen = new Set()
      const out = []
      for (const r of rows) {
        const k = r.account_id ?? `device:${r.device}`
        if (seen.has(k)) continue
        seen.add(k)
        out.push(r)
      }
      return out
    }
    const row = (r, name, rank) => ({ rank, name, waves: r.waves ?? 0, time: r.time_ticks ?? 0, attempt: r.id, build: r.daily_id })
    /** the day's board: accounts with a name, top 50, and the caller's own line (ranked among them) */
    function board(day, view, who) {
      const listed = (rows) => {
        const ids = [...new Set(rows.map((r) => r.account_id).filter(Boolean))]
        const known = names(ids)
        return rows.filter((r) => r.account_id && known.get(r.account_id)).map((r) => ({ r, name: known.get(r.account_id) }))
      }
      let entries
      if (view === 'first') {
        const firsts = firstDay.all(day).map((r) => (r.status === 'verified' ? r : { ...r, waves: 0, time_ticks: 0 }))
        firsts.sort((a, b) => b.waves - a.waves || a.time_ticks - b.time_ticks || a.issued_at - b.issued_at)
        entries = listed(firsts)
      } else entries = listed(bestOf(verifiedDay.all(day)))
      const all = bestOf(verifiedDay.all(day))
      const rows = entries.slice(0, BOARD_SIZE).map(({ r, name }, i) => row(r, name, i + 1))
      const mine = who ? (view === 'first' ? firstFor.get(day, ...whoArgs(who)) : verifiedFor.get(day, ...whoArgs(who))) : null
      let you = null
      if (mine && (view !== 'first' || mine.status === 'verified')) {
        const better = entries.filter(({ r }) => (r.waves ?? 0) > (mine.waves ?? 0) || ((r.waves ?? 0) === (mine.waves ?? 0) && (r.time_ticks ?? 0) < (mine.time_ticks ?? 0))).length
        you = row(mine, null, better + 1)
      }
      return { view, rows, you, players: all.length }
    }
    function youOf(day, who) {
      if (!who) return null
      const best = verifiedFor.get(day, ...whoArgs(who))
      const first = firstFor.get(day, ...whoArgs(who))
      const attempts = countFor.get(day, ...whoArgs(who)).n
      const played = new Set(playedDays.all(day - ROW_DAYS, ...whoArgs(who)).map((r) => r.day))
      const service = new Set(serviceDays.all(day - ROW_DAYS).map((r) => r.day))
      const streak = streakOf(played, (d) => !service.has(d), day)
      const next = (streak.count + (played.has(day) ? 0 : 1)) % 7 === 0 ? DAILY_STREAK_EMBERS : DAILY_EMBERS
      const week = Array.from({ length: 7 }, (_, i) => {
        const d = day - 6 + i
        const b = verifiedFor.get(d, ...whoArgs(who))
        return { day: d, waves: b ? b.waves : null }
      })
      return {
        best: best ? { waves: best.waves, time: best.time_ticks } : null,
        first: first ? { waves: first.status === 'verified' ? first.waves : 0, time: first.status === 'verified' ? first.time_ticks : 0 } : null,
        attempts, ranked: Math.max(0, DAILY_RANKED_ATTEMPTS - attempts),
        streak: { ...streak, nextReward: who.account ? next : 0 },
        week,
      }
    }
    async function identify(request, supplied, embedded) {
      const account = embedded ? null : await speaker(request)
      return { account: account?.profile ? account.id : null, device: supplied, signedIn: !!account }
    }

    async function summary(request, url, cors, embedded) {
      const today = dayOf(now())
      const day = url.searchParams.has('day') ? Number(url.searchParams.get('day')) : today
      const view = url.searchParams.get('view') ?? 'best'
      const supplied = url.searchParams.get('device')
      if (!Number.isSafeInteger(day) || (day !== today && day !== today - 1) || !['best', 'first'].includes(view) || (supplied !== null && !device(supplied))) {
        return json(400, { error: 'Invalid daily query.' }, cors)
      }
      const who = supplied ? await identify(request, supplied, embedded) : null
      const def = defineDay(day)
      return json(200, {
        day, number: def.number, name: def.name, serverNow: now(), nextDay: (today + 1) * DAY_MS, closesAt: closesAt(day),
        dailyIds: verifier.ids(), board: board(day, view, who), you: youOf(day, who),
      }, cors)
    }

    async function attempt(request, ip, cors, embedded) {
      const body = await readBody(request)
      if (!body || Object.keys(body).some((k) => !['day', 'dailyId', 'device'].includes(k)) || !device(body.device) || typeof body.dailyId !== 'string') return json(400, { error: 'Invalid attempt request.' }, cors)
      const at = now()
      const today = dayOf(at)
      if (body.day !== today) return json(409, { error: 'A new day has begun.', code: 'day', day: today }, cors)
      if (!verifier.ids().includes(body.dailyId)) return json(409, { error: 'Update the game to post scores.', code: 'update' }, cors)
      const who = await identify(request, body.device, embedded)
      const key = who.account ?? `device:${who.device}`
      tokensByPlayer.sweep(at); tokensByIp.sweep(at)
      if (!tokensByIp.take(ip, at) || !tokensByPlayer.take(key, at)) return json(429, { error: 'Wait a moment before the next attempt.', code: 'rate' }, cors)
      const used = countFor.get(today, ...whoArgs(who)).n
      if (used >= DAILY_RANKED_ATTEMPTS) return json(429, { error: 'Today’s ranked attempts are used up. Play on for practice.', code: 'cap' }, cors)
      prune(today)
      const id = randomBytes(16).toString('hex')
      const salt = randomBytes(4).readUInt32BE(0)
      insert.run(id, today, body.dailyId, salt, who.account, who.device, used + 1, at)
      return json(201, { attempt: id, salt, issuedAt: at, expiresAt: at + DAILY_TOKEN_MS, day: today }, cors)
    }

    async function submit(request, cors, embedded) {
      const body = await readBody(request, BODY_MAX)
      if (!body || Object.keys(body).some((k) => !['attempt', 'tape', 'claimed', 'device'].includes(k)) || !attemptId(body.attempt) || typeof body.tape !== 'string' || !device(body.device)) {
        return json(400, { error: 'Invalid submission.' }, cors)
      }
      const at = now()
      const r = get.get(body.attempt)
      if (!r) return json(404, { error: 'Unknown attempt.' }, cors)
      const who = await identify(request, body.device, embedded)
      if (r.device !== who.device || (r.account_id && r.account_id !== who.account)) return json(403, { error: 'This attempt belongs to someone else.' }, cors)
      let raw
      try {
        const gz = Buffer.from(body.tape, 'base64')
        if (gz.length > TAPE_GZ_MAX) return json(413, { error: 'The run is too large.' }, cors)
        raw = gunzipSync(gz, { maxOutputLength: TAPE_JSON_MAX })
      } catch { return json(422, { error: 'The run could not be read.', code: 'malformed' }, cors) }
      const tapeHash = createHash('sha256').update(raw).digest('hex')
      if (r.status === 'verified') {
        if (r.tape_hash !== tapeHash) return json(409, { error: 'A different run was already posted for this attempt.' }, cors)
        return json(200, result(r, who, null), cors)
      }
      if (r.status === 'rejected') return json(422, { error: 'This run could not be verified.', code: r.reason }, cors)
      if (at > closesAt(r.day)) return json(410, { error: 'That day’s board has closed.', code: 'closed' }, cors)
      if (r.status === 'expired' || at > r.issued_at + DAILY_TOKEN_MS) {
        expire.run(r.id)
        return json(410, { error: 'This attempt expired.', code: 'expired' }, cors)
      }
      let tape
      try { tape = JSON.parse(raw.toString('utf8')) } catch { reject.run(at, 'malformed', tapeHash, r.id); return json(422, { error: 'The run could not be read.', code: 'malformed' }, cors) }
      const simMs = (Number(tape?.end) / HZ) * 1000
      if (Number.isFinite(simMs) && at - r.issued_at < simMs - 2000) {
        reject.run(at, 'too fast', tapeHash, r.id)
        return json(422, { error: 'This run finished faster than real time.', code: 'too fast' }, cors)
      }
      let out
      try {
        out = await verifier.run(r.daily_id, { day: r.day, salt: r.salt, tape })
      } catch (error) {
        if (error instanceof VerifierBusy) return json(503, { error: 'Verification is busy. Trying again shortly.', code: 'busy' }, { ...cors, 'retry-after': '5' })
        return json(503, { error: 'The run could not be verified right now.', code: 'busy' }, { ...cors, 'retry-after': '10' })
      }
      if (out === null) return json(409, { error: 'This build cannot post scores any more.', code: 'update' }, cors)
      if (!out.ok) {
        reject.run(at, out.reason, tapeHash, r.id)
        return json(422, { error: 'This run could not be verified.', code: out.reason }, cors)
      }
      const flags = []
      const claimed = body.claimed
      if (claimed && (claimed.waves !== out.waves || claimed.time !== out.timeTicks)) flags.push('claim differs')
      if (out.endTick > 0 && out.commands / (out.endTick / HZ) > ORDERS_PER_SECOND_FLAG) flags.push('orders')
      if (at - r.issued_at > simMs + LATE_FLAG_MS) flags.push('late')
      settle.run(at, out.waves, out.timeTicks, out.bountyKos, out.endTick, out.fightTicks, out.casts, tapeHash, Buffer.from(body.tape, 'base64'), flags.length ? flags.join(',') : null, r.id)
      const settled = get.get(r.id)
      const paid = who.account ? payReward(who, settled) : null
      return json(200, result(settled, who, paid), cors)
    }

    /** the day's Embers, once per account, at its first verified attempt with real fighting (an idle or very short run earns nothing, and does not use the day up) */
    function payReward(who, r) {
      const qualifies = (x) => (x.fight_ticks ?? 0) >= REWARD_FIGHT_SECONDS * HZ && (x.casts ?? 0) >= REWARD_CASTS
      if (!qualifies(r)) return null
      if (verifiedFor.all(r.day, ...whoArgs(who)).some((x) => x.id !== r.id && qualifies(x))) return null
      const played = new Set(playedDays.all(r.day - ROW_DAYS, ...whoArgs(who)).map((x) => x.day))
      const service = new Set(serviceDays.all(r.day - ROW_DAYS).map((x) => x.day))
      const streak = streakOf(played, (d) => !service.has(d), r.day)
      const base = streak.count > 0 && streak.count % 7 === 0 ? DAILY_STREAK_EMBERS : DAILY_EMBERS
      const paid = reward(who.account, r.day, base)
      return paid.reward ? { embers: paid.reward.base, balance: paid.reward.balance, day: streak.count } : null
    }

    function result(r, who, paid) {
      const b = board(r.day, 'best', who)
      const played = new Set(playedDays.all(r.day - ROW_DAYS, ...whoArgs(who)).map((x) => x.day))
      const service = new Set(serviceDays.all(r.day - ROW_DAYS).map((x) => x.day))
      return {
        status: 'verified', waves: r.waves, time: r.time_ticks, bounty: r.bounty,
        rank: b.you?.rank ?? null, players: b.players, listed: !!who.account,
        best: b.you ? { waves: b.you.waves, time: b.you.time } : null,
        streak: streakOf(played, (d) => !service.has(d), r.day), reward: paid,
      }
    }

    async function claim(request, cors) {
      const body = await readBody(request)
      if (!body || Object.keys(body).some((k) => !['attempt', 'device'].includes(k)) || !attemptId(body.attempt) || !device(body.device)) return json(400, { error: 'Invalid claim.' }, cors)
      const account = await speaker(request)
      if (!account) return json(401, { error: 'Sign in to post this run.' }, cors)
      if (!account.profile) return json(403, { error: 'Choose your player name to post this run.' }, cors)
      const r = get.get(body.attempt)
      if (!r || r.device !== body.device || r.status !== 'verified') return json(404, { error: 'No run of yours to post.' }, cors)
      if (r.account_id) return json(r.account_id === account.id ? 200 : 409, r.account_id === account.id ? { claimed: true } : { error: 'This run is already posted.' }, cors)
      if (now() > closesAt(r.day)) return json(410, { error: 'That day’s board has closed.', code: 'closed' }, cors)
      claimRow.run(account.id, now(), r.id)
      const who = { account: account.id, device: body.device }
      const settled = get.get(r.id)
      const paid = payReward(who, settled)
      return json(200, { claimed: true, ...result(settled, who, paid) }, cors)
    }

    function run(url, cors) {
      const id = url.pathname.slice('/api/daily/run/'.length)
      if (!attemptId(id)) return json(400, { error: 'Invalid run.' }, cors)
      const r = get.get(id)
      const today = dayOf(now())
      if (!r || r.status !== 'verified' || r.hidden || !r.tape || (r.day !== today && r.day !== today - 1)) return json(404, { error: 'That run is not available.' }, cors)
      const top = bestOf(verifiedDay.all(r.day)).slice(0, 10).map((x) => x.id)
      if (!top.includes(r.id)) return json(404, { error: 'Only the top ten runs can be watched.' }, cors)
      return json(200, { day: r.day, dailyId: r.daily_id, salt: r.salt, tape: Buffer.from(r.tape).toString('base64') }, cors)
    }

    /** per day: players, attempts per player, finish share, and how many came back the next day / within a week */
    function numbers(today, days) {
      const byDay = new Map()
      for (const r of dayPlayers.all(today - days - 7)) {
        let d = byDay.get(r.day)
        if (!d) byDay.set(r.day, (d = new Map()))
        d.set(r.who, { attempts: r.attempts, best: r.best })
      }
      const waves = (day) => defineDay(day).waves.length
      const out = []
      for (let day = today; day > today - days; day--) {
        const players = byDay.get(day) ?? new Map()
        let attempts = 0, finishers = 0, back1 = 0, back7 = 0
        for (const [who, p] of players) {
          attempts += p.attempts
          if (p.best >= waves(day)) finishers++
          if (byDay.get(day + 1)?.has(who)) back1++
          for (let k = 1; k <= 7; k++) if (byDay.get(day + k)?.has(who)) { back7++; break }
        }
        const n = players.size
        out.push({ day, players: n, attemptsPerPlayer: n ? attempts / n : 0, finishShare: n ? finishers / n : 0,
          // a return can only be counted once its window has passed
          back1: day + 1 < today && n ? back1 / n : null, back7: day + 7 < today && n ? back7 / n : null })
      }
      return out
    }

    return {
      /** Operations › Daily; the caller has checked the operator. */
      async admin(request) {
        const today = dayOf(now())
        if (request.method === 'GET') {
          const rows = reviewRows.all(today - TAPE_DAYS)
          const named = names([...new Set(rows.flatMap((r) => (r.account_id ? [r.account_id] : [])))])
          return json(200, {
            today,
            runs: rows.map((r) => ({ attempt: r.id, day: r.day, name: (r.account_id && named.get(r.account_id)) || null, guest: !r.account_id, ordinal: r.ordinal, submittedAt: r.submitted_at,
              waves: r.waves, time: r.time_ticks, bounty: r.bounty, casts: r.casts, seconds: r.end_tick / HZ, flags: r.flags ? r.flags.split(',') : [], hidden: r.hidden === 1 })),
            days: numbers(today, 14),
          })
        }
        if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })
        if (!isJson(request)) return json(415, { error: 'Expected JSON.' })
        const body = await readBody(request)
        if (!body || !['hide', 'show'].includes(body.action) || !attemptId(body.attempt)) return json(400, { error: 'Choose hide or show for a run.' })
        if (!setHidden.run(body.action === 'hide' ? 1 : 0, body.attempt).changes) return json(404, { error: 'Run not found.' })
        return json(200, { ok: true })
      },

      async handler(request) {
        const url = new URL(request.url)
        const from = request.headers.get('origin')
        const embedded = !!from && from !== origin && embeds.includes(from)
        const cors = embedded ? embedCors(from) : {}
        if (embedded && request.method === 'OPTIONS') return new Response(null, { status: 204, headers: embedCors(from, true) })
        if (from && from !== origin && !embedded) return json(403, { error: 'Untrusted origin.' })
        const ip = request.headers.get('x-brawlock-client-ip')
        if (!ip) return json(400, { error: 'Missing trusted connection address.' }, cors)
        if (request.method === 'GET') {
          reads.sweep(now())
          if (!reads.take(ip, now())) return json(429, { error: 'The daily is busy. Try again shortly.' }, cors)
          if (url.pathname === '/api/daily') return summary(request, url, cors, embedded)
          if (url.pathname.startsWith('/api/daily/run/')) return run(url, cors)
          return json(404, { error: 'Not found.' }, cors)
        }
        if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' }, cors)
        if (!isJson(request)) return json(415, { error: 'Expected JSON.' }, cors)
        if (url.pathname === '/api/daily/attempt') return attempt(request, ip, cors, embedded)
        if (url.pathname === '/api/daily/submit') return submit(request, cors, embedded)
        if (url.pathname === '/api/daily/claim') {
          if (embedded) return json(403, { error: 'Post this run on brawlock.osc.link.' }, cors)
          return claim(request, cors)
        }
        return json(404, { error: 'Not found.' }, cors)
      },
      close: () => db.close(),
    }
  } catch (error) {
    db.close()
    throw error
  }
}

async function readBody(request, max = 2048) {
  const raw = await request.text()
  if (Buffer.byteLength(raw, 'utf8') > max) return undefined
  try {
    const body = JSON.parse(raw)
    return body && typeof body === 'object' && !Array.isArray(body) ? body : undefined
  } catch { return undefined }
}
