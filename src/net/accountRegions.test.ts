import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_REGIONS_SCHEMA, ACCOUNT_CONTROL_SCHEMA, ACCOUNT_STARTED_SCHEMA, accountRegions } from '../../server/account-regions.mjs'
import { openTestDatabase, removeDir, tempDir } from '../../server/test-dir.mjs'

const cleanups: (() => void)[] = []
afterEach(() => { for (const close of cleanups.reverse()) close(); cleanups.length = 0; vi.restoreAllMocks() })
const users = ['account-first', 'account-second', 'account-third']
const control = (user: string) => ({ device: String(users.indexOf(user) + 1).repeat(64), controller: 'a'.repeat(64), takeover: false })
function withControls(core: ReturnType<typeof accountRegions>) {
  return { ...core, claim: (region: string, instance: string, user: string, room: string, connection = control(user)) => core.claim(region, instance, user, room, connection) }
}

function fixture() {
  const dir = tempDir('brawlock-account-regions-')
  cleanups.push(() => removeDir(dir))
  const file = `${dir}/accounts.sqlite`
  const db = openTestDatabase(file)
  cleanups.push(() => db.close())
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; CREATE TABLE user(id TEXT PRIMARY KEY);')
  db.exec(ACCOUNT_REGIONS_SCHEMA + ACCOUNT_CONTROL_SCHEMA + ACCOUNT_STARTED_SCHEMA)
  for (const user of users) db.prepare('INSERT INTO user(id) VALUES (?)').run(user)
  const regions = withControls(accountRegions(db))
  regions.register('eu', 'instance-eu-1')
  regions.register('us', 'instance-us-1')
  const connect = () => {
    const second = openTestDatabase(file)
    cleanups.push(() => second.close())
    second.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    return withControls(accountRegions(second))
  }
  return { db, regions, connect }
}

describe('global ranked account occupancy', () => {
  it('keeps queue reservations exclusive but offers recovery only for participants in a started match', () => {
    const { regions } = fixture()
    regions.claim('eu', 'instance-eu-1', users[0], 'ABCDE')
    regions.claim('eu', 'instance-eu-1', users[1], 'ABCDE')
    expect(regions.game(users[0])).toEqual({ region: 'eu', room: 'ABCDE' })
    expect(regions.activeGame(users[0])).toBeNull()
    regions.started('us', 'instance-us-1', 'ABCDE', [users[0]])
    expect(regions.activeGame(users[0])).toBeNull()
    regions.started('eu', 'instance-eu-1', 'ABCDE', [users[0]])
    expect(regions.activeGame(users[0])).toEqual({ region: 'eu', room: 'ABCDE' })
    expect(regions.activeGame(users[1])).toBeNull()
    regions.started('eu', 'instance-eu-1', 'ABCDE', [users[0]])
    regions.release('eu', 'instance-eu-1', 'ABCDE', users[0])
    regions.started('eu', 'instance-eu-1', 'ABCDE', [users[0]])
    expect(regions.activeGame(users[0])).toBeNull()
    expect(() => regions.started('eu', 'stale-instance', 'ABCDE', [users[1]])).toThrow(/not current/)
    expect(() => regions.started('eu', 'instance-eu-1', 'ABCDE', [users[1], users[1]])).toThrow(/Invalid/)
  })
  it('blocks two accounts on one browser across regions, including simultaneous pre-authorized claims', () => {
    const { regions, connect } = fixture(), other = connect()
    const browser = control(users[0])
    expect(regions.access(users[0], browser)).toEqual({ ok: true })
    expect(other.access(users[1], browser)).toEqual({ ok: true })
    expect(regions.claim('eu', 'instance-eu-1', users[0], 'ABCDE', browser)).toEqual({ ok: true })
    expect(other.claim('us', 'instance-us-1', users[1], 'FGHIJ', browser)).toEqual({ ok: false, conflict: 'device', game: { region: 'eu', room: 'ABCDE' } })
    expect(other.claim('eu', 'instance-eu-1', users[1], 'ABCDE', { ...browser, takeover: true })).toMatchObject({ ok: false, conflict: 'device' })
    expect(regions.game(users[1])).toBeNull()
  })

  it('requires an explicit transfer to another tab/device and retains every device until the game releases', () => {
    const { regions } = fixture(), original = control(users[0])
    regions.claim('eu', 'instance-eu-1', users[0], 'ABCDE', original)
    const second = { device: 'f'.repeat(64), controller: 'b'.repeat(64), takeover: false }
    expect(regions.claim('eu', 'instance-eu-1', users[0], 'ABCDE', second)).toMatchObject({ ok: false, conflict: 'controller' })
    expect(regions.claim('eu', 'instance-eu-1', users[0], 'ABCDE', { ...second, takeover: true })).toEqual({ ok: true })
    expect(regions.claim('eu', 'instance-eu-1', users[0], 'ABCDE', original)).toMatchObject({ ok: false, conflict: 'controller' })
    expect(regions.claim('us', 'instance-us-1', users[1], 'FGHIJ', original)).toMatchObject({ ok: false, conflict: 'device' })
    expect(regions.claim('us', 'instance-us-1', users[0], 'FGHIJ', { ...second, takeover: true })).toEqual({ ok: false, game: { region: 'eu', room: 'ABCDE' } })
    regions.release('eu', 'instance-eu-1', 'ABCDE', users[0])
    expect(regions.claim('us', 'instance-us-1', users[1], 'FGHIJ', original)).toEqual({ ok: true })
  })

  it('allows a normal reconnect only after the current controller disconnects and fences old disconnect callbacks', () => {
    const { regions } = fixture(), original = control(users[0])
    const second = { ...original, controller: 'b'.repeat(64) }
    regions.claim('eu', 'instance-eu-1', users[0], 'ABCDE', original)
    regions.disconnect('eu', 'instance-eu-1', users[0], 'ABCDE', original.controller)
    expect(regions.claim('eu', 'instance-eu-1', users[0], 'ABCDE', second)).toEqual({ ok: true })
    regions.disconnect('eu', 'instance-eu-1', users[0], 'ABCDE', original.controller)
    expect(regions.access(users[0], original)).toMatchObject({ ok: false, conflict: 'controller' })
    expect(regions.claim('us', 'instance-us-1', users[1], 'FGHIJ', original)).toMatchObject({ ok: false, conflict: 'device' })
  })
  it('allows one reservation globally across authority connections and treats a same-room retry as idempotent', async () => {
    const { regions, connect } = fixture()
    const other = connect()
    const claims = await Promise.all([
      Promise.resolve().then(() => regions.claim('eu', 'instance-eu-1', users[0], 'ABCDE')),
      Promise.resolve().then(() => other.claim('us', 'instance-us-1', users[0], 'FGHIJ')),
    ])
    expect(claims).toEqual([{ ok: true }, { ok: false, game: { region: 'eu', room: 'ABCDE' } }])
    expect(other.claim('eu', 'instance-eu-1', users[0], 'ABCDE')).toEqual({ ok: true })
    expect(regions.claim('eu', 'instance-eu-1', users[0], 'KLMNO')).toEqual({ ok: false, game: { region: 'eu', room: 'ABCDE' } })
    expect(other.game(users[0])).toEqual({ region: 'eu', room: 'ABCDE' })
  })

  it('does not expire occupancy during a partition, even after reopening the database', () => {
    const { regions, connect } = fixture()
    regions.claim('eu', 'instance-eu-1', users[0], 'ABCDE')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 365 * 24 * 60 * 60 * 1000)
    const reopened = connect()
    expect(reopened.game(users[0])).toEqual({ region: 'eu', room: 'ABCDE' })
    expect(reopened.claim('us', 'instance-us-1', users[0], 'FGHIJ')).toEqual({ ok: false, game: { region: 'eu', room: 'ABCDE' } })
  })

  it('registers the same generation harmlessly and fences only the restarted region', () => {
    const { regions } = fixture()
    regions.claim('eu', 'instance-eu-1', users[0], 'ABCDE')
    regions.claim('us', 'instance-us-1', users[1], 'FGHIJ')
    regions.register('eu', 'instance-eu-1')
    expect(regions.game(users[0])).toEqual({ region: 'eu', room: 'ABCDE' })
    regions.register('eu', 'instance-eu-2')
    expect(regions.game(users[0])).toBeNull()
    expect(regions.game(users[1])).toEqual({ region: 'us', room: 'FGHIJ' })
    expect(() => regions.claim('eu', 'instance-eu-1', users[0], 'KLMNO')).toThrow(/not current/)
    expect(() => regions.release('eu', 'instance-eu-1', 'ABCDE')).toThrow(/not current/)
    expect(regions.claim('eu', 'instance-eu-2', users[0], 'KLMNO')).toEqual({ ok: true })
    expect(() => regions.release('eu', 'instance-eu-1', 'KLMNO', users[0])).toThrow(/not current/)
    expect(regions.game(users[0])).toEqual({ region: 'eu', room: 'KLMNO' })
  })

  it('scopes release to the region, generation, room and optional account; repeats are harmless', () => {
    const { regions } = fixture()
    regions.claim('eu', 'instance-eu-1', users[0], 'ABCDE')
    regions.claim('eu', 'instance-eu-1', users[1], 'ABCDE')
    regions.claim('us', 'instance-us-1', users[2], 'ABCDE')
    regions.release('eu', 'instance-eu-1', 'FGHIJ', users[0])
    expect(regions.game(users[0])).toEqual({ region: 'eu', room: 'ABCDE' })
    regions.release('eu', 'instance-eu-1', 'ABCDE', users[0])
    regions.release('eu', 'instance-eu-1', 'ABCDE', users[0])
    expect(regions.game(users[0])).toBeNull()
    expect(regions.game(users[1])).toEqual({ region: 'eu', room: 'ABCDE' })
    regions.release('eu', 'instance-eu-1', 'ABCDE')
    regions.release('eu', 'instance-eu-1', 'ABCDE')
    expect(regions.game(users[1])).toBeNull()
    expect(regions.game(users[2])).toEqual({ region: 'us', room: 'ABCDE' })
  })

  it('validates bounded identities before writes, rolls failed claims back, and preserves caller migration ownership', () => {
    const { db, regions } = fixture()
    for (const args of [
      ['EU', 'instance-eu-1', users[0], 'ABCDE'], ['eu', 'short', users[0], 'ABCDE'],
      ['eu', 'instance-eu-1', 'short', 'ABCDE'], ['eu', 'instance-eu-1', users[0], 'abcde'],
      ['eu', 'instance-eu-1', users[0], 'ABCDEF'], ['eu', 'instance-eu-1', 'x'.repeat(65), 'ABCDE'],
    ]) expect(() => regions.claim(...args as [string, string, string, string])).toThrow(/Invalid/)
    expect(() => regions.claim('eu', 'instance-eu-1', 'unknown-account', 'ABCDE')).toThrow(/does not exist/)
    expect(regions.claim('eu', 'instance-eu-1', users[0], 'ABCDE')).toEqual({ ok: true })
    db.prepare('DELETE FROM user WHERE id = ?').run(users[0])
    expect(regions.game(users[0])).toBeNull()
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 })
  })
})
