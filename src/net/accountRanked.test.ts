/** Production HTTP/WS account boundary over real loopback TCP, without rendering. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { betterAuth } from 'better-auth'
import { testUtils } from 'better-auth/plugins'
import { accountOptions, openAccounts } from '../../server/accounts.mjs'
import { startServer } from '../../server/listen.mjs'
import { openTestDatabase, removeDir, tempDir } from '../../server/test-dir.mjs'
import { createBot } from '../bots'
import { createMatch, DEFAULT_SETTINGS, step } from '../sim'
import type { SimState } from '../sim/types'
import type { LobbyView, Screen } from '../game/store'
import { DEFAULT_SERVER_CONFIG } from './server'
import { createSession } from './session'
import { startClock } from './clock'
import { PROTOCOL_VERSION } from './protocol'
import { wsNet } from './ws'

const authOrigin = 'http://localhost:5352'
const playOrigin = 'https://brawlock.test'
const secret = 'public-test-account-secret-0123456789abcdef'
const regionsToken = 'public-test-region-secret-0123456789abcdef'
const providers = { google: { clientId: 'test-client', clientSecret: 'test-provider-secret' } }
const scale = 4
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.reverse()) await close()
  cleanup.length = 0
  vi.unstubAllGlobals()
})

// generous limits: these are real TCP + account round trips, slow only when the whole suite
// runs in parallel; the waits return as soon as their condition holds
async function until(predicate: () => boolean, description: string, ms = 10_000) {
  const start = performance.now()
  while (!predicate()) {
    if (performance.now() - start > ms) throw new Error(`Timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

// Node 24's WebSocketInit supports headers. DOM typings expose browser protocols only.
const NativeSocket = globalThis.WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket
function socketClass(origin: string, urls: string[]) {
  return class extends NativeSocket {
    constructor(url: string) { urls.push(url); super(url, { headers: { origin } }) }
  }
}

async function fixture({ both = false, autoStart = false } = {}) {
  const dir = tempDir('brawlock-account-tcp-')
  cleanup.push(() => removeDir(dir))
  const file = `${dir}/accounts.sqlite`
  const accounts = await openAccounts({ file, origin: authOrigin, secret, regionsToken, providers, migrate: true })
  cleanup.push(accounts.close)
  const db = openTestDatabase(file)
  cleanup.push(() => db.close())
  const options = accountOptions({ database: db, origin: authOrigin, secret, providers })
  const auth = betterAuth({ ...options, plugins: [...options.plugins ?? [], testUtils()] })
  const { test } = await auth.$context
  const realFetch = globalThis.fetch
  const urls: string[] = []
  const proofs: string[] = []
  const proofOwners = new Map<string, { headers: Headers; user: string; device: string; controller: string }>()
  const permissions = new Map<string, { token: string; id: string }>()
  const cookies = new Map<string, string>()
  async function playRequest(headers: Headers, body: { action: string; device: string; controller: string; target?: { mode: string; region: string | null; code: string | null }; token?: string; id?: string }) {
    const from = new Headers(headers); from.set('origin', authOrigin); from.set('content-type', 'application/json'); from.set('x-brawlock-client-ip', 'test-play-browser')
    const cookie = cookies.get(body.device)
    if (cookie) from.set('cookie', [from.get('cookie'), cookie].filter(Boolean).join('; '))
    const response = await accounts.handler(new Request(`${authOrigin}/api/play`, { method: 'POST', headers: from, body: JSON.stringify(body) }))
    const issued = response.headers.get('set-cookie')
    if (issued) cookies.set(body.device, issued.split(';')[0])
    return { status: response.status, body: await response.json() as { ok: boolean; token?: string; id?: string; conflict?: { id: string } } }
  }
  const logs: unknown[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    urls.push(url)
    if (new URL(url).origin === authOrigin) return accounts.handler(new Request(input, init))
    return realFetch(input, init)
  })
  async function player(email: string, name: string, color: number | null = null) {
    const user = test.createUser({ email, name: 'Provider display name' })
    await test.saveUser(user)
    async function login() {
      const session = await test.login({ userId: user.id })
      const headers = new Headers(session.headers)
      headers.set('origin', authOrigin)
      headers.set('content-type', 'application/json')
      return headers
    }
    const headers = await login()
    const claimed = await accounts.handler(new Request(`${authOrigin}/api/account`, { method: 'POST', headers, body: JSON.stringify({ name, color }) }))
    expect(claimed.status).toBe(200)
    async function ticket(from = headers, control: { device?: string; controller?: string; takeover?: boolean } = {}) {
      const response = await accounts.handler(new Request(`${authOrigin}/api/account/admission`, { method: 'POST', headers: from, body: JSON.stringify({ device: `browser-${user.id}`, controller: `tab-${user.id}`, ...control }) }))
      expect(response.status).toBe(200)
      const result = await response.json() as { token: string }
      proofs.push(result.token)
      proofOwners.set(result.token, { headers: from, user: user.id, device: control.device ?? `browser-${user.id}`, controller: control.controller ?? `tab-${user.id}` })
      return result.token
    }
    return { id: user.id, ratingKey: `a_${user.id}`, name, color, headers, login, ticket }
  }
  async function region(id: string, authority?: string) {
    const srv = await startServer({ port: 0, build: 'dev-account-tcp', timeScale: scale,
      dataDir: `${dir}/${id}`, accountsAuthorityUrl: authOrigin, accountsAllowInsecureForTests: true,
      ratingAuthorityUrl: authority ?? '', ratingAuthorityToken: regionsToken, ratingAuthorityAllowInsecureForTests: true,
      config: { region: id, allowedOrigins: [playOrigin],
        ranked: { ...DEFAULT_SERVER_CONFIG.ranked, startMs: autoStart ? 100 : 60_000,
          settings: { ...DEFAULT_SERVER_CONFIG.ranked.settings, shopSeconds: 0.1 } } },
      log: (level, event, fields) => logs.push({ level, event, fields }),
    })
    cleanup.push(() => srv.close())
    const http = `http://127.0.0.1:${srv.port}`
    const ws = `ws://127.0.0.1:${srv.port}`
    async function queue(token?: string, origin = playOrigin) {
      const response = await fetch(`${http}/ranked`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(token === undefined ? {} : { accountToken: token }) })
      const body = await response.json() as { code?: string; game?: { region: string; room: string }; error?: string }
      return { status: response.status, body }
    }
    return { srv, http, ws, queue }
  }
  const us = await region('us')
  const eu = both ? await region('eu', us.http) : null
  function client(server: { ws: string }, authorize: () => Promise<string | null>, overrides: { profileId?: string; name?: string; device?: string; key?: string; origin?: string } = {}) {
    let permission: { token: string; id: string } | null = null
    let ownsPermission = false
    let permissionKey = '', owner: { headers: Headers; user: string; device: string; controller: string } | null = null
    let releasing: Promise<unknown> = Promise.resolve()
    const releasePermission = () => {
      if (!permission || !owner || !ownsPermission) return releasing
      const old = permission; permission = null; permissions.delete(permissionKey)
      releasing = playRequest(owner.headers, { action: 'release', device: owner.device, controller: owner.controller, token: old.token })
      return releasing
    }
    const authorizePlay = async () => {
      const token = await authorize()
      owner = token ? proofOwners.get(token) ?? null : { headers: new Headers(), user: 'guest', device: overrides.device ?? 'guest-browser-id', controller: overrides.key ?? 'guest-controller-id' }
      if (!owner) throw new Error('Unknown fixture proof')
      permissionKey = `${owner.user}:${owner.device}:${owner.controller}`
      permission = permissions.get(permissionKey) ?? null
      if (!permission) {
        const result = await playRequest(owner.headers, { action: 'acquire', device: owner.device, controller: owner.controller, target: { mode: 'server', region: null, code: null } })
        if (!result.body.ok || !result.body.token || !result.body.id) throw new Error('Your game is active in another tab or device.')
        permission = { token: result.body.token, id: result.body.id }; permissions.set(permissionKey, permission); proofs.push(permission.token)
        ownsPermission = true
      }
      return token
    }
    let lobby = { role: 'offline', joinUrl: null, roomCode: null, status: 'idle', error: null, slots: [], settings: null, localPlayer: 0, pings: {}, ready: {} } as LobbyView
    let screen: Screen = 'menu'
    let state: SimState | null = null
    const Ctor = socketClass(overrides.origin ?? playOrigin, urls) as unknown as NonNullable<Parameters<typeof wsNet>[1]>
    const session = createSession({
      ui: { lobby: () => lobby, setLobby: (patch) => { lobby = { ...lobby, ...patch }; if (patch.status === 'error') void releasePermission() }, screen: () => screen,
        setScreen: (value) => { screen = value }, setResult() {}, paused: () => false, onScreen: () => () => {} },
      profile: () => ({ id: overrides.profileId ?? 'forged-public-profile', name: overrides.name ?? 'ForgedClientName', color: 0xff00ff }),
      frame: { reset() {}, setLocalPlayer() {}, pushState: (value) => { state = value }, pushEvents() {}, setNet() {} },
      input: { drain: () => [] }, audio: { playEvents() {} }, createMatch, step, createBot, defaultSettings: DEFAULT_SETTINGS,
      net: wsNet(server.ws, Ctor, authorizePlay, undefined, () => { if (!permission) throw new Error('Missing fixture game permission'); return permission.token }),
      startClock: (pulse) => startClock((time) => pulse(time * scale)), now: () => performance.now() * scale,
      random: Math.random, joinUrl: (code) => code, clientKey: () => overrides.key ?? 'forged-client-key',
      device: () => overrides.device ?? 'forged-private-device', build: 'dev-account-tcp',
    })
    const controlledSession = { ...session, leave(transfer = false) { session.leave(transfer); return releasePermission() } }
    cleanup.push(async () => { await controlledSession.leave() })
    return { session: controlledSession, lobby: () => lobby, screen: () => screen, state: () => state, play: () => permission }
  }
  function privateProof(token: string) {
    return accounts.handler(new Request(`${authOrigin}/internal/accounts`, { method: 'POST',
      headers: { authorization: `Bearer ${regionsToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'verify', token }) }))
  }
  function safeLogs() {
    for (const proof of proofs) {
      expect(JSON.stringify(urls)).not.toContain(proof)
      expect(JSON.stringify(logs)).not.toContain(proof)
    }
    expect(JSON.stringify(logs)).not.toContain(regionsToken)
    expect(JSON.stringify(logs)).not.toContain(secret)
  }
  return { accounts, db, player, client, us, eu, urls, safeLogs, privateProof, playRequest }
}

describe('account-ranked production TCP boundary', () => {
  it.each(['leave', 'revoke'] as const)('preserves the sole casual player’s running match during a %s handoff, then closes on a normal departure', async (method) => {
    const f = await fixture()
    const room = await f.us.srv.createRoom({ quick: 'brutal', autoStartMs: 100, settings: { winScore: 50, shopSeconds: 0.1 } })
    const device = 'solo-transfer-browser', profileId = 'solo-transfer-profile'
    const first = f.client(f.us, async () => null, { device, profileId, key: 'solo-first-controller' })
    await first.session.join(room.code)
    await until(() => first.screen() === 'match', 'solo casual match start')
    const seat = first.lobby().localPlayer
    if (method === 'leave') await first.session.leave(true)
    else {
      await f.playRequest(new Headers(), { action: 'takeover', device, controller: 'solo-second-controller', id: first.play()!.id })
      await until(() => first.lobby().status === 'error', 'sole controller revocation', 8000)
    }
    await until(() => room.peers() === 0, 'old controller detached')
    // Cross the room's own empty-match check; pending handoffs must not reset the match.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(f.us.srv.core.room(room.code)).toBe(room)
    expect(room.screen()).toBe('match')
    const second = f.client(f.us, async () => null, { device, profileId, key: 'solo-second-controller' })
    await second.session.join(room.code)
    expect(second.lobby().status, second.lobby().error ?? '').toBe('open')
    expect(second.screen()).toBe('match')
    expect(second.lobby().localPlayer).toBe(seat)
    expect(room.peers()).toBe(1)
    await second.session.leave()
    await until(() => f.us.srv.core.room(room.code) === null, 'ordinary last-human departure cleanup')
    f.safeLogs()
  }, 30_000)

  it('never offers an unstarted ranked lobby as a game to rejoin and removes it when its only player leaves', async () => {
    const f = await fixture(), ann = await f.player('queue-leave@example.com', 'CinderFox')
    const queued = await f.us.queue(await ann.ticket())
    const current = async () => (await f.accounts.handler(new Request(`${authOrigin}/api/account`, { headers: ann.headers }))).json()
    expect((await current()).game).toBeNull()
    const first = f.client(f.us, ann.ticket)
    await first.session.join(queued.body.code!)
    expect(first.screen()).toBe('lobby')
    expect(f.db.prepare('SELECT room FROM ranked_occupancy WHERE user_id=?').get(ann.id)).toMatchObject({ room: queued.body.code })
    expect((await current()).game).toBeNull()
    await first.session.leave()
    await until(() => f.us.srv.core.room(queued.body.code!) === null, 'waiting ranked lobby removal')
    await until(() => !f.db.prepare('SELECT room FROM ranked_occupancy WHERE user_id=?').get(ann.id), 'waiting ranked reservation release')
    expect((await current()).game).toBeNull()
    const fresh = await f.us.queue(await ann.ticket())
    expect(fresh.status).toBe(201)
    expect(fresh.body.code).not.toBe(queued.body.code)
    f.safeLogs()
  }, 30_000)
  it('enforces one account across custom/casual rooms and regions even if a second connection reuses its live permission', async () => {
    const f = await fixture({ both: true }), ann = await f.player('global-custom@example.com', 'CinderFox')
    const firstRoom = await f.us.srv.createRoom({ public: true }), secondRoom = await f.eu!.srv.createRoom({ public: true })
    const first = f.client(f.us, ann.ticket)
    await first.session.join(firstRoom.code)
    expect(first.lobby().status).toBe('open')
    const copiedPermission = f.client(f.eu!, ann.ticket)
    await copiedPermission.session.join(secondRoom.code)
    expect(copiedPermission.lobby().status).toBe('error')
    expect(first.lobby().status).toBe('open')
    expect(f.us.srv.core.room(firstRoom.code)!.humans()).toBe(1)
    expect(f.eu!.srv.core.room(secondRoom.code)!.humans()).toBe(0)
    f.safeLogs()
  }, 30_000)

  it('blocks a guest browser from entering a second custom game or switching account to play it simultaneously', async () => {
    const f = await fixture({ both: true })
    const one = await f.us.srv.createRoom({ public: true }), two = await f.eu!.srv.createRoom({ public: true })
    const first = f.client(f.us, async () => null, { device: 'shared-guest-browser', key: 'guest-tab-one', profileId: 'guest-profile-one' })
    await first.session.join(one.code)
    expect(first.lobby().status).toBe('open')
    const second = f.client(f.eu!, async () => null, { device: 'shared-guest-browser', key: 'guest-tab-two', profileId: 'guest-profile-two' })
    await second.session.join(two.code)
    expect(second.lobby().status).toBe('error')
    const ann = await f.player('guest-switch@example.com', 'CinderFox')
    const switched = f.client(f.eu!, () => ann.ticket(ann.headers, { device: 'shared-guest-browser', controller: 'account-tab-one' }))
    await switched.session.join(two.code)
    expect(switched.lobby().status).toBe('error')
    expect(f.eu!.srv.core.room(two.code)!.humans()).toBe(0)
    f.safeLogs()
  }, 30_000)
  it('consumes the HTTP queue proof once, requires a fresh WS proof, and overrides hostile hello identity and cosmetics', async () => {
    const f = await fixture()
    const ann = await f.player('ann-tcp@example.com', 'CinderFox', 0x2e7bff)
    f.db.prepare('INSERT INTO progression_owned VALUES (?, ?, ?)').run(ann.id, 'robe-tattered', Date.now())
    f.db.prepare('INSERT INTO progression_equipped VALUES (?, ?, ?)').run(ann.id, 'robe', 'robe-tattered')
    const token = await ann.ticket()
    const queued = await f.us.queue(token)
    expect(queued.status).toBe(201)
    const code = queued.body.code!
    expect((await f.us.queue(token)).status).toBe(401)
    const reused = f.client(f.us, async () => token)
    await reused.session.join(code)
    expect(reused.lobby().status).toBe('error')
    const joined = f.client(f.us, ann.ticket, { profileId: 'a_someone-else', device: 'a_someone-else', name: 'Administrator' })
    await joined.session.join(code)
    expect(joined.lobby().status, joined.lobby().error ?? '').toBe('open')
    const self = joined.lobby().slots.find((s) => s.id === joined.lobby().localPlayer)!
    expect(self).toMatchObject({ name: 'CinderFox', profileId: ann.ratingKey, color: ann.color, cosmetics: { victory: null, head: null, back: null, robe: 'robe-tattered', emblem: null, staff: null } })
    joined.session.setDisplayName('NotReservedAnymore')
    const bob = await f.player('bob-tcp@example.com', 'AshMage', 0x14e0c8)
    const rival = f.client(f.us, bob.ticket, { profileId: ann.ratingKey, device: ann.ratingKey, name: ann.name, key: 'other-client-key' })
    await rival.session.join(code)
    expect(rival.lobby().status, rival.lobby().error ?? '').toBe('open')
    await until(() => joined.lobby().slots.filter((s) => s.kind === 'human').length === 2, 'two canonical account seats')
    expect(joined.lobby().slots.find((s) => s.id === self.id)?.name).toBe('CinderFox')
    expect(rival.lobby().slots.find((s) => s.id === rival.lobby().localPlayer)).toMatchObject({ name: bob.name, profileId: bob.ratingKey })
    expect(rival.lobby().localPlayer).not.toBe(self.id)
    f.safeLogs()
  }, 30_000)

  it('rejects ranked guests and guest-forged account namespaces while allowing ordinary casual guests', async () => {
    const f = await fixture()
    expect((await f.us.queue()).status).toBe(401)
    const ranked = await f.us.srv.createRoom({ quick: 'brutal', ranked: true })
    const guest = f.client(f.us, async () => null)
    await guest.session.join(ranked.code)
    expect(guest.lobby().status).toBe('error')
    expect(guest.lobby().error).toMatch(/sign in/i)
    const casual = await f.us.srv.createRoom()
    for (const overrides of [{ profileId: 'a_stolen-account' }, { device: 'a_stolen-account' }]) {
      const forged = f.client(f.us, async () => null, overrides)
      await forged.session.join(casual.code)
      expect(forged.lobby().status).toBe('error')
      expect(forged.lobby().error).toMatch(/sign in.*account.*identity/i)
    }
    const ordinary = f.client(f.us, async () => null, { profileId: 'guest-public-id', device: 'guest-device-id' })
    await ordinary.session.join(casual.code)
    expect(ordinary.lobby().status).toBe('open')
    await until(() => ordinary.lobby().slots.some((s) => s.kind === 'human'), 'the guest lobby snapshot')
    expect(ordinary.lobby().slots.find((s) => s.kind === 'human')?.name).toMatch(/^Guest ForgedClient/)
    ordinary.session.setDisplayName('CinderFox')
    await until(() => ordinary.lobby().slots.some((s) => s.name === 'Guest CinderFox'), 'guest rename keeps its guest identity')
    f.safeLogs()
  }, 30_000)

  it('checks HTTP and WS origins before consuming any proof and rejects revoked unused proofs', async () => {
    const f = await fixture()
    const ann = await f.player('origin-tcp@example.com', 'CinderFox')
    const queueProof = await ann.ticket()
    const blocked = await fetch(`${f.us.http}/ranked`, { method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'application/json' }, body: JSON.stringify({ accountToken: queueProof }) })
    expect(blocked.status).toBe(403)
    const queued = await f.us.queue(queueProof)
    expect(queued.status).toBe(201)
    const wsProof = await ann.ticket()
    const wrongOrigin = f.client(f.us, async () => wsProof, { origin: 'https://attacker.example' })
    await wrongOrigin.session.join(queued.body.code!)
    expect(wrongOrigin.lobby().status).toBe('error')
    const good = f.client(f.us, async () => wsProof)
    await good.session.join(queued.body.code!)
    expect(good.lobby().status, good.lobby().error ?? '').toBe('open')
    const revoked = await ann.ticket()
    expect((await f.accounts.handler(new Request(`${authOrigin}/api/auth/sign-out`, { method: 'POST', headers: ann.headers, body: '{}' }))).status).toBe(200)
    const afterLogout = f.client(f.us, async () => revoked, { key: 'new-device-key' })
    await afterLogout.session.join(queued.body.code!)
    expect(afterLogout.lobby().status).toBe('error')
    expect(afterLogout.lobby().error).toMatch(/sign in/i)
    expect((await f.privateProof(wsProof)).status).toBe(401)
    f.safeLogs()
  }, 30_000)

  it('keeps one account in one ranked game globally and rejects a second live device joining its seat', async () => {
    const f = await fixture({ both: true })
    const ann = await f.player('global-tcp@example.com', 'CinderFox')
    const secondProof = await ann.ticket(ann.headers, { device: 'second-device-identity', controller: 'second-device-tab' })
    const duplicateProof = await ann.ticket(ann.headers, { device: 'second-device-identity', controller: 'second-device-tab' })
    const first = await f.us.queue(await ann.ticket())
    expect(first.status).toBe(201)
    const original = f.client(f.us, ann.ticket, { key: 'device-one-key', device: 'device-one-identity' })
    await original.session.join(first.body.code!)
    expect(original.lobby().status).toBe('open')
    const elsewhere = await f.eu!.queue(secondProof)
    expect(elsewhere.status).toBe(409)
    expect(elsewhere.body.game).toEqual({ region: 'us', room: first.body.code })
    expect(f.eu!.srv.core.stats().rooms).toBe(0)
    const duplicate = f.client(f.us, async () => duplicateProof, { key: 'device-two-key', device: 'device-two-identity', profileId: 'another-browser-profile' })
    await duplicate.session.join(first.body.code!)
    expect(duplicate.lobby().status).toBe('error')
    expect(duplicate.lobby().error).toMatch(/active in another tab or device/i)
    expect(f.us.srv.core.room(first.body.code!)?.humans()).toBe(1)
    f.safeLogs()
  }, 30_000)

  it('transfers a live ranked seat explicitly and disconnects its old controller without adding another player', async () => {
    const f = await fixture({ autoStart: true })
    const ann = await f.player('transfer-a@example.com', 'CinderFox')
    const bob = await f.player('transfer-b@example.com', 'AshMage')
    const queued = await f.us.queue(await ann.ticket())
    const first = f.client(f.us, ann.ticket)
    const rival = f.client(f.us, bob.ticket)
    await first.session.join(queued.body.code!); await rival.session.join(queued.body.code!)
    await until(() => first.screen() === 'match', 'ranked match start')
    const seat = first.lobby().localPlayer
    const originalPermission = first.play()!
    await f.playRequest(ann.headers, { action: 'takeover', device: 'transfer-device-two', controller: 'transfer-tab-two', id: originalPermission.id })
    await until(() => first.lobby().status === 'error', 'global controller revocation', 8000)
    await until(() => (f.db.prepare('SELECT disconnected FROM ranked_occupancy WHERE user_id=?').get(ann.id) as { disconnected: number })?.disconnected === 1, 'global disconnect acknowledgement')
    const second = f.client(f.us, () => ann.ticket(ann.headers, { device: 'transfer-device-two', controller: 'transfer-tab-two', takeover: true }))
    await second.session.join(queued.body.code!)
    expect(second.lobby().status, second.lobby().error ?? '').toBe('open')
    expect(second.lobby().localPlayer).toBe(seat)
    expect(second.screen()).toBe('match')
    await until(() => first.lobby().status === 'error', 'old controller eviction')
    expect(first.lobby().error).toMatch(/moved to another tab or device/i)
    expect(f.us.srv.core.room(queued.body.code!)!.humans()).toBe(2)
    expect(f.us.srv.core.room(queued.body.code!)!.peers()).toBe(2)
    expect(second.lobby().slots.filter((slot) => slot.profileId === ann.ratingKey)).toHaveLength(1)
    f.safeLogs()
  }, 30_000)

  it('rejects stale concurrent tickets for different accounts on the same browser across regions', async () => {
    const f = await fixture({ both: true })
    const ann = await f.player('same-device-a@example.com', 'CinderFox')
    const bob = await f.player('same-device-b@example.com', 'AshMage')
    const control = { device: 'one-shared-browser', controller: 'first-account-tab' }
    const stale = await bob.ticket(bob.headers, { ...control, controller: 'second-account-tab' })
    const queued = await f.us.queue(await ann.ticket(ann.headers, control))
    const first = f.client(f.us, () => ann.ticket(ann.headers, control))
    await first.session.join(queued.body.code!)
    const duplicate = await f.eu!.queue(stale)
    expect(duplicate.status).toBe(409)
    expect(duplicate.body).toMatchObject({ rankedConflict: { kind: 'device', game: { region: 'us', room: queued.body.code } } })
    expect(f.eu!.srv.core.stats().rooms).toBe(0)
    expect(f.us.srv.core.room(queued.body.code!)!.humans()).toBe(1)
    f.safeLogs()
  }, 30_000)

  it('reconnects an authorized second device to the same seat in an active ranked match', async () => {
    const f = await fixture({ autoStart: true })
    const ann = await f.player('reconnect-a@example.com', 'CinderFox')
    const bob = await f.player('reconnect-b@example.com', 'AshMage')
    const queued = await f.us.queue(await ann.ticket())
    const first = f.client(f.us, ann.ticket, { key: 'original-device-key' })
    const other = f.client(f.us, bob.ticket, { key: 'other-account-key' })
    await first.session.join(queued.body.code!)
    await other.session.join(queued.body.code!)
    await until(() => first.screen() === 'match' && other.screen() === 'match', 'ranked match start')
    await until(() => (f.db.prepare('SELECT started FROM ranked_occupancy WHERE user_id=?').get(ann.id) as { started: number })?.started === 1, 'ranked match recovery activation')
    const activeAccount = await f.accounts.handler(new Request(`${authOrigin}/api/account`, { headers: ann.headers }))
    expect(await activeAccount.json()).toMatchObject({ game: { region: 'us', room: queued.body.code } })
    const seat = first.lobby().localPlayer
    first.session.leave()
    await until(() => f.us.srv.core.room(queued.body.code!)?.peers() === 1, 'original device disconnect')
    await until(() => (f.db.prepare('SELECT disconnected FROM ranked_occupancy WHERE user_id=?').get(ann.id) as { disconnected: number })?.disconnected === 1, 'global disconnect acknowledgement')
    f.db.prepare('INSERT INTO progression_owned VALUES (?, ?, ?)').run(ann.id, 'robe-emberveil', Date.now())
    f.db.prepare('INSERT INTO progression_equipped VALUES (?, ?, ?)').run(ann.id, 'robe', 'robe-emberveil')
    const secondDevice = await ann.login()
    const rejoined = f.client(f.us, () => ann.ticket(secondDevice, { device: 'second-device-identity', controller: 'second-device-tab' }), { key: 'reconnected-device-key', profileId: 'new-browser-profile', device: 'new-browser-device' })
    await rejoined.session.join(queued.body.code!)
    expect(rejoined.lobby().status, rejoined.lobby().error ?? '').toBe('open')
    expect(rejoined.lobby().localPlayer).toBe(seat)
    expect(rejoined.lobby().slots.filter((s) => s.profileId === ann.ratingKey)).toHaveLength(1)
    expect(rejoined.screen()).toBe('match')
    await until(() => [rejoined, other].every((client) => client.state()?.slots.find((slot) => slot.id === seat)?.cosmetics?.robe === 'robe-emberveil'), 'fresh authoritative cosmetics reach the returning and existing player')
    f.safeLogs()
  }, 30_000)

  it('requires the account frame before accepting a session hello', async () => {
    const f = await fixture()
    const room = await f.us.srv.createRoom()
    const Ctor = socketClass(playOrigin, f.urls)
    const socket = new Ctor(`${f.us.ws}/ws?room=${room.code}`)
    cleanup.push(() => socket.close())
    const response = new Promise<{ t: string; message?: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No account boundary response')), 3000)
      socket.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket handshake failed')) }
      socket.onmessage = (event) => { clearTimeout(timer); resolve(JSON.parse(String(event.data))) }
      socket.onopen = () => socket.send(JSON.stringify({ t: 'hello', name: 'Unverified', profileId: 'public-unverified', device: 'device-unverified', key: 'test-key', version: PROTOCOL_VERSION, color: null }))
    })
    expect(await response).toMatchObject({ t: 'error', message: expect.stringMatching(/account verification/i) })
    expect(room.humans()).toBe(0)
    expect(f.us.srv.core.stats().connections).toBe(0)
    f.safeLogs()
  }, 30_000)
})
