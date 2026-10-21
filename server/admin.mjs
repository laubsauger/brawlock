import { fetchMonitoring } from './monitoring.mjs'
import { renderAnalytics } from '../scripts/analytics-report.mjs'

const json = (status, body) => Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })

/** Every private route independently verifies the existing Google-backed cookie. */
export function createAdmin({ accounts, store, collector, regions, token, origin, feedback, css, mail, now = Date.now, fetcher = fetch }) {
  let activity = null, activityAt = -Infinity, loading = null
  return async (request) => {
    const url = new URL(request.url)
    if ((request.headers.has('origin') && request.headers.get('origin') !== origin) || request.headers.get('sec-fetch-site') === 'cross-site') return json(403, { error: 'Forbidden origin.' })
    const admin = await accounts.admin(request)
    if (admin === null) return json(401, { error: 'Sign in with your administrator Google account.' })
    if (!admin) return json(403, { error: 'This account does not have administrator access.' })
    if (url.pathname.startsWith('/api/admin/mail')) {
      if (!mail) return json(503, { error: 'Email forwarding is not configured.' })
      return mail.handler(request)
    }
    if (request.method !== 'GET') return json(405, { error: 'Method not allowed.' })
    if (url.pathname === '/api/admin/session') return json(200, admin)
    if (url.pathname === '/api/admin/monitoring') {
      const hours = Number(url.searchParams.get('hours') ?? 1)
      if (![1, 24, 168].includes(hours) || [...url.searchParams.keys()].some((key) => key !== 'hours')) return json(400, { error: 'Choose 1, 24 or 168 hours.' })
      return json(200, { at: now(), intervalMs: 10_000, ...store.read(hours, now()), website: collector.website(), regions: regions.map(({ id, label }) => ({ id, label })) })
    }
    if (url.pathname === '/api/admin/activity') {
      if (url.search) return json(400, { error: 'Unexpected activity query.' })
      if (now() - activityAt > 60_000 || !activity) {
        if (!loading) loading = Promise.all(regions.map((region) => fetchMonitoring(region, token, { fetcher, reportDays: 30 })))
          .then((reports) => { activity = renderAnalytics({ reports: [accounts.activityReport(30), ...reports], css, live: true }); activityAt = now() })
          .finally(() => { loading = null })
        try { await loading } catch { return json(503, { error: 'Activity is unavailable: a region could not supply its report. Try again shortly.' }) }
      }
      return new Response(activity, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'SAMEORIGIN', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } })
    }
    if (url.pathname === '/api/admin/feedback' || /^\/api\/admin\/feedback\/[0-9a-f-]+$/.test(url.pathname)) {
      // Server-to-server bridge; the regional bearer never reaches the browser.
      return feedback.handler(new Request(`http://localhost${url.pathname.replace('/api/admin/feedback', '/internal/feedback')}${url.search}`, { headers: { authorization: `Bearer ${token}` } }))
    }
    return json(404, { error: 'Not found.' })
  }
}
