import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionDeps } from '../net/session'

const f = vi.hoisted(() => ({
  deps: null as SessionDeps | null,
  transport: null as 'p2p' | 'server' | null,
  profile: { id: 'stable-profile', name: 'Mira', color: null },
  requests: [] as { url: string; method: string; body?: string }[],
  directory: [] as Record<string, unknown>[],
  preferred: vi.fn(), peerJoin: vi.fn(), serverJoin: vi.fn(),
  impl: {
    openOffline: vi.fn(), openHost: vi.fn(), join: vi.fn(), leave: vi.fn(),
    transport: (): 'server' | 'p2p' | null => f.transport,
    joinableSeats: () => 9,
    setDisplayName: vi.fn(), setPlayerColor: vi.fn(), startLobbyVote: vi.fn(), castLobbyVote: vi.fn(),
  },
}))
vi.mock('../audio', () => ({ audio: { playEvents: vi.fn() } }))
vi.mock('./input', () => ({ input: { drain: () => [] } }))
vi.mock('./profile', async (original) => ({ ...await original<typeof import('./profile')>(), getProfile: () => f.profile, setPreferredColor: f.preferred }))
vi.mock('./device', () => ({ getDeviceId: () => 'stable-device' }))
vi.mock('../net/session', async (original) => ({
  ...await original<typeof import('../net/session')>(),
  createSession: (deps: SessionDeps) => { f.deps = deps; return f.impl },
}))
vi.mock('../net/peer', () => ({
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
import { DEFAULT_SETTINGS } from '../sim/config'

const ownSlot = (color = 0x2fd6c8) => ({ id: 0, kind: 'human' as const, name: 'Mira', profileId: f.profile.id, team: 0, color })

beforeEach(async () => {
  vi.useFakeTimers()
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
  })
  await online.probe(0)
})
afterEach(async () => {
  session.leave()
  await vi.advanceTimersByTimeAsync(0)
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('browser session listing and reconnect wiring', () => {
  it('keeps full bot-filled PC hosting P2P while publishing lobby and match listings', async () => {
    expect(await session.openHost()).toMatchObject({ ok: true, mode: 'p2p' })
    session.setPublic(true)
    await vi.advanceTimersByTimeAsync(0)
    const post = f.requests.find((r) => r.url.endsWith('/listings') && r.method === 'POST')!
    expect(JSON.parse(post.body!)).toMatchObject({ code: 'ABCDE', humans: 1, bots: 9, joinable: 9, phase: 'lobby' })
    expect(session.transport()).toBe('p2p')
    useGame.getState().setScreen('match')
    await vi.advanceTimersByTimeAsync(2100)
    const beat = [...f.requests].reverse().find((r) => r.url.endsWith('/listings/listing-id') && r.method === 'PUT')!
    expect(JSON.parse(beat.body!)).toMatchObject({ code: 'ABCDE', bots: 9, phase: 'match', joinable: 9 })
    expect(session.transport()).toBe('p2p')
    expect(f.serverJoin).not.toHaveBeenCalled()
  })

  it('offers rediscovery after an unexpected P2P disconnect and explicitly rejoins that backend', async () => {
    f.directory = [{ code: 'ABCDE', kind: 'p2p', humans: 1, bots: 9, max: 10, phase: 'match' }]
    await session.join('ABCDE', { kind: 'p2p' })
    f.transport = null
    useGame.getState().setLobby({ role: 'offline', status: 'error', error: 'Lost connection', roomCode: null })
    await rejoin.refresh()
    expect(rejoin.get()).toMatchObject({ code: 'ABCDE', kind: 'p2p', status: 'available' })
    expect(f.peerJoin).toHaveBeenCalledTimes(1)
    await rejoin.join()
    expect(f.peerJoin).toHaveBeenCalledTimes(2)
    expect(f.serverJoin).not.toHaveBeenCalled()
    expect(rejoin.get()).toBeNull()
    session.leave()
    useGame.getState().setLobby({ status: 'error', error: 'Later error' })
    expect(rejoin.get()).toBeNull()
  })

  it('persists only confirmed own human slot colors with the stable profile identity', async () => {
    await session.join('ABCDE', { kind: 'p2p' })
    f.preferred.mockClear()
    useGame.getState().setLobby({ slots: [ownSlot(0xff8a1f)] })
    expect(f.preferred).toHaveBeenCalledExactlyOnceWith(0xff8a1f)
    f.preferred.mockClear()
    useGame.getState().setLobby({ slots: [{ ...ownSlot(0xff8a1f), profileId: 'different-profile' }] })
    useGame.getState().setLobby({ slots: [{ ...ownSlot(0xff8a1f), kind: 'bot' }] })
    expect(f.preferred).not.toHaveBeenCalled()
  })
})
