import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openMonitoring, fetchMonitoring, startMonitoring } from './monitoring.mjs'
import { linuxCounters } from './machine-monitor.mjs'
import { createAdmin } from './admin.mjs'

const region = { id: 'eu', label: 'Europe', origin: 'https://eu.test' }
const sample = { version: 1, region: 'eu', at: 10, release: { version: '0.1.0-test' }, hostCpuPeakPct: 75, processCpuPeakPct: 120,
  rooms: [{ humans: 2, bots: 6 }], players: 2, perf: { rssMb: 120 }, links: { rttP95Ms: 160, lossMaxPct: 2 } }

test('monitoring survives reopen, retains missing samples, bounds history and expires old samples', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brawlock-monitor-')), file = join(dir, 'monitoring.sqlite')
  let store = openMonitoring(file)
  try {
    store.record('eu', 10_000, { ok: true, sample })
    store.record('eu', 20_000, { ok: false, error: 'Unavailable' })
    let view = store.read(1, 30_000)
    assert.equal(view.history[0].hostCpu, 75)
    assert.equal(view.history[0].players, 2)
    assert.equal(view.history[0].bots, 6)
    assert.equal(view.history[1].ping, null)
    assert.equal(view.history[1].failures, 1)
    assert.equal(view.latest.eu.ok, false)
    assert.equal(statSync(file).mode & 0o777, 0o600)
    store.close(); store = openMonitoring(file)
    assert.equal(store.read(1, 30_000).history.length, 2)
    store.record('eu', 8 * 86400_000, { ok: true, sample })
    view = store.read(168, 8 * 86400_000)
    assert.equal(view.history.length, 1)
    assert(view.grain >= 168 * 3600_000 / 360)
  } finally { store.close(); rmSync(dir, { recursive: true }) }
})

test('regional collection is authenticated, fixed-destination and refuses redirects/HTTP/mismatched payloads', async () => {
  let seen
  const fetcher = async (url, options) => { seen = { url: String(url), options }; return Response.json(sample) }
  await fetchMonitoring(region, 'private-test-token', { fetcher })
  assert.equal(seen.url, 'https://eu.test/internal/monitoring')
  assert.equal(seen.options.redirect, 'error')
  assert.equal(seen.options.headers.authorization, 'Bearer private-test-token')
  await assert.rejects(fetchMonitoring({ ...region, origin: 'http://eu.test' }, 'token', { fetcher }), /HTTPS/)
  await assert.rejects(fetchMonitoring(region, 'token', { fetcher: async () => Response.json({ ...sample, region: 'other' }) }), /Incompatible/)
  await assert.rejects(fetchMonitoring(region, 'token', { fetcher: async () => new Response('bad', { status: 503 }) }), /HTTP 503/)
})

test('collector runs without viewers, avoids overlapping polls and records region outages without fake zeros', async () => {
  let release, calls = 0
  const records = []
  const held = new Promise((resolve) => { release = resolve })
  const collector = startMonitoring({ store: { record: (...args) => records.push(args) }, regions: [region], token: 'test-region-token-'.repeat(3), appOrigin: 'https://game.test', localSample: () => ({ online: { total: 1 } }),
    fetcher: async () => { calls++; await held; return new Response('down', { status: 503 }) }, interval: 100000 })
  const first = collector.poll(), second = collector.poll()
  assert.equal(first, second)
  assert.equal(calls, 1)
  release(); await first
  assert.equal(records[0][0], 'eu')
  assert.equal(records[0][2].ok, false)
  assert.equal(records[0][2].sample, undefined)
  assert.equal(records[1][0], 'accounts')
  assert.equal(collector.website().ok, false)
  await collector.close()
})

test('Linux host counters do not double-count guest time and include steal / available memory', () => {
  assert.deepEqual(linuxCounters('cpu  10 2 3 70 5 1 1 8 4 1\n', 'MemAvailable: 524288 kB\n'), { total: 100, idle: 75, steal: 8, availableMb: 512 })
  assert.throws(() => linuxCounters('bad', 'bad'), /Invalid/)
})

test('all dashboard routes require server-verified admin access and block cross-origin reads and writes', async () => {
  let identity = null, reads = 0
  const handle = createAdmin({ accounts: { admin: async () => identity }, store: { read: () => { reads++; return {} } }, collector: { website: () => null }, regions: [region], origin: 'https://game.test', token: 'private-token' })
  for (const path of ['session', 'monitoring', 'feedback', 'activity', 'mail', 'players']) {
    assert.equal((await handle(new Request(`https://game.test/api/admin/${path}`))).status, 401)
    identity = false
    assert.equal((await handle(new Request(`https://game.test/api/admin/${path}`))).status, 403)
    identity = null
  }
  assert.equal(reads, 0)
  identity = { email: 'admin@example.test' }
  assert.equal((await handle(new Request('https://game.test/api/admin/monitoring', { headers: { origin: 'https://evil.test' } }))).status, 403)
  assert.equal((await handle(new Request('https://game.test/api/admin/monitoring?hours=999'))).status, 400)
  const response = await handle(new Request('https://game.test/api/admin/monitoring?hours=24'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(reads, 1)
  assert.equal((await handle(new Request('https://game.test/api/admin/monitoring', { method: 'POST' }))).status, 405)
})

test('player board names accounts canonically and never sends raw identities to the browser', async () => {
  const authority = { id: 'us-west', label: 'US West', origin: 'https://us.test', globalAuthority: true }
  let seen
  const row = (device, name, seconds) => ({ device, name, matches: 2, wins: 1, forfeits: 0, seconds, kills: 3, deaths: 2,
    queues: { ranked: 0, casual: 2, custom: 0 }, days: 1, firstAt: 1, lastAt: 2 })
  const fetcher = async (url, options) => {
    seen = { url: String(url), options }
    return Response.json({ since: 0, until: 9, historySince: 1, players: [row('guest-browser-secret', 'Ash', 60), row('a_account12345', 'OldName', 600), row('a_deleted12345', 'Gone', 30)] })
  }
  const handle = createAdmin({ accounts: { admin: async () => ({ email: 'admin@example.test' }), profileNames: (ids) => new Map(ids.map((id) => [id, id === 'account12345' ? 'Renamed' : null])) },
    regions: [region, authority], origin: 'https://game.test', token: 'private-token', fetcher })
  assert.equal((await handle(new Request('https://game.test/api/admin/players?days=365'))).status, 400)
  const response = await handle(new Request('https://game.test/api/admin/players?days=7'))
  assert.equal(response.status, 200)
  // only the global authority holds the match history
  assert.equal(seen.url, 'https://us.test/internal/players?days=7')
  assert.equal(seen.options.headers.authorization, 'Bearer private-token')
  const body = await response.json()
  // a rename shows the current name; a deleted account keeps its last in-game name
  assert.deepEqual(body.players.map((p) => [p.name, p.kind]), [['Renamed', 'account'], ['Ash', 'guest'], ['Gone', 'account']])
  assert.doesNotMatch(JSON.stringify(body), /device|guest-browser-secret|account12345/)
  const down = createAdmin({ accounts: { admin: async () => ({ email: 'admin@example.test' }) }, regions: [authority], origin: 'https://game.test', token: 't', fetcher: async () => new Response('down', { status: 503 }) })
  assert.equal((await down(new Request('https://game.test/api/admin/players?days=7'))).status, 503)
})
