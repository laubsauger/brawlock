import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openFeedbackMail, FEEDBACK_MAIL_INTERVAL } from './feedback-mail.mjs'

const origin = 'https://game.test'
const apiKey = 're_private_test_key_12345'
const from = 'Brawlock <feedback@notify.game.test>'
function queue(clock) {
  let batch = null, last = null, sequence = 0
  const reports = [{ id: 'report-one', at: 100, kind: 'bug', message: 'Player text\r\nTo: victim@example.test' }]
  return { reports,
    lastMailedAt: () => last,
    mailPending: () => reports.length,
    mailDelivery(build) {
      if (!batch && reports.length) batch = { key: `test-batch/${++sequence}`, ids: reports.map((r) => r.id), payload: JSON.stringify(build([...reports])) }
      return batch ? { key: batch.key, payload: batch.payload } : null
    },
    completeMail(key) {
      assert.equal(key, batch.key)
      const ids = batch.ids
      for (let i = reports.length - 1; i >= 0; i--) if (ids.includes(reports[i].id)) reports.splice(i, 1)
      batch = null; last = clock()
    },
  }
}
const request = (path = '', method = 'GET') => new Request(`${origin}/api/admin/mail${path}`, { method })

test('Resend is explicitly unconfigured without credentials, rejects partial config and has no Gmail authorization endpoints', async () => {
  const feedback = queue(() => 1)
  const mail = openFeedbackMail({ origin, feedback, fetcher: async () => { throw Error('Must not send') } })
  try {
    assert.deepEqual(await (await mail.handler(request())).json(), { configured: false, pending: 1, lastSentAt: null, error: null, intervalMs: FEEDBACK_MAIL_INTERVAL })
    assert.equal((await mail.handler(request('', 'POST'))).status, 405)
    assert.equal((await mail.handler(request('/connect', 'POST'))).status, 404)
    assert.equal((await mail.handler(request('/callback'))).status, 404)
    assert.throws(() => openFeedbackMail({ origin, feedback, apiKey }), /requires both/)
    assert.throws(() => openFeedbackMail({ origin, feedback, from }), /requires both/)
    assert.throws(() => openFeedbackMail({ origin, feedback, apiKey, from: 'bad\r\nheader' }), /Invalid/)
  } finally { await mail.close() }
})

test('Resend sends only to the operator with server-owned headers, bounded digests and no key in admin responses', async () => {
  let call
  const feedback = queue(() => 1000)
  const mail = openFeedbackMail({ origin, feedback, apiKey, from, now: () => 1000, fetcher: async (url, options) => {
    call = { url, options }; return Response.json({ id: 'accepted-message' })
  } })
  try {
    const first = mail.deliver(), second = mail.deliver()
    assert.equal(first, second)
    await first
    assert.equal(call.url, 'https://api.resend.com/emails')
    assert.equal(call.options.redirect, 'error')
    assert.equal(call.options.headers.authorization, `Bearer ${apiKey}`)
    assert.equal(call.options.headers['idempotency-key'], 'test-batch/1')
    const body = JSON.parse(call.options.body)
    assert.deepEqual(body.to, ['laubsauger@gmail.com'])
    assert.equal(body.from, from)
    assert.match(body.text, /To: victim@example.test/)
    assert.equal(body.subject, 'Brawlock: 1 new feedback report')
    assert.match(body.text, /https:\/\/game.test\/admin.html#feedback/)
    assert.equal(feedback.mailPending(), 0)
    const status = await (await mail.handler(request())).text()
    assert(!status.includes(apiKey)); assert(!status.includes('victim'))
    assert.equal(JSON.parse(status).lastSentAt, 1000)
  } finally { await mail.close() }
})

test('failed or unconfirmed sends retain an identical payload/key despite new reports and retry without exposing provider bodies', async () => {
  let time = 1000, fail = true
  const calls = [], errors = [], feedback = queue(() => time)
  const mail = openFeedbackMail({ origin, feedback, apiKey, from, now: () => time, onError: () => errors.push('failed'), fetcher: async (_url, options) => {
    calls.push(options)
    return fail ? new Response('private provider detail', { status: 429 }) : Response.json({ id: 'confirmed' })
  } })
  try {
    await mail.deliver()
    assert.equal(feedback.mailPending(), 1)
    assert.equal(errors.length, 1)
    const status = await (await mail.handler(request())).text()
    assert(status.includes('HTTP 429')); assert(!status.includes('private provider detail'))
    feedback.reports.push({ id: 'report-two', at: 200, kind: 'feedback', message: 'Arrived later' })
    await mail.deliver(); assert.equal(calls.length, 1)
    time += FEEDBACK_MAIL_INTERVAL; fail = false
    await mail.deliver()
    assert.equal(calls.length, 2)
    assert.equal(calls[0].body, calls[1].body)
    assert.equal(calls[0].headers['idempotency-key'], calls[1].headers['idempotency-key'])
    assert.equal(feedback.mailPending(), 1)
    assert.equal(feedback.reports[0].id, 'report-two')
  } finally { await mail.close() }
})

test('cooldown survives sender restarts through persisted delivery timestamps and invalid receipts never acknowledge reports', async () => {
  let time = 1000, calls = 0
  const feedback = queue(() => time)
  let mail = openFeedbackMail({ origin, feedback, apiKey, from, now: () => time, fetcher: async () => { calls++; return Response.json({ id: 'sent' }) } })
  await mail.deliver(); await mail.close()
  feedback.reports.push({ id: 'report-new', at: 200, kind: 'bug', message: 'New issue' })
  mail = openFeedbackMail({ origin, feedback, apiKey, from, now: () => time, onError: () => {}, fetcher: async () => { calls++; return Response.json({}) } })
  try {
    await mail.deliver(); assert.equal(calls, 1)
    time += FEEDBACK_MAIL_INTERVAL
    await mail.deliver(); assert.equal(calls, 2)
    assert.equal(feedback.mailPending(), 1)
    assert.match((await (await mail.handler(request())).json()).error, /not confirmed/)
  } finally { await mail.close() }
})
