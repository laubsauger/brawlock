import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderAnalytics } from './analytics-report.mjs'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

function fixture() {
  const base = { version: 3, dimensionTrackingSince: 1792411200000, facts: { from: '2026-10-18', through: '2026-10-19', traffic: [], browsers: [], matches: [], samples: [], peaks: [] }, identityTrackingSince: 1792411200000, browsers: { seen: 0, new: 0, guestToAccount: 0 }, generatedAt: 1792411200000, trackingSince: 1792411200000, days: 1, from: '2026-10-19', through: '2026-10-19', visitors: [], lifetimeVisitors: [], matches: [], participation: [],
    daily: [{ day: '2026-10-19', browsers: { seen: 0, new: 0, guestToAccount: 0 }, traffic: [], peakOnline: 0, matches: { day: '2026-10-19', started: 0, completed: 0, abandoned: 0, interrupted: 0 } }] }
  const chartCounts = { guests: 0, accounts: 0, newGuests: 0, newAccounts: 0, visits: 0, minutes: 0, peak: 0,
    started: 0, completed: 0, abandoned: 0, interrupted: 0, running: 0, completedSeconds: 0, completedRounds: 0,
    from: '2026-10-19', through: '2026-10-19', coverage: 'partial' }
  base.series = [{ days: 1, current: chartCounts, previous: { ...chartCounts, from: '2026-10-18', through: '2026-10-18', coverage: 'none' }, daily: [{ ...chartCounts, period: '2026-10-19' }], weekly: [{ ...chartCounts, period: '2026-10-19' }] }]
  return { reports: [
    { ...base, source: 'accounts', live: { total: 0 }, accounts: { registered: 0, profiles: 0 } },
    { ...base, source: 'eu', live: { players: 0, rooms: 0, connections: 0 } },
  ] }
}

test('empty history renders without inventing people, percentages or average durations', () => {
  const html = renderAnalytics(fixture())
  assert.match(html, /Matching games/)
  assert.doesNotMatch(html.split('<script')[0], /NaN|Infinity|undefined|DEMO DATA/)
  assert.match(html, /Visitor activity/)
  assert.match(html, /Browsers seen/)
  assert.match(html, /Guest → sign-in/)
})

test('a missing or mismatched source fails instead of silently showing incomplete totals', () => {
  const snapshot = fixture()
  assert.throws(() => renderAnalytics({ reports: snapshot.reports.slice(1) }), /Expected account and regional/)
  snapshot.reports[1].from = '2026-10-18'
  assert.throws(() => renderAnalytics(snapshot), /same date range/)
})

test('filter controls and safe inline data are included; snapshots without exact facts are rejected', () => {
  const snapshot = fixture()
  snapshot.reports[1].source = '</script><script>alert(1)</script>'
  const html = renderAnalytics(snapshot)
  for (const id of ['ranges', 'grouping', 'visitors-chart', 'games-chart', 'peak-chart']) assert.match(html, new RegExp(`id="${id}"`))
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/)
  delete snapshot.reports[0].facts
  assert.throws(() => renderAnalytics(snapshot), /collect a new report/)
})

test('reports linked browser counts and guest-to-sign-in transitions without adding identity groups together', () => {
  const snapshot = fixture(), account = snapshot.reports[0]
  account.browsers = { seen: 1, new: 1, guestToAccount: 1 }
  account.visitors = [{ kind: 'guest', seen: 1, new: 1 }, { kind: 'account', seen: 1, new: 1 }]
  account.daily[0].browsers = { ...account.browsers }
  const html = renderAnalytics(snapshot)
  const payload = JSON.parse(html.match(/<script id="analytics-data" type="application\/json">(.*?)<\/script>/s)[1])
  assert.deepEqual(payload.find((r) => r.source === 'accounts').browsers, { seen: 1, new: 1, guestToAccount: 1 })
  assert.match(html, /without merging them/)
  assert.doesNotMatch(html, /A guest who signs in can appear/)
  snapshot.reports[0].version = 1
  assert.throws(() => renderAnalytics(snapshot), /Expected account and regional/)
})

test('completed and abandoned games form the resolution rate; running games remain separate', () => {
  const snapshot = fixture()
  snapshot.reports[1].matches = [{ region: '<script>bad</script>', queue: 'casual', started: 4, completed: 2, abandoned: 1, interrupted: 0, running: 1, completedSeconds: 600, completedRounds: 4, botSeats: 8 }]
  const html = renderAnalytics({ ...snapshot, demo: true })
  assert.match(html, /Match outcome/)
  assert.match(html, /DEMO DATA/)
  assert.match(html, /\\u003cscript>bad\\u003c\/script>/)
  assert.doesNotMatch(html, /<script>bad/)
})

test('the report command writes private standalone files and preserves the last report on incomplete input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brawlock-report-'))
  try {
    const input = join(dir, 'input.json'), output = join(dir, 'output')
    writeFileSync(input, JSON.stringify(fixture()))
    const cli = new URL('./analytics.mjs', import.meta.url)
    const run = () => spawnSync(process.execPath, [cli.pathname, '--input', input, '--out', output], { encoding: 'utf8' })
    assert.equal(run().status, 0)
    const html = readFileSync(join(output, 'index.html'), 'utf8')
    assert.match(html, /What’s happening in the arena/)
    assert.deepEqual(JSON.parse(readFileSync(join(output, 'report.json'), 'utf8')), fixture())
    assert.equal(statSync(join(output, 'report.json')).mode & 0o777, 0o600)
    writeFileSync(input, JSON.stringify({ reports: fixture().reports.slice(0, 1) }))
    const failed = run()
    assert.equal(failed.status, 1)
    assert.match(failed.stderr, /Expected account and regional/)
    assert.equal(readFileSync(join(output, 'index.html'), 'utf8'), html)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
