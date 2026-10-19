const DAY = 86400000
const iso = (at) => new Date(at).toISOString().slice(0, 10)
const stamp = (day) => Date.parse(day + 'T00:00:00Z')
const monday = (day) => {
  const at = stamp(day)
  return iso(at - ((new Date(at).getUTCDay() + 6) % 7) * DAY)
}
const empty = () => ({ guests: 0, accounts: 0, newGuests: 0, newAccounts: 0, visits: 0, minutes: 0, peak: 0,
  started: 0, completed: 0, abandoned: 0, interrupted: 0, running: 0, completedSeconds: 0, completedRounds: 0 })

/** Aggregate identities in SQLite at the requested grain. Never sum daily uniques. */
export function analyticsSeries(db, { at, days, trackingSince }) {
  const coverage = (from, through) => trackingSince <= stamp(from) ? 'complete' : trackingSince >= stamp(through) + DAY ? 'none' : 'partial'
  function buckets(from, through, grain) {
    const period = (column) => grain === 'week' ? `date(${column},'weekday 0','-6 days')` : column
    const traffic = db.prepare(`SELECT ${period('a.day')} AS period,v.kind,COUNT(DISTINCT a.person) AS seen,
      COUNT(DISTINCT CASE WHEN date(v.first_at/1000,'unixepoch')>=? AND date(v.first_at/1000,'unixepoch')<=?
        AND ${period("date(v.first_at/1000,'unixepoch')")}=${period('a.day')} THEN a.person END) AS new,
      SUM(a.sessions) AS visits,SUM(a.active_ms)/60000.0 AS minutes
      FROM activity a JOIN visitors v ON v.person=a.person WHERE a.day>=? AND a.day<=? GROUP BY period,v.kind`).all(from, through, from, through)
    const games = db.prepare(`SELECT ${period("date(started_at/1000,'unixepoch')")} AS period,COUNT(*) AS started,
      SUM(status='completed') AS completed,SUM(status='abandoned') AS abandoned,SUM(status='interrupted') AS interrupted,SUM(status='running') AS running,
      SUM(CASE WHEN status='completed' THEN seconds ELSE 0 END) AS completedSeconds,
      SUM(CASE WHEN status='completed' THEN rounds ELSE 0 END) AS completedRounds
      FROM matches WHERE started_at>=? AND started_at<? GROUP BY period`).all(stamp(from), Math.min(stamp(through) + DAY, at + 1))
    const peaks = db.prepare(`SELECT ${period('day')} AS period,MAX(online) AS peak FROM peaks WHERE day>=? AND day<=? GROUP BY period`).all(from, through)
    const rows = []
    for (let t = stamp(grain === 'week' ? monday(from) : from); t <= stamp(through); t += (grain === 'week' ? 7 : 1) * DAY) {
      const period = iso(t), first = iso(Math.max(t, stamp(from))), last = iso(Math.min(t + (grain === 'week' ? 6 : 0) * DAY, stamp(through)))
      const row = { ...empty(), period, from: first, through: last, coverage: coverage(first, last) }
      for (const trafficRow of traffic.filter((r) => r.period === period)) {
        const account = trafficRow.kind === 'account'
        row[account ? 'accounts' : 'guests'] = trafficRow.seen
        row[account ? 'newAccounts' : 'newGuests'] = trafficRow.new
        row.visits += trafficRow.visits; row.minutes += trafficRow.minutes
      }
      const game = games.find((r) => r.period === period)
      if (game) { const { period: _, ...counts } = game; Object.assign(row, counts) }
      row.peak = peaks.find((r) => r.period === period)?.peak ?? 0
      rows.push(row)
    }
    return rows
  }
  function summary(from, through) {
    const rows = buckets(from, through, 'day'), result = { ...empty(), from, through, coverage: coverage(from, through) }
    const unique = db.prepare(`SELECT v.kind,COUNT(DISTINCT a.person) AS seen,
      COUNT(DISTINCT CASE WHEN v.first_at>=? AND v.first_at<? THEN a.person END) AS new
      FROM activity a JOIN visitors v ON v.person=a.person WHERE a.day>=? AND a.day<=? GROUP BY v.kind`).all(stamp(from), stamp(through) + DAY, from, through)
    for (const row of rows) {
      for (const field of ['visits', 'minutes', 'started', 'completed', 'abandoned', 'interrupted', 'running', 'completedSeconds', 'completedRounds']) result[field] += row[field]
      result.peak = Math.max(result.peak, row.peak)
    }
    for (const row of unique) { result[row.kind === 'account' ? 'accounts' : 'guests'] = row.seen; result[row.kind === 'account' ? 'newAccounts' : 'newGuests'] = row.new }
    return result
  }
  return [...new Set([1, 7, 30, 90, days])].filter((n) => n <= days).sort((a, b) => a - b).map((size) => {
    const through = iso(at), from = iso(stamp(through) - (size - 1) * DAY)
    const previousFrom = iso(stamp(from) - size * DAY), previousThrough = iso(stamp(from) - DAY)
    return { days: size, current: summary(from, through), previous: summary(previousFrom, previousThrough), daily: buckets(from, through, 'day'), weekly: buckets(from, through, 'week') }
  })
}
