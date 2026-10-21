import { randomBytes } from 'node:crypto'

/** Private, bounded export for exact interactive filtering. Tokens are random to
 * this report; neither raw IDs nor persisted HMACs leave the database. */
export function analyticsFacts(db, { at, days }) {
  const through = new Date(at).toISOString().slice(0, 10)
  const end = Date.parse(through + 'T00:00:00Z')
  const start = end - (2 * days - 1) * 86400000
  const from = new Date(start).toISOString().slice(0, 10)
  const keys = new Map()
  const token = (id) => {
    if (!id) return null
    if (!keys.has(id)) keys.set(id, randomBytes(9).toString('base64url'))
    return keys.get(id)
  }
  const traffic = db.prepare(`SELECT a.*,v.kind,v.first_at AS firstAt FROM traffic_facts a
    JOIN visitors v ON v.person=a.person WHERE a.day>=? AND a.day<=? ORDER BY a.day,a.rowid`).all(from, through)
    .map(({ person, device, ...row }) => ({ ...row, person: token(person), browser: token(device) }))
  const browsers = db.prepare(`SELECT a.day,b.device,b.first_at AS firstAt,b.converted_at AS convertedAt,
    b.converted_region AS convertedRegion,b.converted_build AS convertedBuild
    FROM browser_activity a JOIN browsers b ON b.device=a.device WHERE a.day>=? AND a.day<=?`).all(from, through)
    .map(({ device, ...row }) => ({ ...row, browser: token(device) }))
  const seats = db.prepare(`SELECT p.* FROM participants p JOIN matches m ON m.id=p.match_id WHERE m.started_at>=? AND m.started_at<=?`).all(start, at)
  const byMatch = new Map()
  for (const seat of seats) {
    if (!byMatch.has(seat.match_id)) byMatch.set(seat.match_id, [])
    byMatch.get(seat.match_id).push({ person: token(seat.person), kind: seat.kind })
  }
  const matches = db.prepare('SELECT * FROM matches WHERE started_at>=? AND started_at<=? ORDER BY started_at DESC').all(start, at)
    .map(({ id, settings, ...row }) => ({ ...row, id, settings: settings ? JSON.parse(settings) : null, players: byMatch.get(id) ?? [] }))
  const sampleRows = db.prepare(`SELECT s.at,c.region,c.build,c.net,c.screen,c.kind,c.people FROM presence_samples s
    JOIN presence_sample_counts c ON c.sample=s.id WHERE s.at>=? AND s.at<=? ORDER BY s.at`).all(start, at)
  // Charts filter whole UTC dates. Identical segment vectors on the same date
  // have exactly the same filtered peaks, so export just one copy of each vector.
  const bySample = new Map(), vectors = new Set(), samples = []
  for (const row of sampleRows) {
    if (!bySample.has(row.at)) bySample.set(row.at, [])
    bySample.get(row.at).push(row)
  }
  for (const [sampleAt, rows] of bySample) {
    const vector = new Date(sampleAt).toISOString().slice(0, 10) + JSON.stringify(rows.map(({ at: _, ...row }) => JSON.stringify(row)).sort())
    if (!vectors.has(vector)) { vectors.add(vector); samples.push(...rows) }
  }
  const peaks = db.prepare('SELECT day,online FROM peaks WHERE day>=? AND day<=?').all(from, through)
  return { from, through, traffic, browsers, matches, samples, peaks }
}
