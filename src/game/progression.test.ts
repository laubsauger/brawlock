import { afterEach, describe, expect, it } from 'vitest'
import { createProgression, PROGRESSION_SCHEMA, type ProgressionReceipt } from '../../server/progression.mjs'
import { openTestDatabase, removeDir, tempDir } from '../../server/test-dir.mjs'

const cleanups: (() => void)[] = []
afterEach(() => { for (const close of cleanups.reverse()) close(); cleanups.length = 0 })
function fixture() {
  const dir = tempDir('brawlock-progression-')
  cleanups.push(() => removeDir(dir))
  const file = `${dir}/accounts.sqlite`
  const db = openTestDatabase(file)
  cleanups.push(() => db.close())
  db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; CREATE TABLE user(id TEXT PRIMARY KEY); INSERT INTO user VALUES ('account-a'), ('account-b'); ${PROGRESSION_SCHEMA}`)
  let now = Date.UTC(2026, 9, 19, 12)
  return { db, file, store: createProgression(db, { now: () => now }), advance: (ms: number) => { now += ms } }
}
function receipt(matchId = 'match-0001', extra: Partial<ProgressionReceipt> = {}): ProgressionReceipt {
  return { matchId, queue: 'quick', rulesVersion: 1, completedAt: Date.UTC(2026, 9, 19, 11), durationSeconds: 180,
    players: [{ accountId: 'account-a', completed: true, aliveSeconds: 120, casts: 20, damageDealt: 300, walked: 600, roundsPlayed: 3, roundsWon: 0, won: false }], ...extra }
}

describe('shared account progression', () => {
  it('grants an eligible solo official loss its base, with modest explained performance/win bonuses', () => {
    const { store } = fixture()
    expect(store.recordMatch(receipt()).rewards).toEqual([{ accountId: 'account-a', base: 20, performance: 0, win: 0, balance: 20 }])
    const win = receipt('match-0002')
    win.queue = 'ranked'; win.players[0].roundsWon = 3; win.players[0].won = true
    expect(store.recordMatch(win).rewards).toEqual([{ accountId: 'account-a', base: 20, performance: 5, win: 5, balance: 50 }])
    expect(store.snapshot('account-a').recentRewards[0]).toMatchObject({ matchId: 'match-0002', total: 30, base: 20, performance: 5, win: 5 })
  })

  it('rejects custom/tampered receipts and gives no rewards to idle, short or disconnected seats', () => {
    const { store, db } = fixture()
    expect(() => store.recordMatch({ ...receipt(), queue: 'custom' } as unknown as ProgressionReceipt)).toThrow(/official progression/)
    expect(() => store.recordMatch({ ...receipt(), rulesVersion: 2 } as unknown as ProgressionReceipt)).toThrow(/official progression/)
    expect(() => store.recordMatch({ ...receipt(), balance: 1000 } as unknown as ProgressionReceipt)).toThrow(/official progression/)
    for (const [i, mutate] of [
      (r: ProgressionReceipt) => { r.durationSeconds = 119; r.players[0].aliveSeconds = 90 },
      (r: ProgressionReceipt) => { r.players[0].completed = false },
      (r: ProgressionReceipt) => { r.players[0].casts = 0 },
      (r: ProgressionReceipt) => { r.players[0].damageDealt = 0; r.players[0].walked = 0 },
      (r: ProgressionReceipt) => { r.players[0].aliveSeconds = 29 },
      (r: ProgressionReceipt) => { r.players[0].roundsPlayed = 1; r.players[0].roundsWon = 0 },
    ].entries()) {
      const r = receipt(`ineligible-${i}`); mutate(r)
      expect(store.recordMatch(r).rewards).toEqual([])
    }
    expect(store.snapshot('account-a').balance).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM progression_reward').get()).toEqual({ n: 0 })
  })

  it('deduplicates region retries and conflicts instead of rewriting an already settled result', () => {
    const { store } = fixture()
    const r = receipt()
    const settled = store.recordMatch(r).rewards[0].balance
    expect(settled).toBeGreaterThan(0)
    expect(store.recordMatch(r)).toMatchObject({ duplicate: true })
    const altered = receipt(); altered.players[0].won = true
    expect(() => store.recordMatch(altered)).toThrow(/different result/)
    expect(store.snapshot('account-a').balance).toBe(settled)
  })

  it('uses one atomic receipt for all seats and rejects unknown/duplicate account identities', () => {
    const { store } = fixture()
    const r = receipt()
    r.players.push({ ...r.players[0], accountId: 'missing-account' })
    expect(() => store.recordMatch(r)).toThrow(/Account not found/)
    expect(store.snapshot('account-a').balance).toBe(0)
    r.players[1].accountId = 'account-a'
    expect(() => store.recordMatch(r)).toThrow(/participant/)
    r.players[1].accountId = 'account-b'
    const settled = store.recordMatch(r).rewards.find((reward) => reward.accountId === 'account-b')!.balance
    expect(settled).toBeGreaterThan(0)
    expect(store.recordMatch({ ...r, players: [...r.players].reverse() }).duplicate).toBe(true)
    expect(store.snapshot('account-b').balance).toBe(settled)
  })

  it('charges exactly once, refuses key reuse and cannot overspend across authority connections', () => {
    const { store, file } = fixture()
    for (let i = 0; i < 5; i++) store.recordMatch(receipt(`funding-${i}`))
    // 100 Embers: an 80-Ember pose leaves too little for anything else in the catalog
    const initial = store.snapshot('account-a'), item = initial.offers.find((v) => v.id === 'victory-revel')!
    const request = { itemId: item.id, offerId: initial.offerId, requestId: 'purchase-0001' }
    const bought = store.purchase('account-a', request)
    expect(bought.balance).toBe(initial.balance - item.price)
    expect(bought.owned).toContain(item.id)
    expect(store.purchase('account-a', request).balance).toBe(bought.balance)
    const pricier = initial.offers.find((v) => v.price > bought.balance)!
    expect(() => store.purchase('account-a', { ...request, itemId: pricier.id })).toThrow(/already used/)
    expect(() => store.purchase('account-a', { ...request, requestId: 'purchase-0002' })).toThrow(/already own/)
    const connection = openTestDatabase(file)
    cleanups.push(() => connection.close())
    const other = createProgression(connection, { now: () => initial.serverNow })
    expect(() => other.purchase('account-a', { ...request, itemId: pricier.id, requestId: 'purchase-0003' })).toThrow(/more Embers/)
    expect(store.snapshot('account-a').balance).toBe(bought.balance)
  })

  it('uses the shared UTC day, rejects stale offers, and preserves ownership/equipment through refresh/reopen', () => {
    const f = fixture()
    for (let i = 0; i < 5; i++) f.store.recordMatch(receipt(`funding-${i}`))
    const initial = f.store.snapshot('account-a')
    expect(initial.refreshAt).toBe(Date.UTC(2026, 9, 20))
    const item = initial.offers.find((v) => v.slot === 'victory')!
    const request = { itemId: item.id, offerId: initial.offerId, requestId: 'purchase-0001' }
    expect(() => f.store.equip('account-a', { slot: 'victory', itemId: item.id })).toThrow(/Unlock/)
    f.store.purchase('account-a', request)
    expect(() => f.store.equip('account-a', { slot: 'robe', itemId: item.id })).toThrow(/does not fit/)
    f.store.equip('account-a', { slot: 'victory', itemId: item.id })
    f.advance(24 * 60 * 60 * 1000)
    const next = f.store.snapshot('account-a')
    expect(next.offerId).not.toBe(initial.offerId)
    expect(() => f.store.purchase('account-a', { itemId: initial.offers[1].id, offerId: initial.offerId, requestId: 'purchase-0002' })).toThrow(/selection changed/)
    // An exact retry from yesterday is still a successful purchase, without a second debit.
    expect(f.store.purchase('account-a', request).balance).toBe(next.balance)
    const connection = openTestDatabase(f.file); cleanups.push(() => connection.close())
    const reopened = createProgression(connection)
    expect(reopened.equipment('account-a').victory).toBe(item.id)
    expect(reopened.snapshot('account-a').owned).toContain(item.id)
    expect(reopened.equip('account-a', { slot: 'victory', itemId: null }).equipped.victory).toBeNull()
  })

  it('does not trust client prices, balances or ownership and starts without invented rewards', () => {
    const { store } = fixture()
    const initial = store.snapshot('account-b')
    expect(initial.balance).toBe(0); expect(initial.owned).toEqual([]); expect(initial.recentRewards).toEqual([])
    expect(() => store.purchase('account-b', { itemId: initial.offers[0].id, offerId: initial.offerId, requestId: 'purchase-0001', price: 0 } as never)).toThrow(/Invalid purchase/)
    expect(() => store.equip('account-b', { slot: 'robe', itemId: 'robe-emberveil', owned: true } as never)).toThrow(/Invalid cosmetic/)
    expect(store.equipment('account-b')).toEqual({ victory: null, head: null, back: null, robe: null, emblem: null, staff: null })
  })
})
