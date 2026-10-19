/** Inlined into the standalone report; all chart data is already aggregated. */
export function mountAnalyticsCharts(reports, createExplorer) {
  const accounts = reports.find((r) => r.source === 'accounts'), regions = reports.filter((r) => r.source !== 'accounts')
  const explorer = createExplorer(reports), filters = { ...explorer.defaults }
  const DAY = 86400000, iso = (at) => new Date(at).toISOString().slice(0, 10)
  let selected = Math.min(30, accounts.days), grain = 'daily', from, through = accounts.through, view, page = 0, sort = 'started_at', direction = -1, chartWidth = 0
  const number = (n) => n == null ? '—' : new Intl.NumberFormat('en').format(Math.round(n))
  const label = (value) => value === '' || value == null ? 'Unrecorded' : value === 'us-west' ? 'US West' : value === 'eu' ? 'Europe' : value
  const ranges = document.querySelector('#ranges'), groups = document.querySelector('#grouping')
  function button(text, value, parent, action) {
    const node = document.createElement('button'); node.type = 'button'; node.textContent = text; node.dataset.value = value
    node.addEventListener('click', action); parent.append(node)
  }
  const setDates = (days) => { through = accounts.through; from = iso(Date.parse(through + 'T00:00:00Z') - (days - 1) * DAY) }
  setDates(selected)
  for (const days of [...new Set([1, 7, 30, 90, accounts.days])].filter((n) => n <= accounts.days).sort((a, b) => a - b)) button(days === 1 ? 'Today' : `${days} days`, days, ranges, () => { selected = days; setDates(days); page = 0; render() })
  for (const [value, label] of [['daily', 'Daily'], ['weekly', 'Weekly']]) button(label, value, groups, () => { grain = value; render() })
  for (const node of document.querySelectorAll('[data-filter]')) {
    const key = node.dataset.filter
    for (const value of ['*', ...explorer.options[key]]) {
      const option = document.createElement('option'); option.value = value; option.textContent = value === '*' ? 'All' : label(value); node.append(option)
    }
    node.addEventListener('change', () => { filters[key] = node.value; page = 0; render() })
  }
  for (const id of ['date-from', 'date-through']) { const node = document.querySelector('#' + id); node.min = explorer.from; node.max = explorer.through }
  document.querySelector('#apply-dates').addEventListener('click', () => {
    const nextFrom = document.querySelector('#date-from').value, nextThrough = document.querySelector('#date-through').value
    try { explorer.query({ from: nextFrom, through: nextThrough, filters }) } catch (error) { document.querySelector('#filter-error').textContent = error.message; return }
    from = nextFrom; through = nextThrough; selected = null; page = 0; render()
  })
  document.querySelector('#reset-filters').addEventListener('click', () => { Object.assign(filters, explorer.defaults); for (const node of document.querySelectorAll('[data-filter]')) node.value = '*'; page = 0; render() })
  for (const tab of document.querySelectorAll('[data-tab]')) tab.addEventListener('click', () => {
    for (const node of document.querySelectorAll('[data-tab]')) node.setAttribute('aria-selected', String(node === tab))
    for (const node of document.querySelectorAll('[data-panel]')) node.hidden = node.dataset.panel !== tab.dataset.tab
    chartWidth = document.querySelector('#chart-panels').clientWidth
    if (tab.dataset.tab === 'overview') render()
  })
  function download(name, content, mime) {
    const url = URL.createObjectURL(new Blob([content], { type: mime })), anchor = document.createElement('a')
    anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  document.querySelector('#export-json').addEventListener('click', () => download(`brawlock-analytics-${from}-${through}.json`, JSON.stringify({ generatedAt: accounts.generatedAt, demo: document.body.dataset.demo === 'true', ...view }, null, 2), 'application/json'))
  document.querySelector('#export-csv').addEventListener('click', () => {
    const fields = ['id', 'room', 'started_at', 'region', 'build', 'commit_id', 'queue', 'game_mode', 'team_mode', 'status', 'seconds', 'rounds', 'humans', 'guests', 'accounts', 'bots']
    const cell = (value) => { const text = String(value ?? ''); return '"' + (/^[=+\-@\t\r]/.test(text) ? "'" : '') + text.replaceAll('"', '""') + '"' }
    download(`brawlock-matches-${from}-${through}.csv`, [fields, ...view.matches.map((row) => fields.map((field) => field === 'started_at' ? new Date(row[field]).toISOString() : row[field]))].map((row) => row.map(cell).join(',')).join('\r\n'), 'text/csv')
  })
  const sum = (rows, field) => rows.reduce((n, r) => n + r[field], 0)
  const svgNode = (name, attrs, text) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', name)
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
    if (text !== undefined) node.textContent = text
    return node
  }
  function trend(current, previous, field, quality) {
    if (quality !== 'complete') return { text: 'Earlier history incomplete', css: 'muted' }
    if (!previous[field]) return { text: current[field] ? 'New activity · previous period was zero' : 'No change · both periods zero', css: current[field] ? 'up' : 'muted' }
    const change = (current[field] - previous[field]) / previous[field] * 100
    return { text: `${change > 0 ? '↑ +' : change < 0 ? '↓ ' : ''}${change.toFixed(1)}% vs previous ${view.days === 1 ? 'day' : view.days + ' days'}`, css: change > 0 ? 'up' : change < 0 ? 'down' : 'muted' }
  }
  function metric(label, field, current, previous, quality, detail) {
    const article = document.createElement('article'); article.className = 'metric'
    for (const [tag, text] of [['span', label], ['strong', number(current[field])], ['small', detail]]) {
      const node = document.createElement(tag); node.textContent = text; article.append(node)
    }
    const comparison = trend(current, previous, field, quality), delta = document.createElement('p')
    delta.className = `delta ${comparison.css}`; delta.textContent = comparison.text; article.append(delta)
    return article
  }
  function chart(id, rows, lines, stacked, title) {
    const host = document.querySelector('#' + id); host.replaceChildren()
    const width = Math.max(300, host.clientWidth), height = 280, left = 42, right = width - 16, top = 24, bottom = 238
    const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'group', 'aria-label': title })
    const tooltip = document.createElement('div'); tooltip.className = 'chart-tooltip'; tooltip.hidden = true
    const recorded = rows.some((r) => r.coverage !== 'none')
    const max = Math.max(0, ...rows.map((r) => stacked ? sum(lines.map((l) => ({ value: r[l.field] })), 'value') : Math.max(...lines.map((l) => r[l.field]))))
    const ceiling = Math.max(4, Math.ceil(max / 4) * 4), plotWidth = right - left
    const x = (i) => left + plotWidth * (i + 0.5) / rows.length
    const y = (value) => bottom - value / ceiling * (bottom - top)
    for (let i = 0; i <= 4; i++) {
      const value = ceiling * i / 4, py = y(value)
      svg.append(svgNode('line', { x1: left, y1: py, x2: right, y2: py, stroke: '#34383d', 'stroke-dasharray': '3 5' }), svgNode('text', { x: left - 9, y: py + 4, fill: '#9ca5af', 'font-size': 11, 'text-anchor': 'end' }, number(value)))
    }
    const labelCount = Math.max(2, Math.floor(plotWidth / 85)), step = Math.max(1, Math.ceil(rows.length / labelCount))
    rows.forEach((r, i) => {
      if (i % step === 0 || i === rows.length - 1 && rows.length % step > 1) svg.append(svgNode('text', { x: x(i), y: bottom + 25, fill: '#a7afb9', 'font-size': 11, 'text-anchor': 'middle' }, r.from.slice(5)))
      if (r.coverage === 'none') svg.append(svgNode('rect', { x: x(i) - plotWidth / rows.length / 2, y: top, width: plotWidth / rows.length, height: bottom - top, fill: '#ffffff04' }))
    })
    if (stacked) rows.forEach((row, i) => {
      if (row.coverage === 'none') return
      let base = 0
      for (const line of lines) {
        const value = row[line.field]
        if (value) svg.append(svgNode('rect', { x: x(i) - Math.min(40, plotWidth / rows.length * 0.65) / 2, y: y(base + value), width: Math.min(40, plotWidth / rows.length * 0.65), height: y(base) - y(base + value), fill: line.color, rx: 2 }))
        base += value
      }
    })
    else for (const line of lines) {
      let path = '', connected = false
      rows.forEach((row, i) => {
        if (row.coverage === 'none') { connected = false; return }
        path += `${connected ? 'L' : 'M'}${x(i)},${y(row[line.field])} `; connected = true
        svg.append(svgNode('circle', { cx: x(i), cy: y(row[line.field]), r: rows.length > 60 ? 1.6 : 3, fill: line.color }))
      })
      svg.append(svgNode('path', { d: path, fill: 'none', stroke: line.color, 'stroke-width': 2.5, 'stroke-linejoin': 'round' }))
    }
    if (!recorded || max === 0) svg.append(svgNode('text', { x: (left + right) / 2, y: (top + bottom) / 2, fill: '#b9c2cb', 'font-size': 13, 'text-anchor': 'middle' }, recorded ? 'No activity recorded in this view' : 'Before tracking started'))
    const cursor = svgNode('line', { y1: top, y2: bottom, stroke: '#d7dce2', 'stroke-dasharray': '3 4', visibility: 'hidden' }); svg.append(cursor)
    const show = (row, i) => {
      cursor.setAttribute('x1', x(i)); cursor.setAttribute('x2', x(i)); cursor.setAttribute('visibility', 'visible')
      tooltip.hidden = false
      tooltip.textContent = `${row.from}${row.through !== row.from ? ' — ' + row.through : ''}${row.coverage === 'partial' ? ' · partial history' : ''}\n` + (row.coverage === 'none' ? 'Before tracking started' : lines.map((line) => `${line.label}: ${number(row[line.field])}`).join('\n'))
      tooltip.style.left = Math.min(Math.max(8, x(i) - 100), Math.max(8, width - 250)) + 'px'
    }
    const hits = []
    let keyboardInspection = false
    rows.forEach((row, i) => {
      const label = `${row.from} to ${row.through}. ${row.coverage === 'none' ? 'Before tracking started.' : lines.map((l) => `${l.label} ${number(row[l.field])}`).join('. ')}`
      const hit = svgNode('rect', { x: x(i) - plotWidth / rows.length / 2, y: top, width: plotWidth / rows.length, height: bottom - top, fill: 'transparent', tabindex: i === 0 ? 0 : -1, role: 'button', 'aria-label': label })
      hit.addEventListener('pointerenter', () => { if (!keyboardInspection) show(row, i) })
      hit.addEventListener('pointermove', (event) => { if (event.movementX || event.movementY) { keyboardInspection = false; show(row, i) } })
      hit.addEventListener('pointerdown', () => { keyboardInspection = false; show(row, i) })
      hit.addEventListener('click', () => show(row, i))
      hit.addEventListener('focus', () => { if (hit.matches(':focus-visible')) keyboardInspection = true; show(row, i) })
      hit.addEventListener('keydown', (event) => {
        keyboardInspection = true
        if (event.key === 'Escape') { tooltip.hidden = true; cursor.setAttribute('visibility', 'hidden'); return }
        let next = i
        if (event.key === 'ArrowRight') next = Math.min(rows.length - 1, i + 1)
        else if (event.key === 'ArrowLeft') next = Math.max(0, i - 1)
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = rows.length - 1
        else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); show(row, i); return }
        else return
        event.preventDefault(); hit.setAttribute('tabindex', '-1'); hits[next].setAttribute('tabindex', '0'); hits[next].focus()
      })
      hit.addEventListener('blur', () => { tooltip.hidden = true; cursor.setAttribute('visibility', 'hidden') }); hits.push(hit); svg.append(hit)
    })
    host.onpointerleave = () => { if (!keyboardInspection) { tooltip.hidden = true; cursor.setAttribute('visibility', 'hidden') } }
    host.append(svg, tooltip)
  }
  const percent = (n) => n == null ? '—' : n.toFixed(1) + '%'
  const minutes = (n) => n == null ? '—' : n.toFixed(1) + ' min'
  const node = (tag, text, css) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (css) el.className = css; return el }
  function selectFilter(key, value) {
    filters[key] = value; document.querySelector(`[data-filter="${key}"]`).value = value; page = 0; render()
  }
  function table(id, rows, columns, filter) {
    const host = document.querySelector('#' + id); host.replaceChildren()
    const table = node('table'), head = node('thead'), titles = node('tr'), body = node('tbody')
    for (const column of columns) titles.append(node('th', column.title))
    head.append(titles); table.append(head, body)
    if (!rows.length) { const tr = node('tr'), td = node('td', 'No records match these filters.'); td.colSpan = columns.length; tr.append(td); body.append(tr) }
    for (const row of rows) {
      const tr = node('tr')
      columns.forEach((column, i) => {
        const td = node(i ? 'td' : 'th')
        if (!i && filter) {
          const button = node('button', label(row.value), 'link-button'); button.type = 'button'; button.title = `Filter by ${label(row.value)}`; button.addEventListener('click', () => selectFilter(filter, row.value)); td.append(button)
        } else td.textContent = column.read(row)
        tr.append(td)
      })
      body.append(tr)
    }
    host.append(table)
  }
  function bars(id, rows, field, filter, title) {
    const host = document.querySelector('#' + id); host.replaceChildren()
    if (!rows.length) { host.append(node('p', 'No records match these filters.', 'muted')); return }
    const total = sum(rows, field)
    for (const row of rows) {
      const button = node('button', undefined, 'breakdown-bar'); button.type = 'button'
      const text = node('span', label(row.value)), rail = node('span', undefined, 'bar-rail'), fill = node('i')
      fill.style.width = `${total ? row[field] / total * 100 : 0}%`; rail.append(fill)
      button.append(text, rail, node('b', `${number(row[field])} · ${total ? Math.round(row[field] / total * 100) : 0}%`))
      button.title = `${label(row.value)}: ${number(row[field])} ${title}. Click to filter.`
      button.addEventListener('click', () => selectFilter(filter, row.value)); host.append(button)
    }
  }
  const trafficColumns = [{ title: 'Value', read: (r) => label(r.value) }, { title: 'Guest identities', read: (r) => number(r.guests) }, { title: 'Accounts', read: (r) => number(r.accounts) }, { title: 'Visits', read: (r) => number(r.visits) }, { title: 'App minutes ≈', read: (r) => number(r.minutes) }]
  const gameColumns = [{ title: 'Value', read: (r) => label(r.value) }, { title: 'Games', read: (r) => number(r.started) }, { title: 'Completed', read: (r) => number(r.completed) }, { title: 'Completion', read: (r) => percent(r.completionRate) }, { title: 'Abandoned', read: (r) => percent(r.abandonmentRate) }, { title: 'Avg duration', read: (r) => minutes(r.averageMinutes) }, { title: 'Human participations', read: (r) => number(r.participations) }, { title: 'Bot seats', read: (r) => number(r.botSeats) }]
  function renderMatches() {
    const host = document.querySelector('#matching-games'); host.replaceChildren()
    const table = node('table'), head = node('thead'), headings = node('tr'), body = node('tbody')
    const columns = [['started_at', 'Started UTC'], ['region', 'Region'], ['build', 'Server build'], ['queue', 'Queue'], ['game_mode', 'Mode'], ['team_mode', 'Teams'], ['status', 'Outcome'], ['seconds', 'Duration'], ['rounds', 'Rounds'], ['humans', 'Humans'], ['bots', 'Bots'], ['room', 'Room']]
    for (const [field, title] of columns) {
      const th = node('th'), button = node('button', title + (sort === field ? direction === -1 ? ' ↓' : ' ↑' : ''), 'link-button')
      th.setAttribute('aria-sort', sort === field ? direction === -1 ? 'descending' : 'ascending' : 'none')
      button.type = 'button'; button.addEventListener('click', () => { direction = sort === field ? -direction : -1; sort = field; page = 0; renderMatches() }); th.append(button); headings.append(th)
    }
    head.append(headings); table.append(head, body)
    const rows = [...view.matches].sort((a, b) => {
      const left = a[sort], right = b[sort]
      return (typeof left === 'number' && typeof right === 'number' ? left - right : String(left ?? '').localeCompare(String(right ?? ''))) * direction
    })
    for (const row of rows.slice(page * 50, (page + 1) * 50)) {
      const tr = node('tr'); tr.title = `Match ${row.id} · commit ${label(row.commit_id)}`
      for (const [field] of columns) tr.append(node('td', field === 'started_at' ? new Date(row[field]).toISOString().replace('T', ' ').slice(0, 19) : field === 'seconds' ? row.status === 'completed' ? minutes(row.seconds / 60) : '—' : label(row[field])))
      body.append(tr)
    }
    if (!rows.length) { const tr = node('tr'), td = node('td', 'No games match these filters.'); td.colSpan = columns.length; tr.append(td); body.append(tr) }
    host.append(table)
    document.querySelector('#match-count').textContent = `${number(rows.length)} matching games · page ${page + 1} of ${Math.max(1, Math.ceil(rows.length / 50))}`
    document.querySelector('#page-prev').disabled = page === 0; document.querySelector('#page-next').disabled = (page + 1) * 50 >= rows.length
  }
  document.querySelector('#page-prev').addEventListener('click', () => { page--; renderMatches() })
  document.querySelector('#page-next').addEventListener('click', () => { page++; renderMatches() })
  function render() {
    view = explorer.query({ from, through, filters })
    const { current, previous, breakdowns } = view
    document.querySelector('#filter-error').textContent = ''
    document.querySelector('#date-from').value = from; document.querySelector('#date-through').value = through
    document.querySelector('#chart-window').textContent = `${from} — ${through} · UTC`
    document.querySelector('#comparison-note').textContent = `Compared with ${previous.from} — ${previous.through}, with the same filters. Today is incomplete; weeks start Monday. Percentages require full history.`
    const quality = current.coverage === 'complete' ? previous.coverage : 'partial'
    const gameQuality = current.gameCoverage === 'complete' ? previous.gameCoverage : 'partial'
    document.querySelector('#trend-metrics').replaceChildren(
      metric('Guest identities', 'guests', current, previous, quality, `${number(current.newGuests)} first seen · ${number(current.guests - current.newGuests)} returning`),
      metric('Signed-in accounts', 'accounts', current, previous, quality, `${number(current.newAccounts)} first seen in the app`),
      metric('Visits', 'visits', current, previous, quality, 'App activity filters'),
      metric('Games started', 'started', current, previous, gameQuality, `${number(current.completed)} completed · ${number(current.running)} running`),
    )
    const auxiliary = [['Browsers seen', number(current.browsers), view.browserCoverage === 'complete' ? 'Deduplicated across sign-in / sign-out' : 'Browser attribution has partial history'],
      ['Guest → sign-in', number(current.conversions), current.conversions == null ? 'Not attributed to screen, netcode or identity filters' : 'First observed guest-to-account transitions'],
      ['Completed games', number(current.completed), `${percent(current.completionRate)} of resolved games`],
      ['Average game', minutes(current.averageMinutes), `${number(current.completedRounds)} completed rounds`],
      ['Human participations', number(current.participations), `${number(current.guestSeats)} guest / ${number(current.accountSeats)} account seats`],
      ['Bot seats', number(current.botSeats), 'Initial bots across selected games; human counts include late joins']]
    document.querySelector('#secondary-metrics').replaceChildren(...auxiliary.map(([title, value, detail]) => { const article = node('article', undefined, 'metric'); article.append(node('span', title), node('strong', value), node('small', detail)); return article }))
    const active = Object.keys(filters).filter((key) => filters[key] !== '*')
    document.querySelector('#filter-count').textContent = active.length ? `More filters · ${active.length} active` : 'More filters'
    document.querySelector('#filter-summary').textContent = active.length ? active.map((key) => `${document.querySelector(`[data-filter="${key}"]`).dataset.title}: ${label(filters[key])}`).join(' · ') : 'All regions · all releases · all queues and outcomes'
    for (const btn of ranges.children) btn.setAttribute('aria-pressed', String(Number(btn.dataset.value) === selected))
    for (const btn of groups.children) btn.setAttribute('aria-pressed', String(btn.dataset.value === grain))
    const rows = view[grain], noun = grain === 'daily' ? 'day' : 'week'
    document.querySelector('#visitor-note').textContent = `Distinct identities per ${noun}, deduplicated after filtering. Guest/account activity can overlap.`
    const games = rows.map((r) => ({ ...r, coverage: r.gameCoverage }))
    if (!document.querySelector('#panel-overview').hidden) {
    chart('visitors-chart', rows, [{ field: 'guests', label: 'Guest identities', color: '#e8b775' }, { field: 'accounts', label: 'Signed-in accounts', color: '#66d9cf' }], false, `Filtered visitors by ${noun}`)
    chart('games-chart', games, [{ field: 'completed', label: 'Completed', color: '#66d9a7' }, { field: 'abandoned', label: 'Abandoned', color: '#e8b775' }, { field: 'interrupted', label: 'Interrupted', color: '#f18a92' }, { field: 'running', label: 'Running', color: '#a99de8' }], true, `Filtered games by ${noun}`)
    chart('visits-chart', rows, [{ field: 'visits', label: 'Visits', color: '#93baff' }], false, `Filtered visits by ${noun}`)
    chart('peak-chart', rows.map((r) => ({ ...r, coverage: r.peak == null ? 'none' : r.coverage })), [{ field: 'peak', label: 'Peak online', color: '#c0a4f4' }], false, `Filtered ${view.peakBasis} peak online by ${noun}`)
    chartWidth = document.querySelector('#chart-panels').clientWidth
    }
    document.querySelector('#peak-note').textContent = view.peakBasis === 'observed' ? 'Observed global peak. Filtered peaks use simultaneous 30-second samples; peaks are never added together.' : 'Peak from simultaneous 30-second samples after applying app filters. Earlier periods without samples are gaps.'
    bars('region-games', breakdowns.regions, 'started', 'region', 'games'); bars('region-visits', breakdowns.regions, 'visits', 'region', 'visits')
    bars('overview-regions', breakdowns.regions, 'started', 'region', 'games'); bars('overview-queues', breakdowns.queues, 'started', 'queue', 'games')
    table('regions-table', breakdowns.regions, [...trafficColumns.slice(0, 4), ...gameColumns.slice(1)], 'region')
    for (const [id, values, columns, filter] of [['client-builds-table', breakdowns.clientBuilds, trafficColumns, 'clientBuild'], ['client-nets-table', breakdowns.clientNets, trafficColumns, 'clientNet'],
      ['server-builds-table', breakdowns.serverBuilds, gameColumns, 'serverBuild'], ['commits-table', breakdowns.commits, gameColumns, 'commit'],
      ['queues-table', breakdowns.queues, gameColumns, 'queue'], ['modes-table', breakdowns.modes, gameColumns, 'mode'], ['teams-table', breakdowns.teams, gameColumns, 'team'], ['outcomes-table', breakdowns.outcomes, gameColumns, 'outcome'],
      ['screens-table', breakdowns.screens, trafficColumns, 'screen'], ['identities-table', breakdowns.identities, trafficColumns, 'identity']]) table(id, values, columns, filter)
    const leading = breakdowns.regions[0], unknown = view.matches.filter((m) => !m.build).length
    document.querySelector('#insights').textContent = `${leading ? `${label(leading.value)} leads with ${number(leading.started)} games and ${number(leading.visits)} visits. ` : 'No activity matches these filters. '}${current.started ? `${percent(current.abandonmentRate)} of resolved games were abandoned. ` : ''}${unknown ? `${number(unknown)} games have no recorded server build. ` : ''}Comparisons describe selected data; they do not establish a cause.`
    renderMatches()
    document.querySelector('#chart-status').textContent = `${view.days} days, ${grain} view. ${active.length} active filters. ${number(current.started)} matching games.`
  }
  render()
  const chartPanels = document.querySelector('#chart-panels')
  chartWidth = chartPanels.clientWidth
  new ResizeObserver(() => {
    const width = chartPanels.clientWidth
    if (width !== chartWidth) { chartWidth = width; if (width > 0) render() }
  }).observe(chartPanels)
}
