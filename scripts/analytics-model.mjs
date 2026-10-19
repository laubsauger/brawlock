/** Exact cross-filtering over private report-scoped tokens. No database IDs. This
 * function is also inlined into the offline HTML, so it has no external helpers. */
export function createAnalyticsExplorer(reports) {
  const DAY = 86400000, accounts = reports.find((r) => r.source === 'accounts'), regions = reports.filter((r) => r.source !== 'accounts')
  const date = (at) => new Date(at).toISOString().slice(0, 10), stamp = (day) => Date.parse(day + 'T00:00:00Z')
  const traffic = accounts.facts.traffic.map((r) => ({ ...r, firstDay: date(r.firstAt) }))
  const browsers = accounts.facts.browsers.map((r) => ({ ...r, conversionDay: r.convertedAt == null ? null : date(r.convertedAt) }))
  const conversionsByBrowser = [...new Map(browsers.filter((r) => r.conversionDay != null).map((r) => [r.browser, r])).values()]
  const samples = accounts.facts.samples.map((r) => ({ ...r, day: date(r.at) }))
  const matches = regions.flatMap((r) => r.facts.matches.map((m) => ({ ...m, source: r.source, day: date(m.started_at) })))
  const all = '*', equal = (value, filter) => filter === all || String(value ?? '') === filter
  const sum = (rows, field) => rows.reduce((n, r) => n + r[field], 0)
  const distinct = (rows, field) => new Set(rows.map((r) => r[field]).filter((v) => v != null)).size
  const defaults = { region: all, clientBuild: all, clientNet: all, screen: all, identity: all,
    serverBuild: all, commit: all, queue: all, mode: all, team: all, outcome: all, playerKind: all }
  const option = (rows, field) => [...new Set(rows.map((r) => String(r[field] ?? '')))].sort()
  const options = {
    region: [...new Set([...option(traffic, 'region'), ...option(matches, 'region')])].sort(),
    clientBuild: option(traffic, 'build'), clientNet: option(traffic, 'net'), screen: option(traffic, 'screen'), identity: ['guest', 'account'],
    serverBuild: option(matches, 'build'), commit: option(matches, 'commit_id'), queue: option(matches, 'queue'),
    mode: option(matches, 'game_mode'), team: option(matches, 'team_mode'), outcome: option(matches, 'status'), playerKind: ['guest', 'account'],
  }
  const quality = (since, from, through) => since <= stamp(from) ? 'complete' : since >= stamp(through) + DAY ? 'none' : 'partial'
  function query(input) {
    const filters = { ...defaults, ...input.filters }, from = input.from, through = input.through
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(through)
      || !Number.isFinite(stamp(from)) || date(stamp(from)) !== from || date(stamp(through)) !== through
      || from < accounts.from || through > accounts.through || from > through) throw new Error('Select valid dates inside the exported window')
    for (const [key, value] of Object.entries(filters)) if (!(key in defaults) || (value !== all && !options[key].includes(value))) throw new Error('Unknown analytics filter: ' + key)
    const days = Math.round((stamp(through) - stamp(from)) / DAY) + 1
    const previousFrom = date(stamp(from) - days * DAY), previousThrough = date(stamp(from) - DAY)
    const trafficMatch = (row) => equal(row.region, filters.region) && equal(row.build, filters.clientBuild)
      && equal(row.net, filters.clientNet) && equal(row.screen, filters.screen) && equal(row.kind, filters.identity)
    const selectedTraffic = traffic.filter(trafficMatch)
    const selectedMatches = matches.filter((row) => equal(row.region, filters.region) && equal(row.build, filters.serverBuild)
      && equal(row.commit_id, filters.commit) && equal(row.queue, filters.queue) && equal(row.game_mode, filters.mode)
      && equal(row.team_mode, filters.team) && equal(row.status, filters.outcome)
      && (filters.playerKind === all || row.players.some((p) => p.kind === filters.playerKind)))
    const within = (day, first, last) => day >= first && day <= last
    const rawTraffic = (first, last) => selectedTraffic.filter((r) => within(r.day, first, last))
    const rawGames = (first, last) => selectedMatches.filter((r) => within(r.day, first, last))
    const unfilteredTraffic = ['region', 'clientBuild', 'clientNet', 'screen', 'identity'].every((key) => filters[key] === all)
    const contextTraffic = ['clientBuild', 'clientNet', 'screen'].some((key) => filters[key] !== all)
    const contextGames = filters.serverBuild !== all || filters.commit !== all
    const trafficSince = contextTraffic ? accounts.dimensionTrackingSince : accounts.trackingSince
    const selectedSources = regions.filter((r) => filters.region === all || r.source === filters.region)
    const gameSince = Math.max(...selectedSources.map((r) => contextGames ? r.dimensionTrackingSince : r.trackingSince))
    function trafficStats(rows, first, last, total = true) {
      const guest = rows.filter((r) => r.kind === 'guest'), account = rows.filter((r) => r.kind === 'account')
      const newRows = (data) => data.filter((r) => within(r.firstDay, first, last))
      const browserRows = total && unfilteredTraffic ? browsers.filter((r) => within(r.day, first, last)) : []
      const conversionSupported = total && filters.identity === all && filters.screen === all && filters.clientNet === all
      const conversions = conversionSupported ? conversionsByBrowser.filter((r) => within(r.conversionDay, first, last)
        && equal(r.convertedRegion, filters.region) && equal(r.convertedBuild, filters.clientBuild)) : []
      let peak = null
      if (!total) { peak = null }
      else if (unfilteredTraffic) {
        const peaks = accounts.facts.peaks.filter((p) => within(p.day, first, last))
        if (peaks.length) peak = Math.max(...peaks.map((p) => p.online))
      } else {
        // Sum simultaneous segments first, then take the peak. Never add peaks.
        const sampled = samples.filter((r) => within(r.day, first, last))
        const counts = new Map(sampled.map((r) => [r.at, 0]))
        for (const row of sampled.filter(trafficMatch)) counts.set(row.at, counts.get(row.at) + row.people)
        if (counts.size) peak = Math.max(...counts.values())
      }
      return { guests: distinct(guest, 'person'), accounts: distinct(account, 'person'), newGuests: distinct(newRows(guest), 'person'), newAccounts: distinct(newRows(account), 'person'),
        browsers: total && unfilteredTraffic ? distinct(browserRows, 'browser') : distinct(rows, 'browser'),
        conversions: total && conversionSupported ? distinct(conversions, 'browser') : null,
        visits: sum(rows, 'sessions'), minutes: sum(rows, 'active_ms') / 60000, peak }
    }
    function gameStats(rows) {
      const completed = rows.filter((r) => r.status === 'completed'), resolved = rows.filter((r) => r.status !== 'running')
      const players = rows.flatMap((r) => r.players)
      const count = (status) => rows.filter((r) => r.status === status).length
      return { started: rows.length, completed: completed.length, abandoned: count('abandoned'), interrupted: count('interrupted'), running: count('running'),
        completedSeconds: sum(completed, 'seconds'), completedRounds: sum(completed, 'rounds'), botSeats: sum(rows, 'bots'), participations: players.length,
        guestSeats: players.filter((p) => p.kind === 'guest').length, accountSeats: players.filter((p) => p.kind === 'account').length,
        averageMinutes: completed.length ? sum(completed, 'seconds') / completed.length / 60 : null,
        completionRate: resolved.length ? completed.length / resolved.length * 100 : null,
        abandonmentRate: resolved.length ? count('abandoned') / resolved.length * 100 : null }
    }
    const summarize = (first, last) => ({ ...trafficStats(rawTraffic(first, last), first, last), ...gameStats(rawGames(first, last)), from: first, through: last,
      coverage: quality(trafficSince, first, last), gameCoverage: quality(gameSince, first, last) })
    const current = summarize(from, through), previous = summarize(previousFrom, previousThrough)
    function buckets(grain) {
      const start = stamp(from), first = grain === 'weekly' ? start - ((new Date(start).getUTCDay() + 6) % 7) * DAY : start
      const rows = []
      for (let at = first; at <= stamp(through); at += (grain === 'weekly' ? 7 : 1) * DAY) {
        const begin = date(Math.max(start, at)), end = date(Math.min(stamp(through), at + (grain === 'weekly' ? 6 : 0) * DAY))
        rows.push({ ...summarize(begin, end), period: date(at) })
      }
      return rows
    }
    const visibleTraffic = rawTraffic(from, through), visibleMatches = rawGames(from, through)
    function breakdown(rows, field, stats) {
      return option(rows, field).map((value) => ({ value, ...stats(rows.filter((r) => String(r[field] ?? '') === value)) }))
    }
    const trafficBreakdown = (field) => breakdown(visibleTraffic, field, (rows) => trafficStats(rows, from, through, false)).sort((a, b) => b.visits - a.visits || b.guests + b.accounts - a.guests - a.accounts)
    const gameBreakdown = (field) => breakdown(visibleMatches, field, gameStats).sort((a, b) => b.started - a.started)
    const regionRows = [...new Set([...option(visibleTraffic, 'region'), ...option(visibleMatches, 'region')])].map((region) => ({ value: region,
      ...trafficStats(visibleTraffic.filter((r) => r.region === region), from, through, false), ...gameStats(visibleMatches.filter((r) => r.region === region)) })).sort((a, b) => b.started - a.started || b.visits - a.visits)
    return { from, through, days, previousFrom, previousThrough, filters, current, previous, daily: buckets('daily'), weekly: buckets('weekly'),
      peakBasis: unfilteredTraffic ? 'observed' : 'sampled',
      breakdowns: { regions: regionRows, clientBuilds: trafficBreakdown('build'), clientNets: trafficBreakdown('net'), screens: trafficBreakdown('screen'), identities: trafficBreakdown('kind'),
        serverBuilds: gameBreakdown('build'), commits: gameBreakdown('commit_id'), queues: gameBreakdown('queue'), modes: gameBreakdown('game_mode'), teams: gameBreakdown('team_mode'), outcomes: gameBreakdown('status') },
      matches: visibleMatches.map(({ players, ...row }) => ({ ...row, humans: players.length, guests: players.filter((p) => p.kind === 'guest').length, accounts: players.filter((p) => p.kind === 'account').length })),
      browserCoverage: unfilteredTraffic ? quality(accounts.identityTrackingSince, from, through) : quality(accounts.dimensionTrackingSince, from, through) }
  }
  return { options, defaults, from: accounts.from, through: accounts.through, query }
}
