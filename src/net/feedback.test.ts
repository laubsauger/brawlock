import { afterEach, describe, expect, it, vi } from 'vitest'
import { openFeedback, type FeedbackOptions } from '../../server/feedback.mjs'
import { openTestDatabase, removeDir, tempDir } from '../../server/test-dir.mjs'
import { FEEDBACK_BODY_BYTES, FEEDBACK_IMAGE_BYTES, validFeedbackSubmission, type FeedbackSubmission } from './feedback'

const { statSync } = await vi.importActual<{ statSync(path: string): { mode: number } }>('node:fs')
const randomUUID = () => crypto.randomUUID()

const origin = 'http://localhost:5352'
const token = 'test-feedback-operator-token-0123456789'
const cleanups: (() => void)[] = []
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close() })
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
const jpeg = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAH/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdAAr/2Q=='
function submission(): FeedbackSubmission {
  return { id: randomUUID(), kind: 'bug', message: 'Fireball aiming stops after opening the scoreboard.', context: {
    version: 1, capturedAt: 1000, release: '0.1.0-alpha.6', build: 'dev-feedback', netcode: 'net-ab123', screen: 'match', panel: 'scoreboard',
    device: { userAgent: 'Test browser', language: 'en-US', width: 1280, height: 720, dpr: 2, touch: false, cores: 8, memory: 8, online: true },
    settings: { quality: 'high', muted: false, castMode: 'release', fxIntensity: 1 },
    connection: { role: 'client', transport: 'server', region: 'eu', room: 'ABCDE', ranked: true, quick: true, rttMs: 64, lossPct: 1, peers: 1 },
    render: { backend: 'webgpu', fps: 60, frameMs: 16.7, drawCalls: 150, triangles: 40_000, textures: 4 },
    game: { tick: 3600, round: 2, phase: 'fight', players: 8, humans: 2, bots: 6, alive: 5,
      rules: { teamMode: 'ffa', gameMode: 'rounds', rankedRounds: 5, startGold: 45, shopSeconds: 30 } },
    recentEvents: [{ tick: 3599, type: 'cast', actor: 0, spell: 'fireball' }, { tick: 3600, type: 'damage', target: 1, value: 20 }],
    errors: [{ at: 999, name: 'Error', message: 'Test rendering failure', stack: 'Error: Test rendering failure\n    at render (https://play.test/assets/main.js:2:3)' }],
  } }
}
function fixture({ file = ':memory:', getAccount }: { file?: string; getAccount?: FeedbackOptions['getAccount'] } = {}) {
  let time = 1000
  let service = openFeedback(file, { origin, token, getAccount, now: () => time })
  cleanups.push(() => service.close())
  const post = (body: unknown = submission(), headers: Record<string, string> = {}, options: RequestInit = {}) => service.handler(new Request(`${origin}/api/feedback`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-brawlock-client-ip': '127.0.0.10', ...headers },
    body: JSON.stringify(body), ...options,
  }))
  const inbox = (path = '', headers: Record<string, string> = {}) => service.handler(new Request(`${origin}/internal/feedback${path}`, {
    headers: { authorization: `Bearer ${token}`, ...headers },
  }))
  return { post, inbox, mailDelivery: (build: Parameters<typeof service.mailDelivery>[0]) => service.mailDelivery(build), completeMail: (key: string) => service.completeMail(key), lastMailedAt: () => service.lastMailedAt(), mailBatch: () => service.mailBatch(), markMailed: (ids: string[]) => service.markMailed(ids), mailPending: () => service.mailPending(), handler: (request: Request) => service.handler(request), time: (value: number) => { time = value },
    reopen() { service.close(); service = openFeedback(file, { origin, token, getAccount, now: () => time }) } }
}

describe('first-party feedback contract', () => {
  it('accepts bounded diagnostics and rejects arbitrary identity, settings, state and log fields', () => {
    expect(validFeedbackSubmission(submission())).toBe(true)
    const mutations: ((s: FeedbackSubmission) => unknown)[] = [
      (s) => ({ ...s, accountId: 'spoofed-account' }),
      (s) => ({ ...s, context: { ...s.context, device: { ...s.context.device, deviceId: 'private-browser' } } }),
      (s) => ({ ...s, context: { ...s.context, settings: { ...s.context.settings, playerName: 'private-name' } } }),
      (s) => ({ ...s, context: { ...s.context, connection: { ...s.context.connection, authorization: 'Bearer private' } } }),
      (s) => ({ ...s, context: { ...s.context, game: { ...s.context.game, pawns: [] } } }),
      (s) => ({ ...s, context: { ...s.context, game: { ...s.context.game, ownBuild: {
        slots: ['fireball', 'scourge', ...Array(10).fill(null)], levels: [1, 1, ...Array(10).fill(0)],
        masteries: { duration: 0, range: 0, lifesteal: 0, profileId: 'private-id' },
      } } } }),
      (s) => ({ ...s, context: { ...s.context, recentEvents: [{ ...s.context.recentEvents[0], message: 'arbitrary console log' }] } }),
      (s) => ({ ...s, context: { ...s.context, errors: [{ ...s.context.errors[0], cookie: 'private' }] } }),
      (s) => ({ ...s, context: { ...s.context, recentEvents: Array(51).fill(s.context.recentEvents[0]) } }),
      (s) => ({ ...s, context: { ...s.context, errors: Array(9).fill(s.context.errors[0]) } }),
      (s) => ({ ...s, context: { ...s.context, errors: [{ ...s.context.errors[0], stack: Array(9).fill('frame').join('\n') }] } }),
      (s) => ({ ...s, contactEmail: 'bad\r\naddress@example.com' }),
      (s) => ({ ...s, message: '  ' }),
      (s) => ({ ...s, message: 'x'.repeat(5001) }),
    ]
    for (const mutate of mutations) {
      expect(validFeedbackSubmission(mutate(submission()))).toBe(false)
    }
  })
})

describe('private feedback inbox', () => {
  it('accepts guests and derives account identity only from the verified session lookup', async () => {
    const f = fixture({ getAccount: async (request) => request.headers.get('cookie') === 'session=verified' ? { id: 'verified-account' } : null })
    const guest = submission()
    expect((await f.post(guest)).status).toBe(201)
    expect(await (await f.inbox(`/${guest.id}`)).json()).toMatchObject({ id: guest.id, accountId: null, receivedAt: 1000 })
    const account = { ...submission(), contactEmail: 'player@example.com' }
    expect((await f.post(account, { cookie: 'session=verified' })).status).toBe(201)
    expect(await (await f.inbox(`/${account.id}`)).json()).toMatchObject({ accountId: 'verified-account', contactEmail: 'player@example.com' })
    expect((await f.post({ ...submission(), accountId: 'spoofed' })).status).toBe(400)
    expect((await f.handler(new Request(`${origin}/api/feedback`))).status).toBe(405)
  })

  it('enforces first-party origin, JSON, trusted IP and bounded actual streamed body size', async () => {
    const f = fixture()
    expect((await f.post(submission(), { origin: 'https://other.test' })).status).toBe(403)
    expect((await f.post(submission(), { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await f.post(submission(), { 'x-brawlock-client-ip': '' })).status).toBe(400)
    expect((await f.post(submission(), {}, { body: '{' })).status).toBe(400)
    expect((await f.post(submission(), { 'content-length': String(FEEDBACK_BODY_BYTES + 1) })).status).toBe(413)
    expect((await f.post({ ...submission(), message: 'x'.repeat(FEEDBACK_BODY_BYTES) }, { 'content-length': '1' })).status).toBe(413)
  })

  it('does not turn a failed account verification into an anonymous report', async () => {
    const f = fixture({ getAccount: async () => { throw new Error('private authentication detail') } })
    const report = submission()
    const failure = await f.post(report)
    expect(failure.status).toBe(500)
    expect(await failure.text()).not.toContain('private authentication detail')
    expect((await (await f.inbox()).json()).reports).toEqual([])
  })

  it('stores PNG and JPEG screenshots atomically and rejects signature, dimension and size lies', async () => {
    const f = fixture()
    for (const [mime, data] of [['image/png', png], ['image/jpeg', jpeg]]) {
      const report = { ...submission(), screenshot: { mime, data, width: 1, height: 1 } }
      expect((await f.post(report)).status).toBe(201)
      expect((await (await f.inbox(`/${report.id}`)).json()).screenshot).toEqual(report.screenshot)
    }
    for (const screenshot of [
      { mime: 'image/jpeg', data: png, width: 1, height: 1 },
      { mime: 'image/png', data: png, width: 2, height: 1 },
      { mime: 'image/png', data: png, width: 1601, height: 1 },
      { mime: 'image/png', data: btoa('\0'.repeat(FEEDBACK_IMAGE_BYTES + 1)), width: 1, height: 1 },
      { mime: 'image/png', data: png.slice(0, -1), width: 1, height: 1 },
    ]) {
      const report = { ...submission(), screenshot }
      expect((await f.post(report, { 'x-brawlock-client-ip': randomUUID() })).status).toBe(400)
      expect((await f.inbox(`/${report.id}`)).status).toBe(404)
    }
  })

  it('deduplicates stable IDs and key order, conflicts on changed content, and does not throttle successful retries', async () => {
    const f = fixture()
    const report = submission()
    const first = await f.post(report)
    expect(first.status).toBe(201)
    const receipt = await first.json()
    expect((await f.post(submission())).status).toBe(201)
    expect((await f.post(submission())).status).toBe(201)
    expect((await f.post(submission())).status).toBe(429)
    const retry = await f.post(Object.fromEntries(Object.entries(report).reverse()))
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual(receipt)
    expect((await f.post({ ...report, message: 'A different report.' })).status).toBe(409)
    expect((await (await f.inbox()).json()).reports).toHaveLength(3)
    f.time(1000 + 720_000)
    expect((await f.post(submission())).status).toBe(201)
  })

  it('requires private bearer authentication without browser Origin and paginates same-time reports without image blobs', async () => {
    const f = fixture()
    const reports = Array.from({ length: 3 }, () => ({ ...submission(), screenshot: { mime: 'image/png', data: png, width: 1, height: 1 } }))
    for (const report of reports) expect((await f.post(report)).status).toBe(201)
    expect((await f.inbox('', { authorization: 'Bearer incorrect' })).status).toBe(403)
    expect((await f.inbox('', { origin })).status).toBe(403)
    expect((await f.inbox(`/${reports[0].id}`, { origin })).status).toBe(403)
    expect((await f.inbox('?limit=101')).status).toBe(400)
    expect((await f.inbox('?limit=1&limit=2')).status).toBe(400)
    expect((await f.inbox('?before=invalid')).status).toBe(400)
    const first = await (await f.inbox('?limit=2')).json()
    expect(first.reports).toHaveLength(2)
    expect(first.nextBefore).toBeTruthy()
    expect(JSON.stringify(first)).not.toMatch(/context|"data"|iVBORw|fingerprint/)
    const second = await (await f.inbox(`?limit=2&before=${encodeURIComponent(first.nextBefore)}`)).json()
    expect(second.reports).toHaveLength(1)
    expect(second.nextBefore).toBeNull()
    expect(new Set([...first.reports, ...second.reports].map((r) => r.id))).toEqual(new Set(reports.map((r) => r.id)))
    expect((await f.handler(new Request(`${origin}/api/feedback/${reports[0].id}`))).status).toBe(404)
  })

  it('persists reports, screenshot bytes and receipts across restart with private file permissions', async () => {
    const dir = tempDir('brawlock-feedback-')
    cleanups.push(() => removeDir(dir))
    const file = `${dir}/feedback.sqlite`
    const f = fixture({ file })
    const report = { ...submission(), screenshot: { mime: 'image/png', data: png, width: 1, height: 1 } }
    const before = await (await f.post(report)).json()
    f.reopen()
    expect((await f.post(report)).status).toBe(200)
    expect(await (await f.post(report)).json()).toEqual(before)
    expect((await (await f.inbox(`/${report.id}`)).json()).screenshot.data).toBe(png)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('keeps undelivered reports queued across restart and records confirmed delivery without changing schema 1', async () => {
    const dir = tempDir('brawlock-feedback-mail-')
    cleanups.push(() => removeDir(dir))
    const file = `${dir}/feedback.sqlite`, f = fixture({ file })
    const first = submission(), second = submission()
    expect((await f.post(first)).status).toBe(201)
    expect((await f.post(second)).status).toBe(201)
    expect(f.mailPending()).toBe(2)
    f.reopen()
    expect(f.mailBatch().map((row) => row.id).sort()).toEqual([first.id, second.id].sort())
    f.markMailed([first.id]); f.markMailed([first.id])
    f.reopen()
    expect(f.mailBatch().map((row) => row.id)).toEqual([second.id])
    expect((await f.inbox(`/${first.id}`)).status).toBe(200)
    const db = openTestDatabase(file)
    try { expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 }) } finally { db.close() }
  })

  it('persists the exact email batch across restart and new arrivals, and acknowledges all included reports atomically', async () => {
    const dir = tempDir('brawlock-feedback-outbox-')
    cleanups.push(() => removeDir(dir))
    const file = `${dir}/feedback.sqlite`, f = fixture({ file })
    const first = submission(), second = submission()
    await f.post(first)
    const build = (reports: { message: string }[]) => ({ from: 'Brawlock <feedback@notify.test>', to: ['operator@example.test'], subject: 'Private digest', text: reports.map((r) => r.message).join('\n') })
    const batch = f.mailDelivery(build)!
    await f.post(second)
    f.reopen()
    expect(f.mailDelivery(() => { throw new Error('An existing batch must not be rebuilt') })).toEqual(batch)
    const db = openTestDatabase(file)
    try {
      db.exec("CREATE TRIGGER reject_mail BEFORE INSERT ON feedback_delivery BEGIN SELECT RAISE(ABORT,'test storage failure'); END;")
      expect(() => f.completeMail(batch.key)).toThrow()
      expect(f.mailPending()).toBe(2)
      expect(f.mailDelivery(build)).toEqual(batch)
      db.exec('DROP TRIGGER reject_mail')
      f.completeMail(batch.key)
      expect(f.mailPending()).toBe(1)
      expect(f.lastMailedAt()).toBe(1000)
      expect(f.mailDelivery(build)!.key).not.toBe(batch.key)
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
    } finally { db.close() }
  })

  it('rolls back the report and blob on storage failure, returning no private error details', async () => {
    const dir = tempDir('brawlock-feedback-failure-')
    cleanups.push(() => removeDir(dir))
    const file = `${dir}/feedback.sqlite`
    const f = fixture({ file })
    const db = openTestDatabase(file)
    cleanups.push(() => db.close())
    db.exec("CREATE TRIGGER fail_feedback BEFORE INSERT ON feedback BEGIN SELECT RAISE(ABORT,'private storage detail'); END;")
    const report = { ...submission(), screenshot: { mime: 'image/png', data: png, width: 1, height: 1 } }
    const failure = await f.post(report)
    expect(failure.status).toBe(500)
    expect(await failure.text()).not.toContain('private storage detail')
    expect(db.prepare('SELECT COUNT(*) AS n FROM feedback').get()).toMatchObject({ n: 0 })
    db.exec('DROP TRIGGER fail_feedback')
    expect((await f.post(report)).status).toBe(201)
    expect(db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE screenshot IS NOT NULL').get()).toMatchObject({ n: 1 })
  })

  it('refuses unknown schema versions without changing existing records', () => {
    const dir = tempDir('brawlock-feedback-schema-')
    cleanups.push(() => removeDir(dir))
    const file = `${dir}/feedback.sqlite`
    const db = openTestDatabase(file)
    db.exec('CREATE TABLE legacy(value TEXT); INSERT INTO legacy VALUES (\'keep\'); PRAGMA user_version=99;')
    expect(() => openFeedback(file, { origin, token })).toThrow('Unsupported feedback schema version')
    expect(db.prepare('SELECT value FROM legacy').get()).toMatchObject({ value: 'keep' })
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 99 })
    db.close()
  })
})
