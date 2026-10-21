// Optional server-only Resend sender. Player sign-in never requests mailbox access.
import { OPERATOR_EMAIL } from './operator.mjs'
export const FEEDBACK_MAIL_INTERVAL = 15 * 60_000
const json = (status, body) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

export function openFeedbackMail({ origin, apiKey = '', from = '', feedback, fetcher = fetch, now = Date.now, onError = () => console.error('Feedback email delivery failed; reports remain queued.') }) {
  if (Boolean(apiKey) !== Boolean(from)) throw new Error('Feedback email requires both RESEND_API_KEY and FEEDBACK_MAIL_FROM')
  if (apiKey && (!/^re_[A-Za-z0-9_-]{8,}$/.test(apiKey) || from.length > 254 || !/^[^\r\n<>]+ <[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>$/.test(from))) throw new Error('Invalid Resend feedback configuration')
  const configured = Boolean(apiKey)
  const controller = new AbortController()
  let sending = null, stopped = false, lastSentAt = feedback.lastMailedAt(), lastError = null
  let lastAttempt = lastSentAt ?? -Infinity
  function deliver() {
    if (stopped || sending || !configured || now() - lastAttempt < FEEDBACK_MAIL_INTERVAL) return sending
    // Freeze the body and key in SQLite before sending, including across restarts
    // and new arrivals. A lost response must never change the retry payload.
    let batch
    try {
      batch = feedback.mailDelivery((reports) => ({ from, to: [OPERATOR_EMAIL],
        subject: `Brawlock: ${reports.length} new feedback report${reports.length === 1 ? '' : 's'}`,
        text: `Brawlock: ${reports.length} new private report${reports.length === 1 ? '' : 's'}.\n\n` + reports.map((r) => `${new Date(r.at).toISOString()} | ${r.kind} | ${r.id}\n${r.message}`).join('\n\n---\n\n') + `\n\nScreenshots, reply addresses and diagnostics:\n${origin}/admin.html#feedback\n`,
      }))
    } catch { lastError = 'The email queue could not be read. Reports remain in the private inbox.'; onError(); return null }
    if (!batch) return null
    lastAttempt = now()
    sending = (async () => {
      const response = await fetcher('https://api.resend.com/emails', { method: 'POST', redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'idempotency-key': batch.key }, body: batch.payload })
      if (!response.ok) {
        // Do not include provider bodies, API keys or report text in logs/status.
        lastError = `Resend returned HTTP ${response.status}. Check the sender domain, API key or quota; reports remain queued.`
        throw new Error('Resend rejected feedback delivery')
      }
      const receipt = await response.json()
      if (typeof receipt.id !== 'string' || !receipt.id) throw new Error('Resend did not confirm delivery')
      feedback.completeMail(batch.key); lastSentAt = now(); lastError = null
    })().catch(() => { lastError ??= 'Email delivery was not confirmed. Reports remain queued for retry.'; onError() }).finally(() => { sending = null })
    return sending
  }
  const timer = setInterval(deliver, 30_000); timer.unref(); void deliver()
  return {
    deliver,
    async handler(request) {
      if (new URL(request.url).pathname !== '/api/admin/mail') return json(404, { error: 'Not found.' })
      if (request.method !== 'GET') return json(405, { error: 'Method not allowed.' })
      return json(200, { configured, pending: feedback.mailPending(), lastSentAt, error: lastError, intervalMs: FEEDBACK_MAIL_INTERVAL })
    },
    async close() { stopped = true; clearInterval(timer); controller.abort(); await sending },
  }
}
