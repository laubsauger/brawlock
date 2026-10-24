import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { performance } from 'node:perf_hooks'

export const MONITOR_INTERVAL = 10_000
export const MONITOR_RETENTION_DAYS = 30
const RETENTION = MONITOR_RETENTION_DAYS * 86400_000
const metrics = ['hostCpu', 'processCpu', 'memory', 'loop', 'step', 'players', 'bots', 'rooms', 'ping', 'loss', 'online']
// Additive side table, so the schema stays 1 and the preceding release can still open this file.
const network = ['steal', 'anchor', 'poll']
const columns = [...metrics, ...network]
const HOUR = 3600_000
const finite = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null

/** Projection is deliberately bounded and contains no room/player identifiers. */
export function projectSample(sample) {
  return { hostCpu: finite(sample.hostCpuPeakPct), steal: finite(sample.stealPeakPct), anchor: finite(sample.anchorMs), processCpu: finite(sample.processCpuPeakPct), memory: finite(sample.perf?.rssMb),
    loop: finite(sample.loopPeakMs), step: finite(sample.stepPeakMs), players: finite(sample.players),
    bots: Array.isArray(sample.rooms) ? sample.rooms.reduce((sum, room) => sum + room.bots, 0) : null,
    rooms: Array.isArray(sample.rooms) ? sample.rooms.length : null,
    ping: finite(sample.links?.rttP95Ms), loss: finite(sample.links?.lossMaxPct), online: finite(sample.online?.total) }
}
export function openMonitoring(file) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file)
  try {
    chmodSync(file, 0o600)
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;')
    const version = db.prepare('PRAGMA user_version').get().user_version
    if (version === 0) db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE samples (at INTEGER NOT NULL, region TEXT NOT NULL, ok INTEGER NOT NULL, ${metrics.map((key) => `${key} REAL`).join(',')}, PRIMARY KEY(region,at));
      CREATE INDEX samples_at ON samples(at);
      CREATE TABLE latest (region TEXT PRIMARY KEY, payload TEXT NOT NULL);
      PRAGMA user_version=1; COMMIT;`)
    else if (version !== 1) throw new Error('Unsupported monitoring database version')
    db.exec(`CREATE TABLE IF NOT EXISTS network (at INTEGER NOT NULL, region TEXT NOT NULL, ${network.map((key) => `${key} REAL`).join(',')}, PRIMARY KEY(region,at))`)
    db.exec('CREATE INDEX IF NOT EXISTS network_at ON network(at)')
    // Month views read at most 30 × 24 rows per service instead of 259,200 raw
    // samples. Additive tables preserve compatibility with the preceding binary.
    db.exec(`CREATE TABLE IF NOT EXISTS hourly (at INTEGER NOT NULL, region TEXT NOT NULL, samples INTEGER NOT NULL, failures INTEGER NOT NULL,
      ${columns.map(key => `${key} REAL`).join(',')}, PRIMARY KEY(region,at));
      CREATE INDEX IF NOT EXISTS hourly_at ON hourly(at);`)
    const foldSql = `SELECT CAST(s.at/${HOUR} AS INTEGER)*${HOUR} AS at,s.region AS region,COUNT(*) AS samples,SUM(1-s.ok) AS failures,
      ${[...metrics.map(key => `MAX(s.${key}) AS ${key}`), ...network.map(key => `MAX(n.${key}) AS ${key}`)].join(',')}
      FROM samples s LEFT JOIN network n ON n.region=s.region AND n.at=s.at`
    const replaceHour = db.prepare(`INSERT OR REPLACE INTO hourly ${foldSql}
      WHERE s.region=? AND s.at>=? AND s.at<? GROUP BY s.region,CAST(s.at/${HOUR} AS INTEGER)`)
    // One startup backfill also accounts for samples written during a rollback.
    db.exec(`INSERT OR REPLACE INTO hourly ${foldSql} GROUP BY s.region,CAST(s.at/${HOUR} AS INTEGER)`)
    const insert = db.prepare(`INSERT OR REPLACE INTO samples VALUES (?,?,?,${metrics.map(() => '?').join(',')})`)
    const insertNetwork = db.prepare(`INSERT OR REPLACE INTO network VALUES (?,?,${network.map(() => '?').join(',')})`)
    const latest = db.prepare('INSERT OR REPLACE INTO latest VALUES (?,?)')
    const prune = db.prepare('DELETE FROM samples WHERE at<?')
    const pruneNetwork = db.prepare('DELETE FROM network WHERE at<?')
    const pruneHourly = db.prepare('DELETE FROM hourly WHERE at<?')
    const history = db.prepare(`SELECT s.region AS region,CAST(s.at/? AS INTEGER)*? AS at,COUNT(*) AS samples,SUM(1-s.ok) AS failures,
      ${[...metrics.map((key) => `MAX(s.${key}) AS ${key}`), ...network.map((key) => `MAX(n.${key}) AS ${key}`)].join(',')}
      FROM samples s LEFT JOIN network n ON n.region=s.region AND n.at=s.at
      WHERE s.at>=? AND s.at<=? GROUP BY s.region,CAST(s.at/? AS INTEGER) ORDER BY 2,1`)
    const edgeSql = `${foldSql} WHERE s.at>=? AND s.at<=? GROUP BY s.region,CAST(s.at/${HOUR} AS INTEGER)`
    const monthHistory = db.prepare(`SELECT region,CAST(at/? AS INTEGER)*? AS at,SUM(samples) AS samples,SUM(failures) AS failures,
      ${columns.map(key => `MAX(${key}) AS ${key}`).join(',')}
      FROM (SELECT * FROM hourly WHERE at>=? AND at<? UNION ALL ${edgeSql} UNION ALL ${edgeSql})
      GROUP BY region,CAST(at/? AS INTEGER) ORDER BY 2,1`)
    const cache = new Map()
    return {
      record(region, at, status) {
        db.exec('BEGIN IMMEDIATE')
        try {
          const projected = { ...(status.ok ? projectSample(status.sample) : {}), poll: finite(status.pollMs) }
          insert.run(at, region, status.ok ? 1 : 0, ...metrics.map((key) => projected[key] ?? null))
          insertNetwork.run(at, region, ...network.map((key) => projected[key] ?? null))
          const hour = Math.floor(at / HOUR) * HOUR
          replaceHour.run(region, hour, hour + HOUR)
          latest.run(region, JSON.stringify({ ...status, at }))
          prune.run(at - RETENTION)
          pruneNetwork.run(at - RETENTION)
          pruneHourly.run(at - RETENTION)
          db.exec('COMMIT')
          cache.clear()
        } catch (error) { db.exec('ROLLBACK'); throw error }
      },
      read(hours, now) {
        if (cache.has(hours)) return cache.get(hours)
        const grain = Math.max(MONITOR_INTERVAL, Math.ceil(hours * 3600 / 360) * 1000)
        const from = now - hours * 3600_000
        const fullFrom = Math.ceil(from / HOUR) * HOUR, fullThrough = Math.floor(now / HOUR) * HOUR
        const result = { grain, from, through: now,
          latest: Object.fromEntries(db.prepare('SELECT region,payload FROM latest').all().map((row) => [row.region, JSON.parse(row.payload)])),
          history: hours > 168
            ? monthHistory.all(grain, grain, fullFrom, fullThrough, from, Math.min(now, fullFrom - 1), Math.max(fullFrom, fullThrough), now, grain)
            : history.all(grain, grain, from, now, grain) }
        cache.set(hours, result)
        return result
      },
      close() { db.close() },
    }
  } catch (error) { db.close(); throw error }
}

/** Fixed trusted destinations; redirects are never followed with the regional secret. */
export async function fetchMonitoring(region, token, { fetcher = fetch, reportDays, signal } = {}) {
  const url = new URL('/internal/monitoring', region.origin)
  if (url.protocol !== 'https:') throw new Error('Monitoring requires HTTPS regional origins')
  if (reportDays !== undefined) url.searchParams.set('reportDays', String(reportDays))
  const response = await fetcher(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`Regional monitoring HTTP ${response.status}`)
  if (Number(response.headers.get('content-length')) > 8 * 1024 * 1024) throw new Error('Monitoring response exceeds limit')
  // Bound chunked responses as well as responses with Content-Length.
  const reader = response.body.getReader(), chunks = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 8 * 1024 * 1024) throw new Error('Monitoring response exceeds limit')
      chunks.push(Buffer.from(value))
    }
  } finally { await reader.cancel() }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (reportDays === undefined && (body.version !== 1 || body.region !== region.id || !Array.isArray(body.rooms)
    || body.rooms.length > 1000 || !body.release || !Number.isFinite(body.at))) throw new Error('Incompatible regional monitoring payload')
  return body
}

/** Collection continues with no dashboard viewers. One in-flight poll, bounded storage. */
export function startMonitoring({ store, regions, token, localSample, appOrigin, fetcher = fetch, now = Date.now, interval = MONITOR_INTERVAL, onError = () => console.error('Fleet monitoring collection failed.') }) {
  if (!token || token.length < 32) throw new Error('Monitoring requires the shared regional credential')
  let inFlight = null, stopped = false, website = null, webAt = -Infinity
  const controller = new AbortController()
  const poll = () => {
    if (stopped || inFlight) return inFlight
    inFlight = (async () => {
      await Promise.all(regions.map(async (region) => {
        let status
        const begin = performance.now()
        // The poll's duration is this host's view of the region: network plus the region's own loop.
        try { status = { ok: true, sample: await fetchMonitoring(region, token, { fetcher, signal: controller.signal }), pollMs: performance.now() - begin } }
        catch (error) { status = { ok: false, error: error instanceof Error && /^Regional monitoring HTTP \d+$/.test(error.message) ? error.message : 'Monitoring unavailable' } }
        if (!stopped) store.record(region.id, now(), status)
      }))
      if (!stopped) store.record('accounts', now(), { ok: true, sample: localSample() })
      if (!stopped && now() - webAt >= 60_000) {
        webAt = now()
        try {
          const response = await fetcher(new URL('/version.json', appOrigin), { cache: 'no-store', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) })
          if (!response.ok) throw new Error('App version unavailable')
          const value = await response.json()
          if (typeof value.build !== 'string' || typeof value.version !== 'string' || typeof value.releaseDate !== 'string') throw new Error('Invalid app version')
          website = { ok: true, at: now(), build: value.build, version: value.version, releaseDate: value.releaseDate }
        } catch { website = { ok: false, at: now() } }
      }
    })().catch(onError).finally(() => { inFlight = null })
    return inFlight
  }
  const timer = setInterval(poll, interval); timer.unref(); void poll()
  return { poll, website: () => website, async close() { stopped = true; clearInterval(timer); controller.abort(); await inFlight } }
}
