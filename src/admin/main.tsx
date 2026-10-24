import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createAuthClient } from 'better-auth/client'
import type { FleetView, HistoryPoint, Metric } from '../shared/monitoring'
import './style.css'
import { FleetCard as Card } from './FleetCard'

const auth = createAuthClient()
const fmt = (v: number | null | undefined, unit = '', digits = 0) => v == null ? '—' : `${v.toFixed(digits)}${unit}`
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const age = (at: number) => `${Math.max(0, Math.round((Date.now() - at) / 1000))}s ago`
async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) })
  if (!response.ok) {
    const body = await response.json()
    throw Object.assign(new Error(body.error), { status: response.status })
  }
  return response.json()
}
const colors = ['#61d5c0', '#b39cff', '#f7b969']
function Plot({ title, points, keys, labels, unit, view, hovered, onHover }: { title: string; points: HistoryPoint[]; keys: Metric[]; labels: string[]; unit: string; view: FleetView; hovered: number | null; onHover: (at: number | null) => void }) {
  const width = 620, height = 150, left = 46, right = 54, top = 14, bottom = 28
  const x = (at: number) => left + (at - view.from) / (view.through - view.from) * (width - left - right)
  const all = points.flatMap((p) => keys.flatMap((key) => p[key] === null ? [] : [p[key]!]))
  const ceiling = Math.max(keys.includes('hostCpu') || keys.includes('processCpu') ? 100 : unit === '%' ? 5 : 1, ...all)
  const y = (value: number) => height - bottom - value / ceiling * (height - top - bottom)
  const selected = hovered === null ? undefined : points.reduce<HistoryPoint | undefined>((best, p) => !best || Math.abs(p.at - hovered) < Math.abs(best.at - hovered) ? p : best, undefined)
  const paths = (key: Metric) => {
    let path = '', last = -Infinity
    for (const p of points) {
      const value = p[key]
      if (value === null) { last = -Infinity; continue }
      path += `${p.at - last > view.grain * 1.5 ? 'M' : 'L'}${x(p.at).toFixed(1)},${y(value).toFixed(1)} `
      last = p.at
    }
    return path
  }
  return <section className="plot"><h3>{title}</h3><div className="legend">{keys.map((key, i) => <span key={key}><i style={{ background: colors[i] }} />{labels[i]}{selected && ` ${fmt(selected[key], unit, 1)}`}</span>)}</div>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}. ${points.length} time buckets; unavailable samples shown as gaps.`} onMouseLeave={() => onHover(null)} onMouseMove={(e) => {
      const rect = e.currentTarget.getBoundingClientRect(), at = view.from + ((e.clientX - rect.left) / rect.width * width - left) / (width - left - right) * (view.through - view.from)
      onHover(Math.max(view.from, Math.min(view.through, at)))
    }}>
      {[0, .5, 1].map((fraction) => <g key={fraction}><line x1={left} x2={width - right} y1={y(ceiling * fraction)} y2={y(ceiling * fraction)} className="grid-line" /><text x={left - 7} y={y(ceiling * fraction) + 4} textAnchor="end">{fmt(ceiling * fraction, unit)}</text></g>)}
      {points.filter((p) => p.failures > 0).map((p) => <rect key={p.at} x={x(p.at)} y={top} width={Math.max(2, x(p.at + view.grain) - x(p.at))} height={height - top - bottom} fill="#ff79651c" />)}
      {keys.map((key, i) => <path key={key} d={paths(key)} stroke={colors[i]} fill="none" strokeWidth="1.8" />)}
      {selected && <line x1={x(selected.at)} x2={x(selected.at)} y1={top} y2={height - bottom} stroke="#ffffff66" strokeDasharray="3 3" />}
      <text x={left} y={height - 5}>{new Date(view.from).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</text><text x={width - right} y={height - 5} textAnchor="end">{clock(view.through)}</text>
    </svg><p className="plot-note">{selected ? `${new Date(selected.at).toLocaleString()} · ${selected.samples} samples${selected.failures ? ` · ${selected.failures} unavailable` : ''}` : all.length ? 'Hover to compare the same time across charts.' : 'No measurements in this period yet.'}</p>
  </section>
}
interface Report { id: string; receivedAt: number; kind: string; message: string; release: string; hasScreenshot: boolean }
interface FullReport { message: string; contactEmail?: string; context: unknown; screenshot?: { mime: string; data: string } }
interface MailStatus { configured: boolean; intervalMs: number; pending: number; lastSentAt: number | null; error: string | null }
function Inbox() {
  const [reports, setReports] = useState<Report[]>([]), [before, setBefore] = useState<string | null>(null), [next, setNext] = useState<string | null>(null)
  const [mail, setMail] = useState<MailStatus | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<FullReport | null>(null), [error, setError] = useState('')
  useEffect(() => {
    if (!selected) return
    const controller = new AbortController()
    void api<FullReport>(`/api/admin/feedback/${selected}`, controller.signal).then(setDetail).catch((e) => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [selected])
  useEffect(() => {
    const controller = new AbortController()
    const load = () => api<{ reports: Report[]; nextBefore: string | null }>(`/api/admin/feedback?limit=25${before ? `&before=${encodeURIComponent(before)}` : ''}`, controller.signal).then((value) => { setReports(value.reports); setNext(value.nextBefore); setError('') }).catch((e) => { if (!controller.signal.aborted) setError(e.message) })
    const loadMail = () => api<MailStatus>('/api/admin/mail', controller.signal).then(setMail).catch((e) => { if (!controller.signal.aborted) setError(e.message) })
    void load(); void loadMail(); const timer = setInterval(() => { if (!document.hidden) { void load(); void loadMail() } }, 30_000)
    return () => { clearInterval(timer); controller.abort() }
  }, [before])
  return <section className="card"><header><h2>Private feedback inbox</h2><button onClick={() => setBefore(null)}>Latest</button></header><p>Refreshes automatically every 30 seconds. Reports and screenshots stay private.</p>{error && <p className="error">{error}</p>}
    <div className="mail-status"><div><b>Feedback emails · Resend</b><p>{mail?.configured ? `${mail.pending} queued · up to 25 reports per digest, at most once every ${mail.intervalMs / 60_000} minutes${mail.lastSentAt ? ` · last accepted ${clock(mail.lastSentAt)}` : ''}` : 'Email forwarding is not configured on the server. Reports are saved in this private inbox.'}</p>{mail?.error && <p className="error">{mail.error}</p>}</div><span className={`status ${mail?.error ? 'bad' : mail?.configured ? 'good' : 'warning'}`}>{mail?.error ? 'Needs attention' : mail?.configured ? 'Configured' : 'Not configured'}</span></div>
    <div className="report-list">{reports.map((report) => <button key={report.id} onClick={() => { if (selected !== report.id) { setDetail(null); setSelected(report.id) } }}><small>{new Date(report.receivedAt).toLocaleString()} · {report.kind} · {report.release}{report.hasScreenshot ? ' · screenshot' : ''}</small><span>{report.message}</span></button>)}</div>
    {!reports.length && <p>No reports yet.</p>}{next && <button onClick={() => setBefore(next)}>Older reports</button>}
    {detail && <div className="report-detail"><h3>Report</h3><p className="message">{detail.message}</p>{detail.contactEmail && <p>Reply to: {detail.contactEmail}</p>}{detail.screenshot && <img src={`data:${detail.screenshot.mime};base64,${detail.screenshot.data}`} alt="Player-submitted screenshot" />}<details><summary>Diagnostic context</summary><pre>{JSON.stringify(detail.context, null, 2)}</pre></details></div>}
  </section>
}
interface PlayerRow { name: string; kind: 'account' | 'guest'; matches: number; wins: number; forfeits: number; seconds: number; kills: number; deaths: number; queues: { ranked: number; casual: number; custom: number }; days: number; firstAt: number; lastAt: number }
type PlayerSort = 'seconds' | 'matches' | 'wins' | 'kills' | 'days' | 'lastAt'
const periods: [number, string][] = [[1, 'Last 24 hours'], [7, 'Last 7 days'], [30, 'Last 30 days'], [0, 'All time']]
const playTime = (seconds: number) => seconds < 3600 ? `${Math.round(seconds / 60)} min` : `${Math.floor(seconds / 3600)} h ${Math.round(seconds % 3600 / 60)} min`
function Players() {
  const [days, setDays] = useState(7), [sort, setSort] = useState<PlayerSort>('seconds')
  const [report, setReport] = useState<{ historySince: number | null; players: PlayerRow[] } | null>(null), [error, setError] = useState(''), [copied, setCopied] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    setReport(null); setError('')
    void api<{ historySince: number | null; players: PlayerRow[] }>(`/api/admin/players?days=${days}`, controller.signal).then(setReport).catch((e) => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [days])
  const rows = [...report?.players ?? []].sort((a, b) => b[sort] - a[sort] || b.seconds - a.seconds)
  const period = periods.find(([d]) => d === days)![1]
  const copy = () => {
    const text = [`Most active warlocks · ${period.toLowerCase()}`, ...rows.slice(0, 10).map((p, i) => `${i + 1}. ${p.name}: ${playTime(p.seconds)}, ${p.matches} ${p.matches === 1 ? 'game' : 'games'}, ${p.wins} ${p.wins === 1 ? 'win' : 'wins'}, ${p.kills} kills`)].join('\n')
    void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
  }
  const head = (key: PlayerSort, label: string) => <th><button className="sort" aria-pressed={sort === key} onClick={() => setSort(key)}>{label}{sort === key ? ' ↓' : ''}</button></th>
  return <section className="card"><header><h2>Most active players</h2><div className="players-actions"><select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))}>{periods.map(([d, label]) => <option key={d} value={d}>{label}</option>)}</select><button onClick={copy} disabled={!rows.length}>{copied ? 'Copied' : 'Copy top 10'}</button></div></header>
    {error && <p className="error">{error}</p>}
    {report && <p>{rows.length} {rows.length === 1 ? 'player' : 'players'} · {rows.reduce((sum, p) => sum + p.matches, 0)} seats in games · {playTime(rows.reduce((sum, p) => sum + p.seconds, 0))} played in total{report.historySince ? ` · recorded since ${new Date(report.historySince).toLocaleDateString()}` : ''}</p>}
    {!report && !error ? <p>Loading…</p> : report && !rows.length ? <p>No recorded games in this period.</p> : report && <div className="table-wrap"><table className="players"><thead><tr><th>#</th><th>Player</th>{head('seconds', 'Time in games')}{head('matches', 'Games')}{head('wins', 'Wins')}{head('kills', 'Kills')}<th>K/D</th>{head('days', 'Days active')}<th>Ranked · casual · custom</th>{head('lastAt', 'Last played')}</tr></thead>
      <tbody>{rows.map((p, i) => <tr key={i}><td>{i + 1}</td><td><b>{p.name}</b>{p.kind === 'guest' && <span className="guest">Guest</span>}</td><td>{playTime(p.seconds)}</td><td>{p.matches}</td><td>{p.wins}{p.matches ? ` · ${Math.round(p.wins / p.matches * 100)}%` : ''}</td><td>{p.kills}</td><td>{p.deaths ? (p.kills / p.deaths).toFixed(2) : p.kills ? '∞' : '—'}</td><td>{p.days}</td><td>{p.queues.ranked} · {p.queues.casual} · {p.queues.custom}</td><td>{new Date(p.lastAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td></tr>)}</tbody></table></div>}
    <p className="footnote">Counts finished games on Brawlock's servers (quick play, ranked and server-hosted custom rooms) from the global match history. Player-hosted games and bots are not included. Kills include bot kills. Signed-in players show their current account name; guests show the name from their latest game, and one guest on two browsers counts twice. Names and play counts are visible to other players in game, but check with a player before featuring them publicly.</p>
  </section>
}
function Dashboard() {
  const [email, setEmail] = useState<string | null>(null), [authState, setAuthState] = useState('checking'), [error, setError] = useState('')
  const [hours, setHours] = useState(1), [region, setRegion] = useState('all'), [tab, setTab] = useState(location.hash === '#feedback' ? 'feedback' : 'fleet')
  const [requestAt, setRequestAt] = useState(0)
  const [view, setView] = useState<FleetView | null>(null), [hovered, setHovered] = useState<number | null>(null)
  useEffect(() => { const controller = new AbortController(); void api<{ email: string }>('/api/admin/session', controller.signal).then((user) => { setEmail(user.email); setAuthState('ready') }).catch((e) => { if (!controller.signal.aborted) { setAuthState(e.status === 401 ? 'login' : 'denied'); setError(e.message) } }); return () => controller.abort() }, [])
  useEffect(() => {
    if (authState !== 'ready') return
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        if (!document.hidden) { const value = await api<FleetView>(`/api/admin/monitoring?hours=${hours}`, controller.signal); setView(value); setError('') }
      } catch (e) { if (!controller.signal.aborted) { const cause = e as Error & { status?: number }; setError(cause.message); if (cause.status === 401 || cause.status === 403) { setView(null); setAuthState(cause.status === 401 ? 'login' : 'denied') } } }
      if (!controller.signal.aborted) { setRequestAt(Date.now()); timer = setTimeout(poll, 5000) }
    }
    void poll(); return () => { clearTimeout(timer); controller.abort() }
  }, [authState, hours])
  return <main><header className="masthead"><div><a className="wordmark" href="/">BRAWLOCK</a><h1>Operations</h1><p>Fleet health, player connections and activity.</p></div><div className="account">{email && <span>{email}</span>}<a href="/">Back to game</a>{authState === 'ready' || authState === 'denied' ? <button onClick={() => void auth.signOut().then(() => location.reload())}>Sign out</button> : null}</div></header>
    {authState !== 'ready' ? <section className="card login"><h2>{authState === 'checking' ? 'Checking access…' : authState === 'denied' ? 'Administrator access required' : 'Sign in to operations'}</h2><p>{error || 'This dashboard is private.'}</p>{authState === 'login' && <button className="primary" onClick={() => { setError(''); void auth.signIn.social({ provider: 'google', callbackURL: `${location.origin}/admin.html` }).then((result) => { if (result.error) setError(result.error.message ?? 'Google sign-in failed.') }).catch(() => setError('Google sign-in could not start.')) }}>Continue with Google</button>}</section> : <>
      <nav className="tabs" aria-label="Operations views">{[['fleet', 'Live fleet'], ['players', 'Players'], ['activity', 'Player activity'], ['feedback', 'Bugs & feedback']].map(([id, name]) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>{name}</button>)}</nav>
      {error && <p className="error" role="alert">{error} The displayed data may be stale.</p>}
      {tab === 'players' ? <Players /> : tab === 'activity' ? <><p>Activity is collected directly from the account service and both regions when opened. Refresh this view for a new snapshot.</p><iframe className="activity-frame" src="/api/admin/activity" title="Private player activity explorer" /></> : tab === 'feedback' ? <Inbox /> : !view ? <p>Waiting for fleet data…</p> : <>
        <div className="toolbar"><div className="live-label"><i />Automatic collection · 10s samples · last check {requestAt ? age(requestAt) : 'pending'}</div><div><label>Region <select value={region} onChange={(e) => setRegion(e.target.value)}><option value="all">All regions</option>{view.regions.map((r) => <option value={r.id} key={r.id}>{r.label}</option>)}</select></label><label>History <select value={hours} onChange={(e) => { setHours(Number(e.target.value)); setHovered(null) }}><option value={1}>Last hour</option><option value={24}>24 hours</option><option value={168}>7 days</option><option value={720}>30 days</option></select></label></div></div>
        <div className="deployment"><span><b>Website</b> {view.website?.ok ? `${view.website.version} · ${view.website.build?.slice(0, 8)} · ${view.website.releaseDate}` : 'Version unavailable'}</span><span>History retained {view.retentionDays} days · collected even when this page is closed</span></div>
        {view.website?.ok && view.regions.some((r) => { const release = view.latest[r.id]?.sample?.release; return release?.commit && release.commit !== view.website?.build }) && <p className="error">Deployment versions differ across the website and game servers. A rollout may still be in progress.</p>}
        <div className="cards">{view.regions.filter((r) => region === 'all' || region === r.id).map((r) => <Card key={r.id} id={r.id} label={r.label} view={view} />)}<Card id="accounts" label="Accounts & presence · US host" view={view} /></div>
        {view.regions.filter((r) => region === 'all' || region === r.id).map((r) => { const points = view.history.filter((p) => p.region === r.id); return <details key={r.id} className="region-history history-details"><summary><b>{r.label}</b><span>CPU, players, latency & network history</span></summary><div className="plots">
          <Plot title="CPU peaks" keys={['hostCpu', 'processCpu', 'steal']} labels={['Host · all cores', 'Game process · one core = 100%', 'Steal · taken by the hypervisor']} unit="%" {...{ points, view, hovered, onHover: setHovered }} />
          <Plot title="People & rooms" keys={['players', 'bots', 'rooms']} labels={['Human seats', 'Bots', 'Rooms']} unit="" {...{ points, view, hovered, onHover: setHovered }} />
          <Plot title="Player latency" keys={['ping', 'loop']} labels={['Player RTT p95', 'Server event loop max']} unit=" ms" {...{ points, view, hovered, onHover: setHovered }} />
          <Plot title="Packet loss" keys={['loss']} labels={['Worst player packet loss']} unit="%" {...{ points, view, hovered, onHover: setHovered }} />
          <Plot title="Server network" keys={['anchor', 'poll', 'loop']} labels={['Internet anchor · TCP connect', 'Poll from US accounts', 'Server event loop max']} unit=" ms" {...{ points, view, hovered, onHover: setHovered }} />
        </div></details> })}
        <details className="region-history history-details"><summary><b>App presence & account service</b><span>People online & CPU history</span></summary><div className="plots"><Plot title="People in the app" keys={['online']} labels={['Menus, lobbies & games · deduplicated']} unit="" points={view.history.filter((p) => p.region === 'accounts')} {...{ view, hovered, onHover: setHovered }} /><Plot title="Account process CPU" keys={['processCpu']} labels={['One core = 100%']} unit="%" points={view.history.filter((p) => p.region === 'accounts')} {...{ view, hovered, onHover: setHovered }} /></div></details>
        <section className="card"><h2>Current rooms</h2>{view.regions.some((r) => !view.latest[r.id]?.ok || Date.now() - view.latest[r.id].at >= 30_000) && <p className="error">Some regional room lists are unavailable. Only fresh samples are shown.</p>}<div className="table-wrap"><table><thead><tr><th>Region</th><th>Mode</th><th>Phase</th><th>Round</th><th>Humans</th><th>Bots</th></tr></thead><tbody>{view.regions.flatMap((r) => (view.latest[r.id]?.ok && Date.now() - view.latest[r.id].at < 30_000 ? view.latest[r.id]?.sample?.rooms ?? [] : []).map((room, i) => <tr key={`${r.id}-${i}`}><td>{r.label}</td><td>{room.mode}</td><td>{room.phase}</td><td>{room.round ?? '—'}</td><td>{room.humans}</td><td>{room.bots}</td></tr>))}</tbody></table></div></section>
        <p className="footnote">Charts show the maximum in each time bucket; gaps indicate unavailable measurements, and red bands mark failed samples. Host CPU covers all cores; process CPU uses one core as 100%. Player ping comes from gameplay transport probes, not an HTTP health check. Event loop max includes the sampler’s ≈20 ms baseline. Available RAM and steal time are reported on Linux only. Internet anchor is the fastest TCP handshake from the region to 1.1.1.1 or 8.8.8.8 every 10 s; poll from US is how long the US account host took to fetch the region’s sample. A spike in both with a calm event loop is the network between hosts; a spike in the event loop as well is the server itself; calm lines while a player lags point to the player’s own connection. Human seats include reserved disconnected players; connections show current sockets. Simulation steps/s is summed across active rooms.</p>
      </>}
    </>}
  </main>
}
createRoot(document.getElementById('root')!).render(<Dashboard />)
