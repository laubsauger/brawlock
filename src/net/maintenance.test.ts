import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openMaintenance } from '../../server/maintenance.mjs'
import { openTestDatabase, removeDir, tempDir } from '../../server/test-dir.mjs'
import { createBot } from '../bots'
import { createMatch, DEFAULT_SETTINGS, step } from '../sim'
import { killPawn } from '../sim/combat'
import type { SimState } from '../sim/types'
import { createServerCore, DEFAULT_SERVER_CONFIG, type ServerCore } from './server'
import { decode, encode, PROTOCOL_VERSION, type Msg } from './protocol'
import type { VerifiedAccount } from './accounts'
import { MAINTENANCE_NOTICE, validMaintenance } from './maintenance'
import { Online } from './online'
import type { ProgressionReceipt } from '../../server/progression.mjs'

const cleanups: (() => void)[] = []
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { for (const close of cleanups.reverse()) close(); cleanups.length = 0; vi.clearAllTimers(); vi.useRealTimers() })

function fixture(extra: Partial<Parameters<typeof createServerCore>[1]> = {}) {
  let now = 0
  let state: SimState | null = null
  const pulses = new Set<(now: number) => void>()
  const core = createServerCore({ ...DEFAULT_SERVER_CONFIG, region: 'eu', build: 'dev-maintenance',
    quickplay: { ...DEFAULT_SERVER_CONFIG.quickplay, bots: 'dummy', fill: 3, minHumans: 1, fillMs: 1, startMs: 1, nextMs: 10, settings: { ...DEFAULT_SERVER_CONFIG.quickplay.settings, shopSeconds: 0, winScore: 1 } },
    ranked: { ...DEFAULT_SERVER_CONFIG.ranked, bots: 'dummy', fill: 3, minHumans: 1, fillMs: 1, startMs: 1, nextMs: 10, settings: { ...DEFAULT_SERVER_CONFIG.ranked.settings, shopSeconds: 0 } },
  }, {
    defaultSettings: DEFAULT_SETTINGS,
    createMatch: (...args) => (state = createMatch(...args)), step: (next, inputs) => { state = next; step(next, inputs) }, createBot,
    startClock: (pulse) => { pulses.add(pulse); return () => { pulses.delete(pulse) } },
    now: () => now, random: () => 0.42, log: () => {}, ...extra,
  })
  cleanups.push(() => core.close())
  const http = (path: string, method = 'POST') => core.http({ method, path, ip: 'fixture', origin: 'https://play.test', body: '' })
  const advance = async (ms: number) => {
    for (let left = ms; left > 0;) {
      const dt = Math.min(left, 20); left -= dt; now += dt
      for (const pulse of pulses) pulse(now)
      await vi.advanceTimersByTimeAsync(dt)
    }
  }
  return { core, http, advance, state: () => state! }
}

function connect(core: ServerCore, code: string, key: string, account?: VerifiedAccount | null, greet = true) {
  const messages: Msg[] = []
  let receive!: (text: string) => void
  let onClose!: () => void
  let closed = false
  const socket = {
    send(text: string) {
      if (text.startsWith('#p')) receive?.(`#q${text.slice(2)}`)
      else if (text.startsWith('{')) { const message = decode(text); if (message) messages.push(message) }
    },
    close() { if (!closed) { closed = true; onClose?.() } },
    onText(callback: (text: string) => void) { receive = callback },
    onClose(callback: () => void) { onClose = callback },
  }
  core.attach({ kind: 'room', code }, socket, key, account)
  const send = (message: Msg) => receive(encode(message))
  if (greet) send({ t: 'hello', version: PROTOCOL_VERSION, name: key, key, profileId: `profile-${key}`, device: `device-${key}`, color: null, build: 'dev-maintenance' })
  return { messages, send, close: socket.close, closed: () => closed }
}

const identity = (id: string): VerifiedAccount => ({ id, ratingKey: `a_${id}`, name: id, color: null, cosmetics: { victory: null, head: null, back: null, robe: null, emblem: null, staff: null }, connection: { device: '1'.repeat(64), controller: 'a'.repeat(64), takeover: false } })

describe('persistent regional maintenance', () => {
  it('persists drain across reopen, resets explicitly, and refuses malformed stored state', () => {
    const dir = tempDir('brawlock-maintenance-')
    cleanups.push(() => removeDir(dir))
    const file = `${dir}/maintenance.sqlite`
    let store = openMaintenance(file)
    expect(store.get()).toEqual({ draining: false, message: null })
    store.set({ draining: true, message: 'Europe is updating.' }); store.close()
    store = openMaintenance(file)
    expect(store.get()).toEqual({ draining: true, message: 'Europe is updating.' })
    store.set({ draining: false, message: null }); store.close()
    const db = openTestDatabase(file)
    db.exec('DELETE FROM regional_maintenance'); db.close()
    expect(() => openMaintenance(file)).toThrow('persisted regional maintenance')
    for (const bad of [{ draining: true }, { draining: false, message: 'stale' }, { draining: true, message: 'x'.repeat(161) }, { draining: true, message: 'bad\nmessage' }, { draining: true, message: null, admin: true }]) expect(validMaintenance(bad)).toBe(false)
  })

  it('blocks new rooms and queue reservations, preserves discovery, and reopens explicitly', async () => {
    const f = fixture()
    const room = await f.core.createRoom({ code: 'ABCDE' })
    f.core.setMaintenance({ draining: true, message: null })
    for (const path of ['/rooms', '/quickplay', '/ranked', '/listings']) expect((await f.http(path)).status).toBe(503)
    await expect(f.core.createRoom()).rejects.toThrow(MAINTENANCE_NOTICE)
    expect(JSON.parse((await f.http('/rooms/ABCDE', 'GET')).body)).toMatchObject({ exists: true })
    expect(JSON.parse((await f.http('/health', 'GET')).body)).toMatchObject({ ok: true, maintenance: { draining: true } })
    expect(f.core.maintenance()).toMatchObject({ activeMatches: 0, waitingRooms: 1, ready: true })
    expect(room.screen()).toBe('lobby')
    f.core.setMaintenance({ draining: false, message: null })
    expect((await f.http('/rooms')).status).toBe(201)
  })

  it('cancels pending automatic starts and prevents manual owner start/rematch controls', async () => {
    const f = fixture()
    const auto = await f.core.createRoom({ code: 'ABCDE', quick: 'dummy' })
    connect(f.core, auto.code, 'automatic')
    f.core.setMaintenance({ draining: true, message: null })
    await f.advance(500)
    expect(auto.screen()).toBe('lobby')
    f.core.setMaintenance({ draining: false, message: null })
    const manual = await f.core.createRoom({ code: 'FGHJK', bots: ['dummy'] })
    const owner = connect(f.core, manual.code, 'owner')
    owner.send({ t: 'ctl', op: 'addBot', difficulty: 'dummy' })
    f.core.setMaintenance({ draining: true, message: null })
    owner.send({ t: 'ctl', op: 'start' }); owner.send({ t: 'ctl', op: 'rematch' })
    expect(manual.screen()).toBe('lobby')
    expect(owner.messages.some((m) => m.t === 'lobby' && !!m.room?.maintenance)).toBe(true)
    const newcomer = connect(f.core, manual.code, 'newcomer')
    expect(newcomer.messages.some((m) => m.t === 'error' && m.message.includes('another region'))).toBe(true)
  })

  it('lets an existing guest reclaim a disconnected match seat and keeps its Guest prefix on rename', async () => {
    const f = fixture()
    const room = await f.core.createRoom({ code: 'ABCDE', quick: 'dummy' })
    const first = connect(f.core, room.code, 'original', null)
    first.send({ t: 'rename', name: 'ReservedFox' })
    expect(room.debug().peers).toBe(1)
    expect(first.messages.some((m) => m.t === 'lobby' && m.slots.some((slot) => slot.name === 'Guest ReservedFox'))).toBe(true)
    await f.advance(100)
    expect(room.screen()).toBe('match')
    const keeper = connect(f.core, room.code, 'keeper', null)
    expect(keeper.messages.some((message) => message.t === 'start' && message.waiting === true)).toBe(true)
    const pending = connect(f.core, room.code, 'handshake', undefined, false)
    expect(f.core.stats()).toMatchObject({ connections: 3, players: 2 })
    pending.close()
    f.core.setMaintenance({ draining: true, message: null })
    first.close()
    expect(f.core.stats().players).toBe(1) // The disconnected human slot remains, its population count does not.
    const replacement = connect(f.core, room.code, 'original', null)
    expect(replacement.messages.some((m) => m.t === 'welcome')).toBe(true)
    expect(replacement.messages.some((m) => m.t === 'start')).toBe(true)
    const newcomer = connect(f.core, room.code, 'intruder', null)
    expect(newcomer.messages.some((m) => m.t === 'error')).toBe(true)
    expect(f.core.maintenance()).toMatchObject({ activeMatches: 1, ready: false })
  })

  it('finishes all ranked rounds and its tied final, snapshots rewards before slow Elo, and never rematches during drain', async () => {
    let resolveRating!: (value: { status: 'unrated'; reason: string }) => void
    const record = vi.fn(() => new Promise<{ status: 'unrated'; reason: string }>((resolve) => { resolveRating = resolve }))
    const reward = vi.fn(async (_receipt: ProgressionReceipt) => 'awarded' as const)
    let pending = { rewards: 0, releases: 0 }
    const accounts = { attachPlay: vi.fn(), checkPlay: vi.fn(), detachPlay: vi.fn(), reward, pending: () => pending, release: vi.fn(), started: vi.fn(), disconnected: vi.fn(), close() {}, names: async () => new Map(), verify: vi.fn(), game: vi.fn(), claim: vi.fn() }
    const f = fixture({ ratingAuthority: { record, rename: async () => true, read: async () => ({ status: 200, body: {} }), pending: () => 0 }, accounts })
    const room = await f.core.createRoom({ code: 'ABCDE', quick: 'dummy', ranked: true })
    const a = connect(f.core, room.code, 'ann', identity('AccountAnn'))
    const b = connect(f.core, room.code, 'bob', identity('AccountBob'))
    await f.advance(100)
    expect(room.screen()).toBe('match')
    f.core.setMaintenance({ draining: true, message: null })
    for (const winner of [0, 1, 0, 1, 2]) {
      for (let i = 0; f.state().phase !== 'fight' && i < 1000; i++) await f.advance(20)
      expect(f.state().phase, `round ${f.state().round}, tick ${f.state().tick}, remaining ${f.state().phaseTicksLeft}`).toBe('fight')
      for (const pawn of f.state().pawns) if (pawn.owner !== winner && pawn.alive) killPawn(f.state(), pawn, null, 'lava')
      await f.advance(3100)
    }
    expect(f.state().rankedFinal?.contenders).toEqual([0, 1])
    for (let i = 0; f.state().phase !== 'fight' && i < 1000; i++) await f.advance(20)
    for (const pawn of f.state().pawns) if (pawn.owner !== 0 && pawn.alive) killPawn(f.state(), pawn, null, 'lava')
    await f.advance(4000)
    expect(record).toHaveBeenCalledOnce()
    expect(reward).toHaveBeenCalledOnce()
    const receipt = reward.mock.calls[0][0]
    expect(receipt.players).toMatchObject([{ accountId: 'AccountAnn', completed: true }, { accountId: 'AccountBob', completed: true }])
    expect(receipt.players.every((p) => p.completed)).toBe(true)
    expect(f.core.maintenance().pendingResults).toBe(1)
    a.close()
    pending = { rewards: 1, releases: 1 }
    resolveRating({ status: 'unrated', reason: 'Fixture settlement' })
    await f.advance(500)
    expect(room.screen()).toBe('results')
    await f.advance(1000)
    expect(room.screen()).toBe('results')
    expect(receipt.players.every((p) => p.completed)).toBe(true)
    expect(f.core.maintenance()).toMatchObject({ pendingResults: 0, pendingRewards: 1, pendingReleases: 1, ready: false })
    pending = { rewards: 0, releases: 0 }
    b.close()
    expect(f.core.maintenance().ready).toBe(true)
    expect(record).toHaveBeenCalledOnce()
  })

  it('does not reward custom bot presets or per-room rules as official quick play', async () => {
    const reward = vi.fn(async () => 'awarded' as const)
    for (const setup of [{ quick: 'easy' as const }, { quick: 'dummy' as const, settings: { startGold: 999 } }]) {
      const f = fixture({ accounts: { reward, release() {}, started() {}, close() {} } as never })
      const room = await f.core.createRoom({ code: 'ABCDE', ...setup })
      connect(f.core, room.code, 'ann', identity('AccountAnn'))
      await f.advance(100)
      for (const pawn of f.state().pawns) if (pawn.owner !== 0 && pawn.alive) killPawn(f.state(), pawn, null, 'lava')
      await f.advance(4000)
      expect(room.results()).toHaveLength(1)
      f.core.setMaintenance({ draining: true, message: null })
    }
    expect(reward).not.toHaveBeenCalled()
  })

  it('leaves draining regions reachable for exact reconnect while choosing another region only for new games', async () => {
    const fetch = vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => url.endsWith('/health')
      ? { ok: true, protocol: PROTOCOL_VERSION, build: 'dev-test', maintenance: url.includes('eu.test') ? { draining: true, message: 'Europe update' } : null }
      : { exists: true } }))
    const online = new Online({ regions: [{ id: 'eu', label: 'Europe', url: 'wss://eu.test' }, { id: 'us', label: 'US', url: 'wss://us.test' }], build: 'dev-test', fetch })
    expect((await online.choose('auto'))?.id).toBe('us')
    expect((await online.choose('eu'))).toMatchObject({ id: 'eu', state: 'up', maintenance: { draining: true } })
    expect(await online.roomExists('eu', 'ABCDE')).toBe(true)
    expect(fetch.mock.calls.at(-1)?.[0]).toBe('https://eu.test/rooms/ABCDE')
  })
})
