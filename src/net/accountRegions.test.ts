import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_REGIONS_SCHEMA, accountRegions } from '../../server/account-regions.mjs'
import { openTestDatabase, removeDir, tempDir } from '../../server/test-dir.mjs'

const cleanups: (() => void)[] = []
afterEach(() => { for (const close of cleanups.reverse()) close(); cleanups.length = 0; vi.restoreAllMocks() })
const users = ['account-first', 'account-second', 'account-third']

function fixture() {
  const dir = tempDir('brawlock-account-regions-')
  cleanups.push(() => removeDir(dir))
  const file = `${dir}/accounts.sqlite`
  const db = openTestDatabase(file)
  cleanups.push(() => db.close())
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; CREATE TABLE user(id TEXT PRIMARY KEY);')
  db.exec(ACCOUNT_REGIONS_SCHEMA)
  for (const user of users) db.prepare('INSERT INTO user(id) VALUES (?)').run(user)
  const regions = accountRegions(db)
  regions.register('eu', 'instance-eu-1')
  regions.register('us', 'instance-us-1')
  const connect = () => {
    const second = openTestDatabase(file)
    cleanups.push(() => second.close())
    second.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    return accountRegions(second)
  }
  return { db, regions, connect }
}

describe('global ranked account occupancy', () => {
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
