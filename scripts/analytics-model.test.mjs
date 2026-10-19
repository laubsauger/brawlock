import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openAnalytics } from '../server/analytics.mjs'
import { createAnalyticsExplorer } from './analytics-model.mjs'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'brawlock-explorer-'))
  let at = Date.parse('2026-10-01T00:00:00Z')
  const stores = Object.fromEntries(['accounts', 'eu', 'us-west'].map((id) => [id, openAnalytics(join(dir, id + '.sqlite'), { now: () => at, serverCommit: id === 'eu' ? 'commit-one' : 'commit-two' })]))
  const time = (value) => { at = Date.parse(value) }
  const beat = (device, accountId, region, build, screen = 'menu', sample) => stores.accounts.presence({ device, accountId, region, build, net: 'net-one', screen, online: 5, sample })
  time('2026-10-18T12:00:00Z'); beat('guest_browser_one', null, 'eu', 'client-one')
  time('2026-10-18T12:00:30Z'); beat('guest_browser_one', null, 'eu', 'client-one')
  time('2026-10-18T13:00:00Z'); beat('guest_browser_one', null, 'us-west', 'client-two')
  time('2026-10-18T14:00:00Z'); beat('guest_browser_two', null, 'us-west', 'client-two', 'lobby')
  const segments = (eu, us) => [{ region: 'eu', build: 'client-two', net: 'net-one', screen: 'match', kind: 'account', people: eu }, { region: 'us-west', build: 'client-two', net: 'net-one', screen: 'match', kind: 'account', people: us }]
  time('2026-10-19T12:00:00Z'); beat('guest_browser_one', 'account000A', 'eu', 'client-two', 'match', segments(2, 3))
  time('2026-10-19T13:00:00Z'); beat('account_browser_three', 'account000A', 'us-west', 'client-two', 'match', segments(3, 1))
  time('2026-10-19T13:00:30Z'); beat('account_browser_three', 'account000A', 'us-west', 'client-two', 'match', segments(3, 1))
  const game = (id, region, queue, build, status, seconds, mode = 'rounds', team = 'ffa') => {
    const devices = queue === 'ranked' ? ['a_account000A', 'a_account000B'] : ['guest_browser_one', 'a_account000A']
    stores[region].start({ id, region, queue, build, room: 'ABCDE', settings: { gameMode: mode, teamMode: team }, devices, bots: 2 })
    if (status === 'completed') stores[region].finish(id, { ticks: seconds * 60, rounds: 2, seats: devices.map((device) => ({ device })) })
    if (status === 'abandoned') stores[region].abandon(id)
  }
  game('match-one', 'eu', 'casual', 'server-one', 'completed', 120)
  game('match-two', 'eu', 'ranked', 'server-two', 'abandoned', 0, 'rounds', 'teams')
  game('match-legacy', 'us-west', 'custom', null, 'running', 0, 'deathmatch')
  stores['us-west'].recover()
  game('match-three', 'us-west', 'ranked', 'server-two', 'completed', 300)
  game('match-four', 'us-west', 'ranked', 'server-two', 'completed', 600)
  game('match-five', 'us-west', 'casual', 'server-two', 'running', 0, 'deathmatch', 'teams')
  const report = () => Object.entries(stores).map(([source, store]) => ({ source, ...store.report(7), ...(source === 'accounts' ? { accounts: { registered: 2, profiles: 2 }, live: { total: 5 } } : { live: { players: 2, rooms: 1, connections: 2 } }) }))
  const reports = report(), explorer = createAnalyticsExplorer(reports)
  const query = (filters = {}, from = '2026-10-13', through = '2026-10-19') => explorer.query({ from, through, filters })
  return { query, reports, report, dir, close() { for (const store of Object.values(stores)) store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('cross-filters regions without summing daily, regional or release visitor uniques', () => {
  const f = fixture()
  try {
    const all = f.query(), eu = f.query({ region: 'eu' }), us = f.query({ region: 'us-west' })
    assert.equal(all.current.guests, 2); assert.equal(all.current.accounts, 1); assert.equal(all.current.browsers, 3)
    assert.equal(eu.current.guests, 1); assert.equal(eu.current.accounts, 1); assert.equal(eu.current.browsers, 1)
    assert.equal(us.current.guests, 2); assert.equal(us.current.accounts, 1); assert.equal(us.current.browsers, 3)
    assert.equal(all.current.started, 6); assert.equal(eu.current.started, 2); assert.equal(us.current.started, 4)
    assert.equal(all.weekly.reduce((n, row) => n + row.accounts, 0), 1)
    assert.equal(all.current.completionRate, 60)
    assert.equal(all.current.averageMinutes, (120 + 300 + 600) / 3 / 60)
    assert.equal(all.current.conversions, 1)
  } finally { f.close() }
})

test('composes match filters and keeps app and game scopes independent', () => {
  const f = fixture()
  try {
    const match = f.query({ region: 'us-west', serverBuild: 'server-two', queue: 'ranked', mode: 'rounds', outcome: 'completed', playerKind: 'account' })
    assert.equal(match.matches.length, 2); assert.equal(match.current.completed, 2)
    assert.equal(match.current.accounts, 1)
    assert.equal(f.query({ clientBuild: 'client-one' }).current.started, 6)
    assert.equal(f.query({ clientBuild: 'client-one' }).current.guests, 1)
    assert.equal(f.query({ serverBuild: '' }).current.started, 1)
    assert.equal(f.query({ screen: 'lobby', identity: 'guest' }).current.guests, 1)
    assert.equal(f.query({ screen: 'lobby' }).current.conversions, null)
    assert.equal(f.query({ region: 'eu', clientBuild: 'client-two' }).current.conversions, 1)
    assert.equal(f.query({ mode: 'deathmatch', outcome: 'completed' }).matches.length, 0)
  } finally { f.close() }
})

test('computes filtered concurrency from simultaneous samples rather than adding peaks', () => {
  const f = fixture()
  try {
    assert.equal(f.query().current.peak, 5)
    assert.equal(f.query({ clientBuild: 'client-two' }).current.peak, 5)
    assert.equal(f.query({ region: 'eu' }).current.peak, 3)
    assert.equal(f.query({ region: 'us-west' }).current.peak, 3)
    assert.equal(f.query({ clientBuild: 'client-one' }).current.peak, 0)
    assert.equal(f.query({ region: 'eu' }, '2026-10-18', '2026-10-18').current.peak, null)
    assert.equal(f.reports.find((r) => r.source === 'accounts').facts.samples.length, 4)
  } finally { f.close() }
})

test('supports custom windows, rejects invalid filters and reports missing version history explicitly', () => {
  const f = fixture()
  try {
    const day = f.query({}, '2026-10-18', '2026-10-18')
    assert.equal(day.days, 1); assert.equal(day.current.accounts, 0); assert.equal(day.current.guests, 2)
    assert.equal(day.previous.from, '2026-10-17'); assert.equal(day.current.started, 0)
    assert.equal(f.query({ serverBuild: '' }).matches[0].build, null)
    assert.throws(() => f.query({ region: 'invented' }), /Unknown analytics filter/)
    assert.throws(() => f.query({}, '2026-02-30', '2026-10-19'), /valid dates/)
    assert.throws(() => f.query({}, '2026-10-12', '2026-10-19'), /exported window/)
  } finally { f.close() }
})

test('report-scoped identity tokens rotate while aggregate counts stay stable and references remain useful', () => {
  const f = fixture()
  try {
    const next = f.report(), first = f.reports.find((r) => r.source === 'accounts'), second = next.find((r) => r.source === 'accounts')
    assert.notEqual(first.facts.traffic[0].person, second.facts.traffic[0].person)
    const db = new DatabaseSync(join(f.dir, 'accounts.sqlite'))
    const hashes = db.prepare('SELECT person FROM visitors').all(); db.close()
    const encoded = JSON.stringify(f.reports)
    for (const raw of ['guest_browser_one', 'guest_browser_two', 'account000A', ...hashes.map((r) => r.person)]) assert.ok(!encoded.includes(raw), raw)
    assert.deepEqual(createAnalyticsExplorer(next).query({ from: '2026-10-13', through: '2026-10-19' }).current, f.query().current)
    assert.equal(f.query().matches.find((m) => m.id === 'match-one').room, 'ABCDE')
    assert.equal(f.query().matches.find((m) => m.id === 'match-one').commit_id, 'commit-one')
  } finally { f.close() }
})
