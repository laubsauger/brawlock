import { afterEach, describe, expect, it, vi } from 'vitest'
import { betterAuth } from 'better-auth'
import { testUtils } from 'better-auth/plugins'
import { accountName, accountOptions, openAccounts } from '../../server/accounts.mjs'
import { openTestDatabase, removeDir, tempDir } from '../../server/test-dir.mjs'
import { regionalAccounts } from '../../server/account-client.mjs'
import type { ProgressionReceipt } from '../../server/progression.mjs'

const secret = 'public-test-secret-only-0123456789abcdef'
const origin = 'http://localhost:5352'
const regionsToken = 'public-test-region-secret-0123456789abcdef'
const providers = { google: { clientId: 'test-client', clientSecret: 'test-provider-secret' } }
const cleanups: (() => void)[] = []
afterEach(() => { for (const close of cleanups.reverse()) close(); cleanups.length = 0; vi.unstubAllGlobals(); vi.useRealTimers() })

async function fixture() {
  const dir = tempDir('brawlock-accounts-')
  cleanups.push(() => removeDir(dir))
  const config = { file: `${dir}/accounts.sqlite`, origin, secret, providers, regionsToken }
  const accounts = await openAccounts({ ...config, migrate: true })
  cleanups.push(accounts.close)
  const db = openTestDatabase(config.file)
  cleanups.push(() => db.close())
  const options = accountOptions({ database: db, origin, secret, providers })
  // Official privileged test helpers are confined to this test-only auth instance.
  const testAuth = betterAuth({ ...options, plugins: [...options.plugins ?? [], testUtils()] })
  const { test } = await testAuth.$context
  async function login(userId: string) {
    const session = await test.login({ userId })
    const headers = new Headers(session.headers)
    headers.set('origin', origin)
    headers.set('content-type', 'application/json')
    return headers
  }
  async function player(email: string) {
    const user = test.createUser({ email, name: 'Provider supplied name' })
    await test.saveUser(user)
    return { id: user.id, email, headers: await login(user.id) }
  }
  const request = (method: string, headers?: Headers, body?: unknown, path = '/api/account') => accounts.handler(new Request(`${origin}${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const rpc = (body: unknown, headers = new Headers({ authorization: `Bearer ${regionsToken}`, 'content-type': 'application/json' })) =>
    accounts.handler(new Request(`${origin}/internal/accounts`, { method: 'POST', headers, body: JSON.stringify(body) }))
  return { accounts, config, player, login, request, rpc, db }
}

describe('account authority', () => {
  it('requires an explicit schema migration and preserves profiles and sessions through reopen', async () => {
    const dir = tempDir('brawlock-account-migration-')
    cleanups.push(() => removeDir(dir))
    await expect(openAccounts({ file: `${dir}/accounts.sqlite`, origin, secret, providers })).rejects.toThrow(/accounts:migrate/)
    const f = await fixture()
    const user = await f.player('reopen@example.com')
    expect((await f.request('POST', user.headers, { name: 'CinderFox', color: 0x2e7bff })).status).toBe(200)
    const reopened = await openAccounts({ ...f.config, migrate: true })
    cleanups.push(reopened.close)
    const response = await reopened.handler(new Request(`${origin}/api/account`, { headers: user.headers }))
    expect(await response.json()).toEqual({ id: user.id, email: user.email, profile: { name: 'CinderFox', color: 0x2e7bff }, game: null })
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM player_profile').get()).toEqual({ n: 1 })
  })

  it('uses verified sessions only, keeps email private, and revokes logout immediately', async () => {
    const f = await fixture()
    expect((await f.request('GET')).status).toBe(401)
    const user = await f.player('private@example.com')
    const forged = new Headers(user.headers)
    forged.set('cookie', 'brawlock.session_token=forged-account-id')
    expect((await f.request('GET', forged)).status).toBe(401)
    const response = await f.request('GET', user.headers)
    expect(await response.json()).toEqual({ id: user.id, email: user.email, profile: null, game: null })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await f.request('POST', user.headers, {}, '/api/auth/sign-out')).status).toBe(200)
    expect((await f.request('GET', user.headers)).status).toBe(401)
  })

  it('keeps presence public and anonymous while deduplicating only server-verified account sessions', async () => {
    const f = await fixture()
    const user = await f.player('presence-private@example.com')
    expect((await f.request('POST', user.headers, { name: 'PresentMage', color: null })).status).toBe(200)
    const headers = new Headers(user.headers)
    headers.set('x-brawlock-client-ip', 'test-address')
    const beat = (device: string, region: string, h = headers) => f.request('POST', h, { device, region }, '/api/presence')
    expect((await beat('browser_1', 'eu')).status).toBe(200)
    const result = await (await beat('browser_2', 'us-west')).json()
    expect(result).toEqual({ regions: { eu: 0, 'us-west': 1 }, total: 1 })
    expect(JSON.stringify(result)).not.toContain(user.id)
    expect(JSON.stringify(result)).not.toContain(user.email)
    expect(await (await f.request('GET', undefined, undefined, '/api/presence')).json()).toEqual(result)
    expect((await beat('browser_3', 'eu', new Headers({ 'content-type': 'application/json' }))).status).toBe(403)
    const forged = new Headers(headers)
    forged.set('cookie', 'brawlock.session_token=forged-account-id')
    expect(await (await beat('browser_3', 'eu', forged)).json()).toEqual({ regions: { eu: 1, 'us-west': 1 }, total: 2 })
    expect((await f.request('POST', headers, { device: 'browser_4', region: 'eu', accountId: user.id }, '/api/presence')).status).toBe(400)
    const ticket = await (await f.request('POST', user.headers, {}, '/api/account/admission')).json()
    expect(ticket).not.toHaveProperty('email')
    const regional = await (await f.rpc({ op: 'verify', token: ticket.token })).json()
    expect(regional.account.id).toBe(user.id)
    expect(regional.account).not.toHaveProperty('email')
  })

  it('reserves names case-insensitively across simultaneous authority connections', async () => {
    const f = await fixture()
    const [a, b] = await Promise.all([f.player('first@example.com'), f.player('second@example.com')])
    const second = await openAccounts(f.config)
    cleanups.push(second.close)
    const responses = await Promise.all([
      f.request('POST', a.headers, { name: 'AshFox', color: null }),
      second.handler(new Request(`${origin}/api/account`, { method: 'POST', headers: b.headers, body: JSON.stringify({ name: 'ashFOX', color: null }) })),
    ])
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409])
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM player_profile').get()).toEqual({ n: 1 })
  })

  it('resolves simultaneous rename collisions atomically and leaves the losing name and color unchanged', async () => {
    const f = await fixture()
    const a = await f.player('rename-first@example.com')
    const b = await f.player('rename-second@example.com')
    await f.request('POST', a.headers, { name: 'EmberFirst', color: 0x2e7bff })
    await f.request('POST', b.headers, { name: 'EmberSecond', color: 0x14e0c8 })
    const second = await openAccounts(f.config)
    cleanups.push(second.close)
    const responses = await Promise.all([
      f.request('PATCH', a.headers, { name: 'SharedMage', color: 0x14e0c8 }),
      second.handler(new Request(`${origin}/api/account`, { method: 'PATCH', headers: b.headers, body: JSON.stringify({ name: 'sharedMAGE', color: 0x2e7bff }) })),
    ])
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409])
    const profiles = await Promise.all([a, b].map(async (user) => (await (await f.request('GET', user.headers)).json()).profile))
    if (responses[0].status === 200) {
      expect(profiles).toEqual([{ name: 'SharedMage', color: 0x14e0c8 }, { name: 'EmberSecond', color: 0x14e0c8 }])
    } else {
      expect(profiles).toEqual([{ name: 'EmberFirst', color: 0x2e7bff }, { name: 'sharedMAGE', color: 0x2e7bff }])
    }
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM player_profile WHERE name_key = ?').get('sharedmage')).toEqual({ n: 1 })
  })

  it('supports case-only renames and releases the old name for another account after a successful rename', async () => {
    const f = await fixture()
    const a = await f.player('case-rename@example.com')
    const b = await f.player('old-name-reclaim@example.com')
    await f.request('POST', a.headers, { name: 'CinderFox', color: null })
    const caseOnly = await f.request('PATCH', a.headers, { name: 'cINDERfOX', color: null })
    expect(caseOnly.status).toBe(200)
    expect(await caseOnly.json()).toEqual({ id: a.id, email: a.email, profile: { name: 'cINDERfOX', color: null }, game: null })
    expect((await f.request('POST', b.headers, { name: 'CINDERFOX', color: null })).status).toBe(409)
    expect((await f.request('PATCH', a.headers, { name: 'PhoenixMage', color: null })).status).toBe(200)
    expect((await f.request('POST', b.headers, { name: 'CinderFox', color: null })).status).toBe(200)
    expect((await (await f.request('GET', a.headers)).json()).id).toBe(a.id)
    expect((await (await f.request('GET', b.headers)).json()).profile.name).toBe('CinderFox')
  })

  it('keeps account identity, global game, wallet and cosmetic ownership through rename and authority reopen', async () => {
    const f = await fixture()
    const user = await f.player('rename-progression@example.com')
    await f.request('POST', user.headers, { name: 'CinderFox', color: null })
    await f.rpc({ op: 'register', region: 'eu', instance: 'instance-eu-1' })
    await f.rpc({ op: 'claim', region: 'eu', instance: 'instance-eu-1', accountId: user.id, room: 'ABCDE' })
    for (let i = 0; i < 6; i++) {
      const receipt: ProgressionReceipt = { matchId: `rename-reward-${i}`, queue: 'ranked', rulesVersion: 1, completedAt: Date.now(), durationSeconds: 180,
        players: [{ accountId: user.id, completed: true, aliveSeconds: 140, casts: 25, damageDealt: 700, walked: 6000, roundsPlayed: 3, roundsWon: 1, won: false }] }
      expect((await f.rpc({ op: 'reward', receipt })).status).toBe(200)
    }
    const snapshot = async () => (await (await f.request('GET', user.headers, undefined, '/api/progression')).json()) as {
      balance: number; offerId: string; offers: { id: string; slot: string }[]; owned: string[]; equipped: unknown; recentRewards: unknown[]
    }
    const funded = await snapshot()
    const item = funded.offers[0]
    expect((await f.request('POST', user.headers, { itemId: item.id, offerId: funded.offerId, requestId: 'rename-purchase-1' }, '/api/progression/purchase')).status).toBe(200)
    expect((await f.request('POST', user.headers, { itemId: item.id, slot: item.slot }, '/api/progression/equip')).status).toBe(200)
    const before = await snapshot()
    const renamed = await f.request('PATCH', user.headers, { name: 'PhoenixMage', color: 0x14e0c8 })
    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toEqual({ id: user.id, email: user.email, profile: { name: 'PhoenixMage', color: 0x14e0c8 }, game: { region: 'eu', room: 'ABCDE' } })
    const after = await snapshot()
    expect(after).toMatchObject({ balance: before.balance, owned: before.owned, equipped: before.equipped, recentRewards: before.recentRewards })
    const reopened = await openAccounts(f.config)
    cleanups.push(reopened.close)
    const profile = await reopened.handler(new Request(`${origin}/api/account`, { headers: user.headers }))
    expect(await profile.json()).toEqual({ id: user.id, email: user.email, profile: { name: 'PhoenixMage', color: 0x14e0c8 }, game: { region: 'eu', room: 'ABCDE' } })
    const ticket = await (await f.request('POST', user.headers, {}, '/api/account/admission')).json() as { token: string }
    const verified = await (await f.rpc({ op: 'verify', token: ticket.token })).json()
    expect(verified.account).toMatchObject({ id: user.id, ratingKey: `a_${user.id}`, name: 'PhoenixMage', color: 0x14e0c8, cosmetics: before.equipped })
    const names = await f.rpc({ op: 'names', accountIds: [user.id] })
    expect(names.status).toBe(200)
    expect(await names.json()).toEqual({ names: [[user.id, 'PhoenixMage']] })
    expect((await f.rpc({ op: 'names', accountIds: [user.id, user.id] })).status).toBe(400)
    expect((await f.rpc({ op: 'names', accountIds: ['account-unknown'] })).status).toBe(409)
  })

  it('refuses expired sessions instead of accepting a still-signed cookie', async () => {
    const f = await fixture()
    const user = await f.player('expired@example.com')
    f.db.prepare('UPDATE session SET expiresAt = 0 WHERE userId = ?').run(user.id)
    expect((await f.request('GET', user.headers)).status).toBe(401)
    expect((await f.request('POST', user.headers, { name: 'ExpiredFox', color: null })).status).toBe(401)
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM player_profile').get()).toEqual({ n: 0 })
  })

  it('cannot edit another account, override identity, or rename through the generic user endpoint', async () => {
    const f = await fixture()
    const user = await f.player('identity@example.com')
    const other = await f.player('other@example.com')
    expect((await f.request('POST', user.headers, { name: 'AshMage', color: null, userId: other.id })).status).toBe(400)
    expect((await f.request('POST', user.headers, { name: 'AshMage', color: null })).status).toBe(200)
    expect((await f.request('POST', user.headers, { name: 'NewMage', color: null })).status).toBe(409)
    expect((await f.request('POST', user.headers, { name: 'NewMage' }, '/api/auth/update-user')).status).toBe(200)
    expect(await (await f.request('GET', user.headers)).json()).toEqual({ id: user.id, email: user.email, profile: { name: 'AshMage', color: null }, game: null })
    expect((await f.request('PATCH', user.headers, { color: 0x14e0c8 })).status).toBe(200)
    expect(await (await f.request('GET', other.headers)).json()).toEqual({ id: other.id, email: other.email, profile: null, game: null })
    expect((await f.request('PATCH', other.headers, { color: 0x14e0c8 })).status).toBe(409)
  })

  it('rejects cross-site writes, unknown fields, invalid colors, and oversized profile requests', async () => {
    const f = await fixture()
    const user = await f.player('validation@example.com')
    const headers = new Headers(user.headers)
    headers.set('origin', 'https://attacker.example')
    expect((await f.request('POST', headers, { name: 'AshMage', color: null })).status).toBe(403)
    headers.delete('origin')
    expect((await f.request('POST', headers, { name: 'AshMage', color: null })).status).toBe(403)
    expect((await f.request('POST', user.headers, { name: 'AshMage', color: 123 })).status).toBe(400)
    expect((await f.request('POST', user.headers, { name: 'AshMage', color: null, device: 'claimed-device' })).status).toBe(400)
    expect((await f.request('POST', user.headers, { name: 'a'.repeat(2048), color: null })).status).toBe(413)
    expect((await f.request('POST', user.headers, { name: '炎'.repeat(400), color: null })).status).toBe(413)
    const invalidType = new Headers(user.headers)
    invalidType.set('content-type', 'application/json-something-else')
    expect((await f.request('POST', invalidType, { name: 'AshMage', color: null })).status).toBe(415)
    expect((await f.request('POST', user.headers, { name: 'AshMage', color: null })).status).toBe(200)
  })

  it('limits profile writes and advertises only configured sign-in providers', async () => {
    const f = await fixture()
    expect(await (await f.request('GET', undefined, undefined, '/api/account/config')).json()).toEqual({ providers: ['google'] })
    const user = await f.player('limited@example.com')
    for (let i = 0; i < 6; i++) expect((await f.request('POST', user.headers, { name: 'admin', color: null })).status).toBe(400)
    expect((await f.request('POST', user.headers, { name: 'AshMage', color: null })).status).toBe(429)
    expect((await f.request('GET', user.headers)).status).toBe(200)
    expect((await f.request('POST', user.headers, { email: 'bad@example.com', password: 'not-supported' }, '/api/auth/sign-up/email')).status).not.toBe(200)
    expect(f.accounts.auth.options.account?.accountLinking).toMatchObject({ disableImplicitLinking: true, allowUnlinkingAll: false })
  })
})

describe('ranked admission proof boundary', () => {
  it('keeps region RPC private, rejects browser Origin even with the secret, and bounds its payload', async () => {
    const f = await fixture()
    const body = { op: 'register', region: 'eu', instance: 'instance-eu-1' }
    for (const headers of [new Headers(), new Headers({ authorization: 'Bearer wrong-secret' }),
      new Headers({ authorization: `Bearer ${regionsToken}`, origin }),
      new Headers({ authorization: `Bearer ${regionsToken}`, origin: '' })]) {
      const response = await f.rpc(body, headers)
      expect(response.status).toBe(403)
      const text = await response.text()
      expect(text).not.toContain(regionsToken)
      expect(text).not.toContain('instance-eu-1')
    }
    expect((await f.rpc(body)).status).toBe(200)
    const headers = new Headers({ authorization: `Bearer ${regionsToken}` })
    expect((await f.accounts.handler(new Request(`${origin}/internal/accounts`, { headers }))).status).toBe(405)
    expect((await f.rpc({ ...body, secret: 'unexpected' })).status).toBe(400)
    expect((await f.rpc({ ...body, op: 'unknown' })).status).toBe(400)
    expect((await f.rpc({ ...body, token: 'x'.repeat(17_000) })).status).toBe(413)
    const malformed = await f.accounts.handler(new Request(`${origin}/internal/accounts`, { method: 'POST', headers, body: '{' }))
    expect(malformed.status).toBe(400)
  })

  it('issues only to a claimed signed-in account and consumes a hashed proof once without exposing sessions or provider data', async () => {
    const f = await fixture()
    expect((await f.request('POST', new Headers({ origin }), {}, '/api/account/admission')).status).toBe(401)
    const user = await f.player('proof-private@example.com')
    const other = await f.player('proof-other@example.com')
    expect((await f.request('POST', user.headers, {}, '/api/account/admission')).status).toBe(403)
    expect((await f.request('POST', user.headers, { name: 'CinderFox', color: 0x2e7bff })).status).toBe(200)
    const noOrigin = new Headers(user.headers)
    noOrigin.delete('origin')
    expect((await f.request('POST', noOrigin, {}, '/api/account/admission')).status).toBe(403)
    const crossOrigin = new Headers(user.headers)
    crossOrigin.set('origin', 'https://attacker.example')
    expect((await f.request('POST', crossOrigin, {}, '/api/account/admission')).status).toBe(403)
    expect((await f.request('GET', user.headers, undefined, '/api/account/admission')).status).toBe(405)
    // Client identity fields cannot alter the verified account that owns this cookie.
    const minted = await f.request('POST', user.headers, { accountId: other.id, name: 'ForgedMage' }, '/api/account/admission')
    expect(minted.status).toBe(200)
    expect(minted.headers.get('cache-control')).toBe('no-store')
    const ticket = await minted.json() as { token: string }
    expect(Object.keys(ticket)).toEqual(['token'])
    expect(ticket.token).toMatch(/^[A-Za-z0-9_-]{32}$/)
    const stored = f.db.prepare('SELECT identifier, expiresAt FROM verification WHERE identifier LIKE ?').all('one-time-token:%') as { identifier: string; expiresAt: string }[]
    expect(stored).toHaveLength(1)
    expect(stored[0].identifier).not.toContain(ticket.token)
    const lifetime = new Date(stored[0].expiresAt).getTime() - Date.now()
    expect(lifetime).toBeGreaterThan(0)
    expect(lifetime).toBeLessThanOrEqual(60_000)
    await f.rpc({ op: 'register', region: 'eu', instance: 'instance-eu-1' })
    const response = await f.rpc({ op: 'verify', region: 'eu', instance: 'instance-eu-1', token: ticket.token })
    expect(response.status).toBe(200)
    expect(response.headers.has('set-cookie')).toBe(false)
    expect(await response.json()).toEqual({ account: { id: user.id, name: 'CinderFox', color: 0x2e7bff, ratingKey: `a_${user.id}`, cosmetics: { victory: null, robe: null } } })
    expect((await f.rpc({ op: 'verify', region: 'us', instance: 'instance-us-1', token: ticket.token })).status).toBe(401)
    const next = await (await f.request('POST', user.headers, {}, '/api/account/admission')).json() as { token: string }
    const simultaneous = await Promise.all([f.rpc({ op: 'verify', token: next.token }), f.rpc({ op: 'verify', token: next.token })])
    expect(simultaneous.map((r) => r.status).sort()).toEqual([200, 401])
    expect((await f.request('GET', user.headers, undefined, '/api/auth/one-time-token/generate')).status).toBe(404)
    expect((await f.request('POST', user.headers, { token: ticket.token }, '/api/auth/one-time-token/verify')).status).toBe(404)
    expect(await (await f.request('GET', user.headers)).json()).toEqual({ id: user.id, email: user.email, profile: { name: 'CinderFox', color: 0x2e7bff }, game: null })
  })

  it.each(['revoked', 'session expired', 'ticket expired'] as const)('rejects an unconsumed proof after its %s condition', async (condition) => {
    const f = await fixture()
    const user = await f.player('expired-proof@example.com')
    await f.request('POST', user.headers, { name: 'AshMage', color: null })
    const minted = await f.request('POST', user.headers, {}, '/api/account/admission')
    expect(minted.status).toBe(200)
    const ticket = await minted.json() as { token: string }
    expect(ticket.token).toMatch(/^[A-Za-z0-9_-]{32}$/)
    if (condition === 'revoked') expect((await f.request('POST', user.headers, {}, '/api/auth/sign-out')).status).toBe(200)
    else if (condition === 'session expired') f.db.prepare('UPDATE session SET expiresAt = 0 WHERE userId = ?').run(user.id)
    else f.db.prepare('UPDATE verification SET expiresAt = 0 WHERE identifier LIKE ?').run('one-time-token:%')
    const request = { op: 'verify', region: 'eu', instance: 'instance-eu-1', token: ticket.token }
    expect((await f.rpc(request)).status).toBe(401)
    expect((await f.rpc(request)).status).toBe(401)
    if (condition !== 'ticket expired') expect((await f.request('POST', user.headers, {}, '/api/account/admission')).status).toBe(401)
  })

  it('exposes the global game to its cookie owner and preserves region occupancy through authority reopen', async () => {
    const f = await fixture()
    const user = await f.player('ranked-game@example.com')
    await f.request('POST', user.headers, { name: 'AshMage', color: null })
    await f.rpc({ op: 'register', region: 'eu', instance: 'instance-eu-1' })
    await f.rpc({ op: 'register', region: 'us', instance: 'instance-us-1' })
    expect(await (await f.rpc({ op: 'claim', region: 'eu', instance: 'instance-eu-1', accountId: user.id, room: 'ABCDE' })).json()).toEqual({ ok: true })
    expect(await (await f.rpc({ op: 'claim', region: 'us', instance: 'instance-us-1', accountId: user.id, room: 'FGHIJ' })).json()).toEqual({ ok: false, game: { region: 'eu', room: 'ABCDE' } })
    const reopened = await openAccounts(f.config)
    cleanups.push(reopened.close)
    expect(await (await reopened.handler(new Request(`${origin}/api/account`, { headers: user.headers }))).json()).toEqual({ id: user.id, email: user.email, profile: { name: 'AshMage', color: null }, game: { region: 'eu', room: 'ABCDE' } })
    await f.rpc({ op: 'register', region: 'eu', instance: 'instance-eu-2' })
    expect((await f.rpc({ op: 'release', region: 'eu', instance: 'instance-eu-1', room: 'ABCDE' })).status).toBe(409)
    expect((await f.request('GET', user.headers)).status).toBe(200)
    expect((await (await f.request('GET', user.headers)).json()).game).toBeNull()
  })

  it('shares verified identity and one global reservation between two real regional clients and two device sessions', async () => {
    const f = await fixture()
    const user = await f.player('two-devices@example.com')
    await f.request('POST', user.headers, { name: 'CinderFox', color: 0x2e7bff })
    let handler = f.accounts.handler
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => handler(new Request(url, init)))
    const config = { url: origin, token: regionsToken, log: () => {}, allowInsecureForTests: true }
    const eu = regionalAccounts({ ...config, region: 'eu' })
    const us = regionalAccounts({ ...config, region: 'us' })
    cleanups.push(eu.close, us.close)
    await Promise.all([eu.register(), us.register()])
    const ticket = await (await f.request('POST', user.headers, {}, '/api/account/admission')).json() as { token: string }
    const identity = await eu.verify(ticket.token)
    expect(identity).toEqual({ id: user.id, name: 'CinderFox', color: 0x2e7bff, ratingKey: `a_${user.id}`, cosmetics: { victory: null, robe: null } })
    const [first, other] = await Promise.all([eu.claim(identity.id, 'ABCDE'), us.claim(identity.id, 'FGHIJ')])
    expect(first).toEqual({ ok: true })
    expect(other).toEqual({ ok: false, game: { region: 'eu', room: 'ABCDE' } })
    const secondDevice = await f.login(user.id)
    const secondTicket = await (await f.request('POST', secondDevice, {}, '/api/account/admission')).json() as { token: string }
    expect(await us.verify(secondTicket.token)).toEqual(identity)
    expect(await us.game(identity.id)).toEqual({ region: 'eu', room: 'ABCDE' })
    const reopened = await openAccounts(f.config)
    cleanups.push(reopened.close)
    handler = reopened.handler
    expect(await eu.game(identity.id)).toEqual({ region: 'eu', room: 'ABCDE' })
    eu.release('ABCDE', identity.id)
    // game() waits for a pending release before asking the shared authority.
    expect(await eu.game(identity.id)).toBeNull()
    expect(await us.claim(identity.id, 'FGHIJ')).toEqual({ ok: true })
    expect((await (await f.request('GET', secondDevice)).json()).game).toEqual({ region: 'us', room: 'FGHIJ' })
  })

  it('credits a real authority once after a committed reply is lost and the regional reward outbox restarts', async () => {
    const f = await fixture()
    const user = await f.player('reward-recovery@example.com')
    await f.request('POST', user.headers, { name: 'AshMage', color: null })
    vi.useFakeTimers()
    let loseReply = true
    const delivered: ProgressionReceipt[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { op: string; receipt: ProgressionReceipt }
      const response = await f.accounts.handler(new Request(url, init))
      if (body.op === 'reward') {
        delivered.push(body.receipt)
        if (loseReply) { loseReply = false; throw new Error('Connection lost after reward commit') }
      }
      return response
    })
    const options = { url: origin, token: regionsToken, region: 'eu', rewardFile: `${f.config.file}.rewards`, log: () => {}, allowInsecureForTests: true }
    let client = regionalAccounts(options)
    cleanups.push(() => client.close())
    await client.register()
    const receipt: ProgressionReceipt = {
      matchId: 'match-real-recovery', queue: 'quick', rulesVersion: 1, completedAt: Date.now(), durationSeconds: 180,
      players: [{ accountId: user.id, completed: true, aliveSeconds: 140, casts: 25, damageDealt: 700, walked: 6000, roundsPlayed: 3, roundsWon: 1, won: false }],
    }
    expect(await client.reward(receipt)).toBe('pending')
    const snapshot = async () => (await (await f.request('GET', user.headers, undefined, '/api/progression')).json()) as { balance: number; recentRewards: unknown[] }
    const first = await snapshot()
    expect(first.balance).toBeGreaterThan(0)
    expect(first.recentRewards).toHaveLength(1)
    client.close()
    client = regionalAccounts(options)
    await client.register()
    await vi.advanceTimersByTimeAsync(2000)
    expect(delivered).toEqual([receipt, receipt])
    expect((await snapshot()).balance).toBe(first.balance)
    expect((await snapshot()).recentRewards).toHaveLength(1)
    expect(await client.reward(receipt)).toBe('awarded')
    expect((await snapshot()).balance).toBe(first.balance)
    const conflict = await f.rpc({ op: 'reward', receipt: { ...receipt, durationSeconds: 181 } })
    expect(conflict.status).toBe(409)
    expect((await snapshot()).balance).toBe(first.balance)
  })
})

describe('account names and configuration', () => {
  it('normalizes compatibility characters without accepting ambiguous scripts, controls, or system names', () => {
    expect(accountName('  ＡshMage  ')).toEqual({ name: 'AshMage', key: 'ashmage' })
    for (const name of ['аshMage', 'Admin', 'a', '12Mage', 'Ash Mage', 'Ash\u200bMage', 'Ash\nMage', '\tAshMage', 'AshMage\n', 'Brawlock', 'x'.repeat(17), null]) expect(accountName(name)).toBeNull()
  })

  it('refuses insecure or incomplete authority configuration', () => {
    const config = { database: null, origin, secret, providers }
    for (const bad of ['http://game.example', 'https://game.example/', 'https://game.example/path', 'https://user:pass@game.example']) {
      expect(() => accountOptions({ ...config, origin: bad })).toThrow(/origin/)
    }
    expect(() => accountOptions({ ...config, secret: 'short' })).toThrow(/secret/)
    expect(() => accountOptions({ ...config, providers: {} })).toThrow(/provider/)
    expect(() => accountOptions({ ...config, providers: { google: { clientId: '', clientSecret: 'test' } } })).toThrow(/client ID/)
  })
})
