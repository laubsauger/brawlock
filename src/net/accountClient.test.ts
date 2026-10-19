import { afterEach, describe, expect, it, vi } from 'vitest'
import { regionalAccounts } from '../../server/account-client.mjs'
import { accountRegions, ACCOUNT_REGIONS_SCHEMA, ACCOUNT_CONTROL_SCHEMA, ACCOUNT_STARTED_SCHEMA } from '../../server/account-regions.mjs'
import { openTestDatabase, removeDir, tempDir } from '../../server/test-dir.mjs'
import type { ProgressionReceipt } from '../../server/progression.mjs'

const token = 'public-test-regional-secret-0123456789abcdef'
const connection = { device: '1'.repeat(64), controller: 'a'.repeat(64), takeover: false }
const account = { connection, id: 'account-first', name: 'AshMage', color: 0x2e7bff, ratingKey: 'a_account-first', cosmetics: { victory: null, robe: null } }
const proof = `${'A'.repeat(30)}-_`
const clients: ReturnType<typeof regionalAccounts>[] = []
const cleanups: (() => void)[] = []
afterEach(() => { for (const client of clients) client.close(); clients.length = 0; for (const close of cleanups.reverse()) close(); cleanups.length = 0; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

function fixture(reply: (body: Record<string, string>) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit; body: Record<string, string> }[] = []
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Record<string, string>
    calls.push({ url, init, body })
    return reply(body)
  })
  vi.stubGlobal('fetch', fetch)
  const log = vi.fn()
  const client = regionalAccounts({ url: 'https://accounts.example', token, region: 'eu', log })
  clients.push(client)
  return { client, calls, fetch, log }
}

describe('regional ranked account authority client', () => {
  it('retries a match-start notice in order before releasing its participants', async () => {
    vi.useFakeTimers()
    let attempts = 0
    const f = fixture((body) => Response.json({ ok: true }, { status: body.op === 'started' && ++attempts === 1 ? 503 : 200 }))
    await f.client.register()
    f.client.started('ABCDE', [account.id])
    await vi.advanceTimersByTimeAsync(0)
    f.client.release('ABCDE', account.id)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.calls.map((call) => call.body.op)).toEqual(['register', 'started', 'started', 'release'])
    expect(f.calls[1].body).toEqual(f.calls[2].body)
    expect(f.calls[1].body).toMatchObject({ room: 'ABCDE', accountIds: [account.id] })
    expect(f.client.pending!().releases).toBe(0)
  })
  it('retries a disconnected-controller update before a new claim and keeps its controller fence', async () => {
    vi.useFakeTimers()
    let attempts = 0
    const f = fixture((body) => Response.json({ ok: true }, { status: body.op === 'disconnect' && ++attempts === 1 ? 503 : 200 }))
    await f.client.register()
    f.client.disconnected('ABCDE', account.id, connection.controller)
    await vi.advanceTimersByTimeAsync(0)
    await expect(f.client.claim(account.id, 'ABCDE', connection)).resolves.toEqual({ ok: true })
    expect(f.calls.map((call) => call.body.op)).toEqual(['register', 'disconnect', 'disconnect', 'claim'])
    expect(f.calls[1].body).toEqual(f.calls[2].body)
    expect(f.calls[1].body).toMatchObject({ room: 'ABCDE', accountId: account.id, connection: { controller: connection.controller } })
  })
  it('requires registration and sends a stable server generation plus bearer secret privately', async () => {
    const f = fixture((body) => Response.json(body.op === 'verify' ? { account } : { ok: true }))
    await expect(f.client.verify(proof)).rejects.toThrow(/not registered/)
    expect(f.fetch).not.toHaveBeenCalled()
    await f.client.register()
    await expect(f.client.verify(proof)).resolves.toEqual(account)
    expect(f.calls.map((c) => c.body.op)).toEqual(['register', 'verify'])
    expect(f.calls[0].body.instance).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    for (const call of f.calls) {
      expect(call.url).toBe('https://accounts.example/internal/accounts')
      expect(call.init).toMatchObject({ method: 'POST', redirect: 'error' })
      const headers = new Headers(call.init.headers)
      expect(headers.get('authorization')).toBe(`Bearer ${token}`)
      expect(headers.has('origin')).toBe(false)
      expect(headers.has('cookie')).toBe(false)
      expect(call.body).toMatchObject({ region: 'eu', instance: f.calls[0].body.instance })
      expect(JSON.stringify(call.body)).not.toContain(token)
    }
  })

  it('rejects malformed proofs locally and mismatched account identity returned by the authority', async () => {
    let returned = { ...account }
    const f = fixture((body) => Response.json(body.op === 'verify' ? { account: returned } : { ok: true }))
    await f.client.register()
    for (const bad of ['', 'A'.repeat(31), 'A'.repeat(33), '!'.repeat(32)]) await expect(f.client.verify(bad)).rejects.toThrow(/Sign in/)
    expect(f.fetch).toHaveBeenCalledTimes(1)
    returned = { ...account, ratingKey: 'a_someone-else' }
    await expect(f.client.verify(proof)).rejects.toThrow(/invalid identity/)
    returned = { ...account, name: 'Client forged name' }
    await expect(f.client.verify(proof)).rejects.toThrow(/invalid identity/)
    returned = { ...account, color: -1 }
    await expect(f.client.verify(proof)).rejects.toThrow(/invalid identity/)
  })

  it('requires one canonical current name for every requested account instead of accepting partial or substituted names', async () => {
    let names: unknown = [[account.id, 'PhoenixMage']]
    const f = fixture((body) => Response.json(body.op === 'names' ? { names } : { ok: true }))
    await f.client.register()
    expect(await f.client.names([account.id])).toEqual(new Map([[account.id, 'PhoenixMage']]))
    for (const invalid of [[], [['account-someone-else', 'PhoenixMage']], [[account.id, 'Forged Display Name']], [[account.id, 'PhoenixMage'], [account.id, 'PhoenixMage']]]) {
      names = invalid
      await expect(f.client.names([account.id])).rejects.toThrow(/Invalid account name lookup/)
    }
  })

  it('retries an interrupted release before another claim and keeps retry logs free of identities and secrets', async () => {
    vi.useFakeTimers()
    let attempts = 0
    const f = fixture((body) => {
      if (body.op === 'release' && ++attempts === 1) return Response.json({ error: `private ${token} ${account.id}` }, { status: 503 })
      return Response.json({ ok: true })
    })
    await f.client.register()
    f.client.release('ABCDE', account.id)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.log).toHaveBeenCalledTimes(1)
    expect(f.log).toHaveBeenCalledWith('warn', 'accounts.release.pending')
    await expect(f.client.claim(account.id, 'FGHIJ', connection)).resolves.toEqual({ ok: true })
    expect(f.calls.map((c) => c.body.op)).toEqual(['register', 'release', 'release', 'claim'])
    expect(f.calls[1].body).toEqual(f.calls[2].body)
    expect(f.calls[2].body).toMatchObject({ room: 'ABCDE', accountId: account.id })
    expect(f.calls[3].body).toMatchObject({ room: 'FGHIJ', accountId: account.id })
    expect(JSON.stringify(f.log.mock.calls)).not.toContain(token)
    expect(JSON.stringify(f.log.mock.calls)).not.toContain(account.id)
  })

  it('retains failed whole-room release until the retry interval succeeds and stops on close', async () => {
    vi.useFakeTimers()
    let unavailable = true
    const f = fixture((body) => Response.json({ ok: true }, { status: body.op === 'release' && unavailable ? 503 : 200 }))
    await f.client.register()
    f.client.release('ABCDE')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.calls.filter((c) => c.body.op === 'release')).toHaveLength(1)
    unavailable = false
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.calls.filter((c) => c.body.op === 'release')).toHaveLength(2)
    expect(f.calls.at(-1)?.body).not.toHaveProperty('accountId')
    await vi.advanceTimersByTimeAsync(4000)
    expect(f.calls.filter((c) => c.body.op === 'release')).toHaveLength(2)
    f.client.close()
    f.client.release('FGHIJ')
    await vi.advanceTimersByTimeAsync(4000)
    expect(f.calls.filter((c) => c.body.op === 'release')).toHaveLength(2)
    await expect(f.client.verify(proof)).rejects.toThrow(/closed/)
  })

  it('blocks same-room reclaim until an applied but unacknowledged release is acknowledged, preventing a later retry from deleting its new claim', async () => {
    vi.useFakeTimers()
    const db = openTestDatabase(':memory:')
    cleanups.push(() => db.close())
    db.exec('PRAGMA foreign_keys=ON; CREATE TABLE user(id TEXT PRIMARY KEY);')
    db.exec(ACCOUNT_REGIONS_SCHEMA + ACCOUNT_CONTROL_SCHEMA + ACCOUNT_STARTED_SCHEMA)
    db.prepare('INSERT INTO user(id) VALUES (?)').run(account.id)
    const occupancy = accountRegions(db)
    let lostReply = true
    const f = fixture((body) => {
      if (body.op === 'register') { occupancy.register(body.region, body.instance); return Response.json({ ok: true }) }
      if (body.op === 'claim') return Response.json(occupancy.claim(body.region, body.instance, body.accountId, body.room, connection))
      if (body.op === 'game') return Response.json({ game: occupancy.game(body.accountId) })
      if (body.op !== 'release') throw new Error('Unexpected test operation')
      occupancy.release(body.region, body.instance, body.room, body.accountId)
      return Response.json({ ok: true }, { status: lostReply ? 503 : 200 })
    })
    await f.client.register()
    expect(await f.client.claim(account.id, 'ABCDE', connection)).toEqual({ ok: true })
    f.client.release('ABCDE', account.id)
    await vi.advanceTimersByTimeAsync(0)
    expect(occupancy.game(account.id)).toBeNull()
    await expect(f.client.claim(account.id, 'ABCDE', connection)).rejects.toThrow(/release|previous game/i)
    await expect(f.client.game(account.id)).rejects.toThrow(/release|previous game/i)
    expect(f.calls.filter((c) => c.body.op === 'claim')).toHaveLength(1)
    lostReply = false
    await vi.advanceTimersByTimeAsync(2000)
    expect(await f.client.claim(account.id, 'ABCDE', connection)).toEqual({ ok: true })
    await vi.advanceTimersByTimeAsync(6000)
    expect(occupancy.game(account.id)).toEqual({ region: 'eu', room: 'ABCDE' })
    expect(await f.client.game(account.id)).toEqual({ region: 'eu', room: 'ABCDE' })
  })

  it('surfaces the conflicting global game and hides private authority errors', async () => {
    let status = 200
    const f = fixture((body) => Response.json(body.op === 'register' ? { ok: true } : status === 200 ? { ok: false, game: { region: 'us', room: 'ABCDE' } } : { error: `private ${token}` }, { status }))
    await f.client.register()
    await expect(f.client.claim(account.id, 'FGHIJ', connection)).resolves.toEqual({ ok: false, game: { region: 'us', room: 'ABCDE' } })
    status = 403
    await expect(f.client.verify(proof)).rejects.toThrow('Sign in again before joining ranked.')
    status = 503
    await expect(f.client.verify(proof)).rejects.toThrow('Account verification is temporarily unavailable.')
    expect(f.log).not.toHaveBeenCalled()
  })

  it('persists a completed match through a lost reply and restart, resends the same receipt, and rejects pending conflicts', async () => {
    vi.useFakeTimers()
    const dir = tempDir('brawlock-progression-delivery-')
    cleanups.push(() => removeDir(dir))
    const rewardFile = `${dir}/rewards.sqlite`
    const receipt: ProgressionReceipt = {
      matchId: 'match-first-0001', queue: 'quick', rulesVersion: 1, completedAt: Date.now(), durationSeconds: 180,
      players: [{ accountId: account.id, completed: true, aliveSeconds: 140, casts: 25, damageDealt: 700, walked: 6000, roundsPlayed: 3, roundsWon: 1, won: false }],
    }
    const received: ProgressionReceipt[] = []
    const committed = new Set<string>()
    let loseReply = true
    const log = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { op: string; receipt: ProgressionReceipt }
      if (body.op === 'register') return Response.json({ ok: true })
      expect(body.op).toBe('reward')
      received.push(body.receipt)
      const duplicate = committed.has(body.receipt.matchId)
      committed.add(body.receipt.matchId)
      // Simulate the authority committing successfully, followed by a broken response.
      if (loseReply) { loseReply = false; throw new Error('Connection lost after the authority committed') }
      return Response.json({ duplicate, rewards: [{ accountId: account.id, base: 20, performance: 2, win: 0, balance: 22 }] })
    }))
    const options = { url: 'https://accounts.example', token, region: 'eu', log, rewardFile }
    const first = regionalAccounts(options)
    clients.push(first)
    await first.register()
    expect(await first.reward(receipt)).toBe('pending')
    expect(committed.size).toBe(1)
    await expect(first.reward({ ...receipt, durationSeconds: 181 })).rejects.toThrow(/Conflicting progression receipt/)
    expect(received).toHaveLength(1)
    first.close()
    clients.splice(clients.indexOf(first), 1)
    const saved = openTestDatabase(rewardFile)
    expect(saved.prepare('SELECT receipt FROM reward_outbox').get()).toEqual({ receipt: JSON.stringify(receipt) })
    saved.close()
    const restarted = regionalAccounts(options)
    clients.push(restarted)
    await restarted.register()
    await vi.advanceTimersByTimeAsync(2000)
    expect(received).toEqual([receipt, receipt])
    expect(committed.size).toBe(1)
    const drained = openTestDatabase(rewardFile)
    expect(drained.prepare('SELECT COUNT(*) AS n FROM reward_outbox').get()).toEqual({ n: 0 })
    drained.close()
    expect(await restarted.reward(receipt)).toBe('awarded')
    expect(committed.size).toBe(1)
    expect(JSON.stringify(log.mock.calls)).not.toContain(account.id)
    expect(JSON.stringify(log.mock.calls)).not.toContain(token)
  })

  it('does not pretend to grant progression without durable storage', async () => {
    const f = fixture(() => Response.json({ ok: true }))
    await f.client.register()
    await expect(f.client.reward({ matchId: 'match-without-disk' } as ProgressionReceipt)).rejects.toThrow(/durable reward storage/)
    expect(f.calls.map((c) => c.body.op)).toEqual(['register'])
  })

  it('rejects unsafe authority URLs and incomplete configuration without starting another provider', () => {
    const config = { token, region: 'eu', log: vi.fn() }
    for (const url of ['http://accounts.example', 'https://accounts.example/path', 'https://user:password@accounts.example', 'https://accounts.example?token=x', 'https://accounts.example#secret']) {
      expect(() => regionalAccounts({ ...config, url })).toThrow(/origin|loopback/)
    }
    expect(() => regionalAccounts({ ...config, url: 'https://accounts.example', token: 'short' })).toThrow(/token/)
    expect(() => regionalAccounts({ ...config, url: 'https://accounts.example', region: 'EU' })).toThrow(/region/)
  })
})
