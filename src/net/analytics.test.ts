import { afterEach, describe, expect, it } from 'vitest'
import { openAnalytics } from '../../server/analytics.mjs'
import { startServer } from '../../server/listen.mjs'
import { openTestDatabase, removeDir, tempDir } from '../../server/test-dir.mjs'
import { DEFAULT_SETTINGS } from '../sim'
import type { FinishedMatch } from './leaderboard'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup.length = 0 })
function fixture(initial = Date.parse('2026-10-19T12:00:00Z')) {
  const dir = tempDir('brawlock-analytics-')
  cleanup.push(() => removeDir(dir))
  let at = initial
  const file = `${dir}/analytics.sqlite`, now = () => at
  const store = openAnalytics(file, { now })
  cleanup.push(() => store.close())
  const beat = (device = 'guest_browser', accountId: string | null = null, region = 'eu') => store.presence({ device, accountId, region, online: 2 })
  return { dir, file, store, now, beat, advance: (ms: number) => { at += ms }, at: (ms: number) => { at = ms } }
}
const finished = (devices: string[]): FinishedMatch => ({ ticks: 1800, rounds: 1, teamMode: 'ffa', gameMode: 'rounds', bots: 2,
  seats: devices.map((device, player) => ({ player, device, name: 'Never stored', roundsPlayed: 1, roundsWon: 0, kills: 0, deaths: 1, won: false })), ranked: [] })

describe('durable first-party analytics', () => {
  it('deduplicates heartbeats, tabs and signed-in devices without conflating guests with accounts', () => {
    const f = fixture()
    f.beat(); f.beat()
    f.advance(30000); f.beat('guest_browser', null, 'us-west')
    f.beat('device_one', 'account_private')
    f.advance(30000); f.beat('device_two', 'account_private')
    const report = f.store.report(1)
    expect(report.visitors).toEqual([{ kind: 'account', seen: 1, new: 1 }, { kind: 'guest', seen: 1, new: 1 }])
    expect(report.daily[0].traffic).toEqual([
      { day: '2026-10-19', kind: 'account', seen: 1, new: 1, sessions: 1, activeMs: 30000 },
      { day: '2026-10-19', kind: 'guest', seen: 1, new: 1, sessions: 1, activeMs: 30000 },
    ])
    expect(report.daily[0].peakOnline).toBe(2)
    expect(report.browsers).toEqual({ seen: 3, new: 3, guestToAccount: 0 })
    const raw = JSON.stringify(report)
    for (const privateValue of ['guest_browser', 'device_one', 'device_two', 'account_private']) expect(raw).not.toContain(privateValue)
  })

  it('links guest activity to verified sign-in without counting another browser, visit or repeat conversion', () => {
    const f = fixture()
    f.beat('shared_browser')
    f.advance(30000); f.beat('shared_browser', 'account_one')
    f.beat('shared_browser', 'account_one')
    f.advance(30000); f.beat('shared_browser')
    f.advance(30000); f.beat('shared_browser', 'account_two')
    const report = f.store.report(1)
    expect(report.browsers).toEqual({ seen: 1, new: 1, guestToAccount: 1 })
    expect(report.visitors).toEqual([{ kind: 'account', seen: 2, new: 2 }, { kind: 'guest', seen: 1, new: 1 }])
    expect(report.daily[0].traffic.reduce((n, row) => n + row.sessions, 0)).toBe(1)
    expect(report.daily[0].traffic.reduce((n, row) => n + row.activeMs, 0)).toBe(90000)
    expect(report.daily[0].browsers).toEqual(report.browsers)
    const db = openTestDatabase(f.file); cleanup.push(() => db.close())
    expect(db.prepare(`SELECT v.kind,COUNT(*) AS links FROM browser_accounts a
      JOIN browsers b ON b.device=a.device JOIN visitors v ON v.person=b.guest_person GROUP BY v.kind`).all()).toEqual([{ kind: 'guest', links: 2 }])
    const stored = JSON.stringify({ browsers: db.prepare('SELECT * FROM browsers').all(), links: db.prepare('SELECT * FROM browser_accounts').all(), report })
    for (const raw of ['shared_browser', 'account_one', 'account_two']) expect(stored).not.toContain(raw)
    f.advance(86400000); f.beat('shared_browser', 'account_one')
    expect(f.store.report(1).browsers).toEqual({ seen: 1, new: 0, guestToAccount: 0 })
    expect(f.store.report(2).browsers.guestToAccount).toBe(1)
  })

  it('keeps links through restart, deduplicates accounts across devices and dates the conversion on sign-in', () => {
    const f = fixture()
    f.at(Date.parse('2026-10-19T23:59:45Z')); f.beat()
    f.advance(30000)
    const reopened = openAnalytics(f.file, { now: f.now }); cleanup.push(() => reopened.close())
    reopened.presence({ device: 'guest_browser', accountId: 'account_one', region: 'eu', online: 1 })
    reopened.presence({ device: 'second_browser', accountId: 'account_one', region: 'eu', online: 1 })
    const report = reopened.report(2)
    expect(report.browsers).toEqual({ seen: 2, new: 2, guestToAccount: 1 })
    expect(report.visitors.find((row) => row.kind === 'account')?.seen).toBe(1)
    expect(report.daily.map((day) => day.browsers.guestToAccount)).toEqual([0, 1])
  })

  it('expands schema one without resetting history, its HMAC secret or inventing old browser links', () => {
    const f = fixture(); f.beat()
    const db = openTestDatabase(f.file)
    const before = db.prepare('SELECT * FROM analytics_meta').get()
    db.exec('DROP TABLE presence_sample_counts; DROP TABLE presence_samples; DROP TABLE traffic_facts; DROP TABLE dimension_meta; ALTER TABLE matches DROP COLUMN build; ALTER TABLE matches DROP COLUMN commit_id; ALTER TABLE matches DROP COLUMN room; DROP TABLE browser_accounts; DROP TABLE browser_activity; DROP TABLE browsers; DROP TABLE browser_meta; PRAGMA user_version=1;')
    db.close()
    f.advance(30000)
    const migrated = openAnalytics(f.file, { now: f.now }); cleanup.push(() => migrated.close())
    expect(migrated.report(1).visitors).toEqual([{ kind: 'guest', seen: 1, new: 1 }])
    expect(migrated.report(1).browsers).toEqual({ seen: 0, new: 0, guestToAccount: 0 })
    expect(migrated.report(1).identityTrackingSince).toBe(f.now())
    migrated.presence({ device: 'guest_browser', accountId: null, region: 'eu', online: 1 })
    expect(migrated.report(1).visitors).toEqual([{ kind: 'guest', seen: 1, new: 1 }])
    const check = openTestDatabase(f.file); cleanup.push(() => check.close())
    expect(check.prepare('SELECT * FROM analytics_meta').get()).toEqual(before)
    expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 })
  })

  it('counts returning visits after 30 minutes without treating the gap as active time', () => {
    const f = fixture()
    f.beat(); f.advance(30000); f.beat()
    f.advance(30 * 60000); f.beat()
    expect(f.store.report(1).daily[0].traffic[0]).toMatchObject({ seen: 1, new: 1, sessions: 2, activeMs: 30000 })
    f.advance(86400000); f.beat()
    expect(f.store.report(1).visitors).toEqual([{ kind: 'guest', seen: 1, new: 0 }])
    expect(f.store.report(1).daily[0].traffic[0]).toMatchObject({ seen: 1, new: 0, sessions: 1, activeMs: 0 })
  })

  it('expands version-two history once, preserving identities and marking old context unrecorded', () => {
    const f = fixture(); f.beat()
    f.store.start({ id: 'legacy-game', region: 'eu', queue: 'custom', settings: DEFAULT_SETTINGS, devices: ['guest_browser'], bots: 1 })
    f.store.finish('legacy-game', finished(['guest_browser']))
    const db = openTestDatabase(f.file)
    const before = db.prepare('SELECT * FROM analytics_meta').get()
    db.exec('DROP TABLE presence_sample_counts; DROP TABLE presence_samples; DROP TABLE traffic_facts; DROP TABLE dimension_meta; ALTER TABLE matches DROP COLUMN build; ALTER TABLE matches DROP COLUMN commit_id; ALTER TABLE matches DROP COLUMN room; ALTER TABLE browsers DROP COLUMN converted_region; ALTER TABLE browsers DROP COLUMN converted_build; PRAGMA user_version=2;')
    db.close()
    f.advance(30000)
    const migrated = openAnalytics(f.file, { now: f.now }); cleanup.push(() => migrated.close())
    const old = migrated.report(1)
    expect(old.facts.traffic).toEqual([expect.objectContaining({ build: '', net: '', screen: '', browser: null, sessions: 1 })])
    expect(old.facts.matches[0]).toMatchObject({ id: 'legacy-game', build: null, commit_id: null, room: null, status: 'completed', seconds: 30 })
    migrated.presence({ device: 'guest_browser', accountId: null, region: 'eu', build: 'new-release', net: 'new-net', screen: 'menu', online: 1 })
    const again = openAnalytics(f.file, { now: f.now }); cleanup.push(() => again.close())
    expect(again.report(1).facts.traffic).toHaveLength(2)
    expect(again.report(1).facts.traffic.reduce((n, row) => n + row.sessions, 0)).toBe(1)
    const check = openTestDatabase(f.file); cleanup.push(() => check.close())
    expect(check.prepare('SELECT * FROM analytics_meta').get()).toEqual(before)
    expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 })
  })

  it('splits heartbeat time across UTC midnight and preserves history through reopen', () => {
    const f = fixture()
    f.at(Date.parse('2026-10-19T23:59:45Z')); f.beat()
    f.advance(30000); f.beat()
    const reopened = openAnalytics(f.file, { now: f.now })
    cleanup.push(() => reopened.close())
    expect(reopened.report(2).daily.map((day) => day.traffic[0].activeMs)).toEqual([15000, 15000])
    f.advance(30000); reopened.presence({ device: 'guest_browser', accountId: null, region: 'eu', online: 1 })
    expect(reopened.report(2).visitors).toEqual([{ kind: 'guest', seen: 1, new: 1 }])
    expect(reopened.report(1).daily[0].traffic[0]).toMatchObject({ activeMs: 45000, sessions: 0, new: 0 })
    const db = openTestDatabase(f.file)
    cleanup.push(() => db.close())
    expect(JSON.stringify(db.prepare('SELECT * FROM visitors').all())).not.toContain('guest_browser')
  })

  it('records short/custom/casual games independently of Elo, including late joins and abandoned games', () => {
    const f = fixture()
    const start = (id: string, queue: 'custom' | 'casual' | 'ranked') => f.store.start({ id, region: 'eu', queue, settings: DEFAULT_SETTINGS, bots: 2, devices: ['guest_browser', 'a_account123'] })
    start('one', 'custom'); f.store.join('one', 'late_guest'); f.store.join('one', 'late_guest')
    f.store.finish('one', finished(['guest_browser', 'a_account123', 'late_guest']))
    expect(() => f.store.finish('one', finished([]))).toThrow('not running')
    start('two', 'casual'); f.store.abandon('two'); f.store.abandon('one')
    start('three', 'ranked')
    const report = f.store.report(1)
    expect(report.matches.find((row) => row.queue === 'custom')).toMatchObject({ started: 1, completed: 1, completedSeconds: 30, abandoned: 0, botSeats: 2 })
    expect(report.matches.find((row) => row.queue === 'casual')).toMatchObject({ started: 1, abandoned: 1 })
    expect(report.matches.find((row) => row.queue === 'ranked')).toMatchObject({ started: 1, running: 1 })
    expect(report.participation.find((row) => row.queue === 'custom' && row.kind === 'guest')).toMatchObject({ uniquePlayers: 2, participations: 2 })
    expect(report.participation.find((row) => row.queue === 'custom' && row.kind === 'account')).toMatchObject({ uniquePlayers: 1, participations: 1 })
    expect(JSON.stringify(report)).not.toContain('Never stored')
    f.store.recover()
    expect(f.store.report(1).matches.find((row) => row.queue === 'ranked')).toMatchObject({ running: 0, interrupted: 1 })
  })

  it('validates date windows and refuses unknown persistent schemas', () => {
    const f = fixture()
    for (const days of [0, -1, 1.5, 366, NaN]) expect(() => f.store.report(days)).toThrow('days')
    expect(f.store.report(7).daily).toHaveLength(7)
    const file = `${f.dir}/future.sqlite`, db = openTestDatabase(file)
    db.exec('PRAGMA user_version=99'); db.close()
    expect(() => openAnalytics(file)).toThrow('Unsupported analytics schema')
  })

  it('deduplicates weekly and selected-range identities and compares the exact preceding UTC dates', () => {
    const f = fixture(Date.parse('2026-10-04T00:00:00Z'))
    for (let day = 5; day <= 18; day++) {
      f.at(Date.parse(`2026-10-${String(day).padStart(2, '0')}T12:00:00Z`))
      f.beat('repeated_guest'); f.beat('account_device_one', 'verified_account')
      f.beat('account_device_two', 'verified_account')
      if (day === 18) f.beat('brand_new_guest')
    }
    const period = f.store.report(30).series.find((r) => r.days === 7)!
    expect(period.current).toMatchObject({ from: '2026-10-12', through: '2026-10-18', guests: 2, accounts: 1, newGuests: 1, newAccounts: 0, visits: 15, coverage: 'complete' })
    expect(period.previous).toMatchObject({ from: '2026-10-05', through: '2026-10-11', guests: 1, accounts: 1, visits: 14, coverage: 'complete' })
    expect(period.weekly).toHaveLength(1)
    expect(period.weekly[0]).toMatchObject({ period: '2026-10-12', guests: 2, accounts: 1, visits: 15, peak: 2 })
    expect(period.daily.reduce((n, row) => n + row.guests, 0)).toBe(8)
  })

  it('clips edge weeks to the selected range and marks missing comparison history', () => {
    const f = fixture(Date.parse('2026-10-13T00:00:00Z'))
    f.beat('only_outside_window')
    f.at(Date.parse('2026-10-15T12:00:00Z')); f.beat('shared_guest')
    f.at(Date.parse('2026-10-18T12:00:00Z')); f.beat('middle_guest')
    f.at(Date.parse('2026-10-20T12:00:00Z')); f.beat('shared_guest')
    f.at(Date.parse('2026-10-21T12:00:00Z')); f.beat('new_guest')
    const period = f.store.report(30).series.find((r) => r.days === 7)!
    expect(period.current).toMatchObject({ guests: 3, from: '2026-10-15', through: '2026-10-21', coverage: 'complete' })
    expect(period.previous.coverage).toBe('partial')
    expect(period.weekly).toEqual([
      expect.objectContaining({ period: '2026-10-12', from: '2026-10-15', through: '2026-10-18', guests: 2 }),
      expect.objectContaining({ period: '2026-10-19', from: '2026-10-19', through: '2026-10-21', guests: 2 }),
    ])
    expect(f.store.report(30).series.find((r) => r.days === 30)!.previous.coverage).toBe('none')
  })

  it('protects regional reports and leaves live matches intact when a duplicate process cannot bind', async () => {
    const f = fixture(), token = 'test-analytics-operator-token-0123456789'
    const server = await startServer({ port: 0, dataDir: f.dir, config: { region: 'eu' }, log: () => {}, maintenanceToken: token, clock: f.now })
    cleanup.push(() => server.close())
    f.store.start({ id: 'running', region: 'eu', queue: 'custom', settings: DEFAULT_SETTINGS, devices: ['guest_browser'], bots: 1 })
    const endpoint = `http://127.0.0.1:${server.port}/internal/analytics`
    const headers = { authorization: `Bearer ${token}` }
    expect((await fetch(endpoint)).status).toBe(403)
    expect((await fetch(endpoint, { headers: { ...headers, origin: 'https://game.example' } })).status).toBe(403)
    expect((await fetch(endpoint, { method: 'POST', headers })).status).toBe(405)
    expect((await fetch(endpoint + '?days=0', { headers })).status).toBe(400)
    const response = await fetch(endpoint + '?days=1', { headers })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ source: 'eu', matches: [{ running: 1 }], live: { players: 0 } })
    await expect(startServer({ port: server.port, dataDir: f.dir, config: { region: 'eu' }, log: () => {}, maintenanceToken: token, clock: f.now })).rejects.toThrow()
    expect(f.store.report(1).matches[0]).toMatchObject({ running: 1, interrupted: 0 })
  })
})
