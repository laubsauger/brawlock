import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionDeps } from '../net/session'

const f = vi.hoisted(() => ({
  deps: null as SessionDeps | null,
  transport: null as 'p2p' | 'server' | null,
  profile: { id: 'stable-profile', name: 'Mira', color: null },
  requests: [] as { url: string; method: string; body?: string }[],
  directory: [] as Record<string, unknown>[],
  preferred: vi.fn(), peerJoin: vi.fn(), serverJoin: vi.fn(),
  storage: new Map<string, string>(),
  impl: {
    openOffline: vi.fn(), openHost: vi.fn(), join: vi.fn(), leave: vi.fn(),
    startMatch: vi.fn(), rematch: vi.fn(), setReady: vi.fn(),
    transport: (): 'server' | 'p2p' | null => f.transport,
    isActive: () => f.transport !== null,
    joinableSeats: () => 9,
    setDisplayName: vi.fn(), setPlayerColor: vi.fn(), startLobbyVote: vi.fn(), castLobbyVote: vi.fn(),
  },
}))
const version = vi.hoisted(() => ({ available: false, check: vi.fn(async () => {}), changed: null as (() => void) | null }))
vi.mock('../lib/buildVersion', () => ({
  BUILD_UPDATE_REQUIRED: 'Reload required',
  getBuildUpdate: () => version.available,
  ensureCurrentBuild: version.check,
  onBuildUpdate: (listener: () => void) => { version.changed = listener; return () => {} },
}))
vi.mock('./playControl', () => ({ connectPlayControl: vi.fn(), playControl: { acquire: vi.fn(async () => true), release: vi.fn(async () => {}), valid: () => true, update: vi.fn(async () => {}), token: () => 'p'.repeat(43) } }))
// This suite isolates entry coordination; account admission has real-TCP coverage.
// Supply a signed-in proof when the frozen release enables production account flags.
vi.mock('./account', () => ({ getAdmissionToken: vi.fn(async () => 'unit-account-proof'), saveAccountColor: vi.fn(async () => {}) }))
vi.mock('../audio', () => ({ audio: { playEvents: vi.fn() } }))
vi.mock('./input', () => ({ input: { drain: () => [] } }))
vi.mock('./profile', async (original) => ({ ...await original<typeof import('./profile')>(), getProfile: () => f.profile, setPreferredColor: f.preferred,
  safeLocalStorage: () => ({ getItem: (key: string) => f.storage.get(key) ?? null, setItem: (key: string, value: string) => { f.storage.set(key, value) } }),
}))
vi.mock('./device', () => ({ getDeviceId: () => 'stable-device' }))
vi.mock('../net/session', async (original) => ({
  ...await original<typeof import('../net/session')>(),
  createSession: (deps: SessionDeps) => { f.deps = deps; return f.impl },
}))
vi.mock('../net/peer', () => ({
  createPeerNet: () => ({
    host: async () => { f.transport = 'p2p'; return { id: 'ABCDE' } },
    join: async (code: string) => { f.peerJoin(code); f.transport = 'p2p'; return {} },
  }),
  peerNet: {
    host: async () => { f.transport = 'p2p'; return { id: 'ABCDE' } },
    join: async (code: string) => { f.peerJoin(code); f.transport = 'p2p'; return {} },
  },
  joinUrlFor: (code: string) => `http://test/?room=${code}`,
}))
vi.mock('../net/ws', async (original) => ({
  ...await original<typeof import('../net/ws')>(),
  wsNet: () => ({ join: async (code: string) => { f.serverJoin(code); f.transport = 'server'; return {} } }),
}))
vi.mock('../net/online', async (original) => {
  const actual = await original<typeof import('../net/online')>()
  const { PROTOCOL_VERSION } = await import('../net/protocol')
  return {
    ...actual,
    Online: class extends actual.Online {
      constructor(cfg: ConstructorParameters<typeof actual.Online>[0]) {
        super({ ...cfg, regions: [{ id: 'test', label: 'Test directory', url: 'ws://directory.test' }],
          fetch: async (url, init) => {
            f.requests.push({ url, method: init?.method ?? 'GET', body: init?.body })
            let body: unknown = {}
            if (url.endsWith('/health')) body = { ok: true, protocol: PROTOCOL_VERSION, build: cfg.build }
            else if (url.endsWith('/rooms?public=1')) body = { rooms: [], listings: f.directory }
            else if (url.endsWith('/listings') && init?.method === 'POST') body = { id: 'listing-id', token: 'secret', heartbeatS: 10 }
            else if (url.includes('/rooms/')) body = { exists: true }
            return { ok: true, status: 200, json: async () => body }
          },
        })
      }
    },
  }
})

import { useGame } from './store'
import { online, rejoin, session } from './session'
import { LEFT_REJOIN_MS } from '../net/rejoin'
import { DEFAULT_SETTINGS } from '../sim/config'
import { createMatch } from '../sim'
import { TICK_HZ } from '../sim/types'
import { playControl } from './playControl'

const ownSlot = (color = 0x2fd6c8) => ({ id: 0, kind: 'human' as const, name: 'Mira', profileId: f.profile.id, team: 0, color })
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

beforeEach(async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  vi.useFakeTimers()
  vi.clearAllMocks()
  version.available = false
  version.check.mockResolvedValue(undefined)
  rejoin.dismiss()
  f.transport = null
  f.requests.length = 0
  f.directory = []
  f.peerJoin.mockClear(); f.serverJoin.mockClear(); f.preferred.mockClear()
  useGame.getState().setLobby({ role: 'offline', status: 'idle', roomCode: null, slots: [], localPlayer: -1, error: null })
  f.impl.join.mockImplementation(async (code: string) => {
    await f.deps!.net.join(code)
    f.deps!.ui.setLobby({ role: 'client', status: 'open', roomCode: code, slots: [ownSlot()], localPlayer: 0, error: null })
  })
  f.impl.openHost.mockImplementation(async () => {
    await f.deps!.net.host()
    f.deps!.ui.setLobby({ role: 'host', status: 'open', roomCode: 'ABCDE', localPlayer: 0, settings: DEFAULT_SETTINGS,
      slots: [ownSlot(), ...Array.from({ length: 9 }, (_, i) => ({ id: i + 1, kind: 'bot' as const, name: `Bot ${i}`, team: 0, color: i }))], error: null })
    f.deps!.ui.setScreen('lobby')
  })
  f.impl.leave.mockImplementation(() => {
    f.transport = null
    f.deps!.ui.setLobby({ role: 'offline', status: 'idle', roomCode: null, slots: [], error: null })
    f.deps!.ui.setScreen('menu')
  })
  await online.probe(0)
})
afterEach(async () => {
  session.leave()
  await vi.advanceTimersByTimeAsync(0)
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('browser session listing and reconnect wiring', () => {
  it('keeps the authoritative lobby and public listing while browsing the menu, then follows the actual match start', async () => {
    await session.openHost()
    session.setPublic(true)
    await vi.advanceTimersByTimeAsync(0)
    const dials = f.impl.openHost.mock.calls.length
    const leaves = f.impl.leave.mock.calls.length
    useGame.getState().setScreen('menu')
    expect(f.deps!.ui.screen()).toBe('lobby')
    expect(session.roomPhase()).toBe('lobby')
    await vi.advanceTimersByTimeAsync(11000)
    const listing = [...f.requests].reverse().find((r) => r.url.endsWith('/listings/listing-id') && r.method === 'PUT')
    expect(JSON.parse(listing!.body!)).toMatchObject({ code: 'ABCDE', phase: 'lobby' })
    expect(f.impl.leave).toHaveBeenCalledTimes(leaves)
    expect(session.resume()).toBe(true)
    expect(useGame.getState().screen).toBe('lobby')
    expect(f.impl.openHost).toHaveBeenCalledTimes(dials)
    useGame.getState().setScreen('menu')
    f.deps!.ui.setScreen('match')
    expect(useGame.getState().screen).toBe('match')
    expect(session.roomPhase()).toBe('match')
  })

  it('waits for a current-build check before reserving any seat or acquiring play permission', async () => {
    const check = deferred<void>()
    version.check.mockReturnValue(check.promise)
    const post = vi.spyOn(online, 'quickPlay')
    const opening = session.quickPlay({ region: 'test' })
    expect(playControl.acquire).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
    version.available = true
    version.changed!()
    check.resolve()
    expect(await opening).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(playControl.acquire).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
    expect(f.impl.join).not.toHaveBeenCalled()
  })

  it('reports a failed entry version check without acquiring permission or opening a game', async () => {
    version.check.mockRejectedValue(new Error('Could not check the game version. Please try again.'))
    expect(await session.openHost()).toMatchObject({ ok: false, message: 'Could not check the game version. Please try again.' })
    expect(playControl.acquire).not.toHaveBeenCalled()
    expect(f.impl.openHost).not.toHaveBeenCalled()
    expect(useGame.getState().screen).toBe('menu')
  })

  it('leaves a waiting lobby on an update and blocks joins, queues, resume, start and rematch until reload', async () => {
    await session.openHost()
    expect(session.isActive()).toBe(true)
    version.available = true
    version.changed!()
    expect(session.isActive()).toBe(false)
    expect(useGame.getState().screen).toBe('menu')
    vi.clearAllMocks()
    await session.openOffline(); await session.openPractice(); await session.openHost(); await session.openHostServer('test')
    await session.quickPlay({ region: 'test' }); await session.rankedPlay({ region: 'test' }); await session.join('ABCDE', { kind: 'p2p' })
    expect(session.resume()).toBe(false)
    session.startMatch(); session.rematch(); session.setReady(true)
    for (const call of [playControl.acquire, f.impl.openOffline, f.impl.openHost, f.impl.join, f.impl.startMatch, f.impl.rematch, f.impl.setReady]) expect(call).not.toHaveBeenCalled()
  })

  it('does not leave a match already in progress when an update notification arrives', async () => {
    await session.openHost()
    f.deps!.ui.setScreen('match')
    f.impl.leave.mockClear()
    version.available = true
    version.changed!()
    expect(f.impl.leave).not.toHaveBeenCalled()
    expect(session.isActive()).toBe(true)
    expect(useGame.getState().screen).toBe('match')
  })

  it.each(['startMatch', 'rematch', 'setReady'] as const)('waits for a version check before %s and cancels it if the room was left', async (action) => {
    await session.openHost()
    const check = deferred<void>()
    version.check.mockReturnValue(check.promise)
    if (action === 'setReady') session.setReady(true)
    else session[action]()
    expect(f.impl[action]).not.toHaveBeenCalled()
    session.leave()
    check.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.impl[action]).not.toHaveBeenCalled()
  })

  it('starts only after the successful fresh check and keeps ready cancellation immediate', async () => {
    await session.openHost()
    const check = deferred<void>()
    version.check.mockReturnValue(check.promise)
    session.startMatch()
    expect(f.impl.startMatch).not.toHaveBeenCalled()
    session.setReady(false)
    expect(f.impl.setReady).toHaveBeenCalledWith(false)
    check.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.impl.startMatch).toHaveBeenCalledOnce()
  })

  it('does not restore Ready after the player cancels while the version check is pending', async () => {
    await session.openHost()
    const check = deferred<void>()
    version.check.mockReturnValue(check.promise)
    session.setReady(true)
    session.setReady(false)
    check.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.impl.setReady).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('checks global ownership before any local, practice, hosting, queue or join action', async () => {
    vi.spyOn(playControl, 'acquire').mockResolvedValue(false)
    const create = vi.spyOn(online, 'createRoom'), quick = vi.spyOn(online, 'quickPlay'), ranked = vi.spyOn(online, 'rankedPlay')
    await session.openOffline(); await session.openPractice(); await session.openHost(); await session.openHostServer('test')
    await session.quickPlay({ region: 'test' }); await session.rankedPlay({ region: 'test' }); await session.join('ABCDE', { kind: 'p2p' })
    expect(vi.mocked(playControl.acquire).mock.calls.map(([target]) => target.mode)).toEqual(['local', 'practice', 'host', 'server', 'casual', 'ranked', 'join'])
    for (const call of [f.impl.openOffline, f.impl.openHost, f.impl.join, create, quick, ranked]) expect(call).not.toHaveBeenCalled()
    expect(useGame.getState().screen).toBe('menu')
  })
  it('uses one queue request and dial for repeated clicks while matchmaking is opening', async () => {
    const pending = deferred<{ code: string; created: boolean }>()
    const post = vi.spyOn(online, 'quickPlay').mockReturnValue(pending.promise)
    const first = session.quickPlay({ region: 'test' })
    const second = session.quickPlay({ region: 'test' })
    await vi.advanceTimersByTimeAsync(0)
    const requestsBeforeResponse = post.mock.calls.length
    pending.resolve({ code: 'ABCDE', created: true })
    await Promise.all([first, second])
    expect(requestsBeforeResponse).toBe(1)
    expect(f.impl.join).toHaveBeenCalledOnce()
  })

  it('cancels pending queue ownership on Leave and never joins a late-created room', async () => {
    const pending = deferred<{ code: string; created: boolean }>()
    vi.spyOn(online, 'quickPlay').mockReturnValue(pending.promise)
    const opening = session.quickPlay({ region: 'test' })
    await vi.advanceTimersByTimeAsync(0)
    session.leave()
    pending.resolve({ code: 'ABCDE', created: true })
    expect(await opening).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(f.impl.join).not.toHaveBeenCalled()
    expect(useGame.getState().screen).toBe('menu')
    expect(useGame.getState().lobby.roomCode).toBeNull()
  })

  it('keeps a valid current room when another join is requested from the menu', async () => {
    await session.openHost()
    const slots = useGame.getState().lobby.slots
    useGame.getState().setScreen('menu')
    await session.join('BCDEF', { kind: 'p2p' })
    expect(f.impl.join).not.toHaveBeenCalled()
    expect(session.transport()).toBe('p2p')
    expect(useGame.getState().lobby).toMatchObject({ roomCode: 'ABCDE', status: 'open', slots })
    expect(useGame.getState().screen).toBe('lobby')
  })

  it('does not let an abandoned HTTP failure corrupt a new valid session', async () => {
    const pending = deferred<{ code: string; created: boolean }>()
    vi.spyOn(online, 'quickPlay').mockReturnValue(pending.promise)
    const opening = session.quickPlay({ region: 'test' })
    await vi.advanceTimersByTimeAsync(0)
    session.leave()
    expect(await session.openHost()).toMatchObject({ ok: true, mode: 'p2p' })
    pending.reject(new Error('old queue failed'))
    expect(await opening).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(useGame.getState().lobby).toMatchObject({ roomCode: 'ABCDE', status: 'open', error: null })
    expect(useGame.getState().screen).toBe('lobby')
  })

  it('keeps its private reconnect key stable in a tab even when session storage is unavailable', () => {
    const first = f.deps!.clientKey()
    expect(f.deps!.clientKey()).toBe(first)
  })

  it.each(['lobby', 'match', 'results'] as const)('resumes the accepted %s route without a dial and stops advertising it after Leave', async (screen) => {
    await session.openHost()
    f.deps!.ui.setScreen(screen)
    useGame.getState().setScreen('menu')
    expect(session.isActive()).toBe(true)
    expect(session.resume()).toBe(true)
    expect(useGame.getState().screen).toBe(screen)
    expect(f.impl.join).not.toHaveBeenCalled()
    session.leave()
    expect(session.isActive()).toBe(false)
    expect(session.resume()).toBe(false)
  })

  it('returns to its valid room before any new host or queue POST, including a stale UI error', async () => {
    await session.openHost()
    const quick = vi.spyOn(online, 'quickPlay')
    const ranked = vi.spyOn(online, 'rankedPlay')
    const create = vi.spyOn(online, 'createRoom')
    useGame.getState().setLobby({ status: 'error', error: 'old attempt failed' })
    useGame.getState().setScreen('menu')
    await session.quickPlay()
    await session.rankedPlay()
    await session.openHostServer()
    await session.openHost()
    expect(quick).not.toHaveBeenCalled()
    expect(ranked).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(f.impl.openHost).toHaveBeenCalledOnce()
    expect(useGame.getState().lobby).toMatchObject({ status: 'open', error: null, roomCode: 'ABCDE' })
  })

  it('invalidates region selection before the queue POST and lets a fresh retry succeed', async () => {
    const pending = deferred<ReturnType<typeof online.region>>()
    const region = online.region('test')
    const choose = vi.spyOn(online, 'choose').mockReturnValueOnce(pending.promise)
    const post = vi.spyOn(online, 'quickPlay').mockResolvedValue({ code: 'ABCDE', created: true })
    const opening = session.quickPlay()
    expect(useGame.getState().screen).toBe('lobby')
    expect(useGame.getState().lobby.status).toBe('connecting')
    session.leave()
    pending.resolve(region)
    expect(await opening).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(post).not.toHaveBeenCalled()
    choose.mockRestore()
    expect(await session.quickPlay()).toMatchObject({ ok: true })
    expect(post).toHaveBeenCalledOnce()
  })

  it('unlocks matchmaking after a real failed request so retry can join', async () => {
    const post = vi.spyOn(online, 'quickPlay').mockRejectedValueOnce(new Error('queue unreachable'))
      .mockResolvedValue({ code: 'ABCDE', created: true })
    expect(await session.quickPlay()).toMatchObject({ ok: false, reason: 'error' })
    expect(useGame.getState().screen).toBe('menu')
    expect(await session.quickPlay()).toMatchObject({ ok: true })
    expect(post).toHaveBeenCalledTimes(2)
    expect(f.impl.join).toHaveBeenCalledOnce()
  })

  it.each(['server', 'ranked'] as const)('coalesces repeated %s creation before its HTTP response', async (kind) => {
    const created = deferred<string>()
    const queued = deferred<{ code: string; created: boolean }>()
    const create = vi.spyOn(online, 'createRoom').mockReturnValue(created.promise)
    const ranked = vi.spyOn(online, 'rankedPlay').mockReturnValue(queued.promise)
    const begin = () => kind === 'server' ? session.openHostServer('test') : session.rankedPlay({ region: 'test' })
    const first = begin()
    const second = begin()
    await vi.advanceTimersByTimeAsync(0)
    const posts = kind === 'server' ? create.mock.calls.length : ranked.mock.calls.length
    created.resolve('ABCDE')
    queued.resolve({ code: 'ABCDE', created: true })
    await Promise.all([first, second])
    expect(posts).toBe(1)
    expect(f.impl.join).toHaveBeenCalledOnce()
  })

  it('does not let a different entry action steal an in-flight queue attempt', async () => {
    const pending = deferred<{ code: string; created: boolean }>()
    const quick = vi.spyOn(online, 'quickPlay').mockReturnValue(pending.promise)
    const ranked = vi.spyOn(online, 'rankedPlay')
    const first = session.quickPlay()
    await vi.advanceTimersByTimeAsync(0)
    expect(await session.rankedPlay()).toMatchObject({ ok: false, reason: 'cancelled' })
    await session.join('BCDEF', { kind: 'p2p' })
    expect(ranked).not.toHaveBeenCalled()
    expect(f.impl.join).not.toHaveBeenCalled()
    pending.resolve({ code: 'ABCDE', created: true })
    expect(await first).toMatchObject({ ok: true })
    expect(quick).toHaveBeenCalledOnce()
    expect(f.impl.join).toHaveBeenCalledExactlyOnceWith('ABCDE')
  })

  it('blocks touch-only offline, hosting, queue and invite entry before creating or dialing rooms', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    f.impl.openOffline.mockClear()
    f.impl.openHost.mockClear()
    f.impl.join.mockClear()
    f.requests.length = 0
    session.openOffline()
    for (const result of [await session.openHost(), await session.openHostServer('test'), await session.quickPlay(), await session.rankedPlay()]) {
      expect(result).toMatchObject({ ok: false, other: { available: false } })
    }
    await session.join('ABCDE', { kind: 'p2p' })
    await session.join('ABCDE', { kind: 'server', region: 'test' })
    expect(f.impl.openOffline).not.toHaveBeenCalled()
    expect(f.impl.openHost).not.toHaveBeenCalled()
    expect(f.impl.join).not.toHaveBeenCalled()
    expect(f.requests).toEqual([])
    expect(useGame.getState().lobby.error).toContain('mouse and keyboard')
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    await session.openHost()
    expect(f.impl.openHost).toHaveBeenCalledOnce()
  })

  it('keeps full bot-filled PC hosting P2P while publishing lobby and match listings', async () => {
    expect(await session.openHost()).toMatchObject({ ok: true, mode: 'p2p' })
    session.setPublic(true)
    await vi.advanceTimersByTimeAsync(0)
    const post = f.requests.find((r) => r.url.endsWith('/listings') && r.method === 'POST')!
    expect(JSON.parse(post.body!)).toMatchObject({ code: 'ABCDE', humans: 1, bots: 9, joinable: 9, phase: 'lobby' })
    expect(session.transport()).toBe('p2p')
    f.deps!.ui.setScreen('match')
    await vi.advanceTimersByTimeAsync(2100)
    const beat = [...f.requests].reverse().find((r) => r.url.endsWith('/listings/listing-id') && r.method === 'PUT')!
    expect(JSON.parse(beat.body!)).toMatchObject({ code: 'ABCDE', bots: 9, phase: 'match', joinable: 9 })
    expect(session.transport()).toBe('p2p')
    expect(f.serverJoin).not.toHaveBeenCalled()
  })

  it('refreshes P2P match progress at a modest rate and on round changes, then clears it in the lobby', async () => {
    await session.openHost()
    session.setPublic(true)
    await vi.advanceTimersByTimeAsync(0)
    f.deps!.ui.setScreen('match')
    const state = createMatch(DEFAULT_SETTINGS, useGame.getState().lobby.slots, 1)
    state.round = 2; state.phase = 'fight'; state.tick = 62 * TICK_HZ
    f.deps!.frame.pushState(state, performance.now())
    await vi.advanceTimersByTimeAsync(2100)
    const beats = () => f.requests.filter((r) => r.url.endsWith('/listings/listing-id') && r.method === 'PUT')
    expect(JSON.parse(beats().at(-1)!.body!).progress).toEqual({ round: 2, elapsedSeconds: 62, phase: 'fight', final: false })
    const count = beats().length
    for (let tick = 0; tick < 60; tick++) f.deps!.frame.pushState({ ...state, tick: state.tick + tick }, performance.now())
    await vi.advanceTimersByTimeAsync(2100)
    expect(beats()).toHaveLength(count)
    f.deps!.frame.pushState({ ...state, phase: 'shop', tick: 65 * TICK_HZ }, performance.now())
    await vi.advanceTimersByTimeAsync(2100)
    expect(JSON.parse(beats().at(-1)!.body!).progress).toEqual({ round: 3, elapsedSeconds: 65, phase: 'shop', final: false })
    f.deps!.frame.pushState({ ...state, phase: 'shop', tick: 70 * TICK_HZ }, performance.now())
    await vi.advanceTimersByTimeAsync(2100)
    expect(JSON.parse(beats().at(-1)!.body!).progress.elapsedSeconds).toBe(70)
    f.deps!.ui.setScreen('lobby')
    await vi.advanceTimersByTimeAsync(2100)
    expect(JSON.parse(beats().at(-1)!.body!)).toMatchObject({ phase: 'lobby', progress: null })
  })

  it('offers rediscovery after an unexpected P2P disconnect and explicitly rejoins that backend', async () => {
    f.directory = [{ code: 'ABCDE', kind: 'p2p', humans: 1, bots: 9, max: 10, phase: 'match' }]
    await session.join('ABCDE', { kind: 'p2p' })
    f.transport = null
    useGame.getState().setLobby({ role: 'offline', status: 'error', error: 'Lost connection', roomCode: null })
    await rejoin.refresh()
    expect(rejoin.get()).toMatchObject({ code: 'ABCDE', kind: 'p2p', status: 'available' })
    expect(f.peerJoin).toHaveBeenCalledTimes(1)
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    await rejoin.join()
    expect(f.peerJoin).toHaveBeenCalledTimes(1)
    expect(rejoin.get()?.error).toContain('mouse and keyboard')
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    await rejoin.refresh()
    await rejoin.join()
    expect(f.peerJoin).toHaveBeenCalledTimes(2)
    expect(f.serverJoin).not.toHaveBeenCalled()
    expect(rejoin.get()).toBeNull()
    // Leave offers the game back for a while (a misclick), then forgets it
    session.leave()
    expect(rejoin.get()).toMatchObject({ code: 'ABCDE', kind: 'p2p' })
    await vi.advanceTimersByTimeAsync(LEFT_REJOIN_MS)
    useGame.getState().setLobby({ status: 'error', error: 'Later error' })
    expect(rejoin.get()).toBeNull()
  })

  it('preserves the remembered target when a real reconnect dial fails, allows explicit retry, and clears it on Leave', async () => {
    await session.join('ABCDE', { kind: 'server', region: 'test' })
    expect([...f.storage.values()].some((raw) => raw.includes('ABCDE'))).toBe(true)
    f.transport = null
    useGame.getState().setLobby({ role: 'offline', status: 'error', error: 'Lost connection', roomCode: null })
    await rejoin.refresh()
    f.impl.join.mockImplementationOnce(async () => {
      useGame.getState().setLobby({ status: 'error', error: 'The original connection is still closing.' })
      useGame.getState().setScreen('menu')
    })
    await rejoin.join()
    expect(rejoin.get()).toMatchObject({ code: 'ABCDE', status: 'available', error: 'The original connection is still closing.' })
    expect([...f.storage.values()].some((raw) => raw.includes('ABCDE'))).toBe(true)
    await rejoin.join()
    expect(rejoin.get()).toBeNull()
    expect(f.serverJoin).toHaveBeenCalledTimes(2)
    expect(f.peerJoin).not.toHaveBeenCalled()
    session.leave()
    expect([...f.storage.values()].every((raw) => raw === '')).toBe(true)
    expect(rejoin.get()).toMatchObject({ code: 'ABCDE', kind: 'server' })
    await vi.advanceTimersByTimeAsync(LEFT_REJOIN_MS)
    expect(rejoin.get()).toBeNull()
  })

  it('rediscovery stays on the remembered server when the preferred region changes and never creates a replacement game', async () => {
    await session.join('ABCDE', { kind: 'server', region: 'test' })
    f.transport = null
    useGame.getState().setLobby({ role: 'offline', status: 'error', error: 'Lost connection', roomCode: null })
    useGame.getState().setSettings({ serverRegion: 'another-region' })
    const exists = vi.spyOn(online, 'roomExists').mockResolvedValue(false)
    const quick = vi.spyOn(online, 'quickPlay')
    const create = vi.spyOn(online, 'createRoom')
    const ranked = vi.spyOn(online, 'rankedPlay')
    await rejoin.refresh()
    await rejoin.join()
    expect(exists).toHaveBeenCalledExactlyOnceWith('test', 'ABCDE')
    expect(rejoin.get()).toMatchObject({ kind: 'server', status: 'unavailable', error: expect.stringContaining('ended') })
    expect(f.serverJoin).toHaveBeenCalledTimes(1)
    expect(f.peerJoin).not.toHaveBeenCalled()
    expect(quick).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(ranked).not.toHaveBeenCalled()
    useGame.getState().setSettings({ serverRegion: 'auto' })
  })

  it('persists explicit color preferences without overwriting them with assigned lobby colors', async () => {
    await session.join('ABCDE', { kind: 'p2p' })
    f.preferred.mockClear()
    useGame.getState().setLobby({ slots: [ownSlot(0xff8a1f)] })
    expect(f.preferred).not.toHaveBeenCalled()
    session.setPlayerColor(0xff8a1f)
    expect(f.preferred).toHaveBeenCalledExactlyOnceWith(0xff8a1f)
    expect(f.impl.setPlayerColor).toHaveBeenCalledWith(0xff8a1f)
    f.preferred.mockClear()
    useGame.getState().setLobby({ slots: [{ ...ownSlot(0xff8a1f), profileId: 'different-profile' }] })
    useGame.getState().setLobby({ slots: [{ ...ownSlot(0xff8a1f), kind: 'bot' }] })
    expect(f.preferred).not.toHaveBeenCalled()
  })
})
