import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  openHost: vi.fn(),
  openHostServer: vi.fn(),
  setPublic: vi.fn(),
  join: vi.fn(),
}))
vi.mock('../game/session', () => ({ session: mocks }))
vi.mock('./lib/onboarding', () => ({ tutorial: { request: mocks.request } }))
import { hostGame, hostOnServer, joinRoom, playOffline, quickPlay, rankedPlay } from './flow'
import { PENDING_ROOM_KEY } from '../lib/pendingRoom'
import { PLAY_REQUIREMENT } from './lib/playAccess'
import { useGame } from '../game/store'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  const values = new Map<string, string>()
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
  mocks.openHost.mockResolvedValue({ ok: true, mode: 'p2p', region: null })
  mocks.openHostServer.mockResolvedValue({ ok: true, mode: 'server', region: null })
  mocks.join.mockResolvedValue(undefined)
})
afterEach(() => vi.unstubAllGlobals())

describe('shared play setup hosting', () => {
  it('blocks every touch-only entry before onboarding, clears pending invites and keeps the menu available', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    sessionStorage.setItem(PENDING_ROOM_KEY, 'KRZBW')
    useGame.getState().setScreen('boot')
    playOffline()
    hostGame(true)
    hostOnServer('us-west', true)
    quickPlay('auto')
    rankedPlay('auto')
    expect(joinRoom('KRZBW')).toEqual({ problem: PLAY_REQUIREMENT })
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.openHost).not.toHaveBeenCalled()
    expect(mocks.openHostServer).not.toHaveBeenCalled()
    expect(mocks.join).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(PENDING_ROOM_KEY)).toBeNull()
    expect(useGame.getState().screen).toBe('menu')
  })

  it('waits for onboarding before opening or listing a browser-created room', async () => {
    hostOnServer('us-west', true)
    expect(mocks.openHostServer).not.toHaveBeenCalled()
    expect(mocks.setPublic).not.toHaveBeenCalled()
    mocks.request.mock.calls[0][0].run()
    await Promise.resolve()
    expect(mocks.openHostServer).toHaveBeenCalledWith('us-west')
    expect(mocks.setPublic).toHaveBeenCalledWith(true)
  })

  it('keeps private hosting private, and lists a computer-hosted room only when requested', async () => {
    hostGame()
    mocks.request.mock.calls[0][0].run()
    await Promise.resolve()
    expect(mocks.setPublic).not.toHaveBeenCalled()
    hostGame(true)
    mocks.request.mock.calls[1][0].run()
    await Promise.resolve()
    expect(mocks.setPublic).toHaveBeenCalledTimes(1)
    expect(mocks.setPublic).toHaveBeenCalledWith(true)
  })

  it('does not list anything after a failed hosting attempt', async () => {
    mocks.openHostServer.mockResolvedValue({ ok: false })
    hostOnServer('us-west', true)
    mocks.request.mock.calls[0][0].run()
    await Promise.resolve()
    expect(mocks.setPublic).not.toHaveBeenCalled()
  })

  it('clears a cancelled invite and a completed join so reload cannot reopen an old room', async () => {
    const cancel = vi.fn()
    joinRoom('KRZBW', cancel)
    expect(sessionStorage.getItem(PENDING_ROOM_KEY)).toBe('KRZBW')
    mocks.request.mock.calls[0][0].cancel()
    expect(sessionStorage.getItem(PENDING_ROOM_KEY)).toBeNull()
    expect(cancel).toHaveBeenCalledOnce()
    joinRoom('KRZBW')
    mocks.request.mock.calls[1][0].run()
    await Promise.resolve()
    expect(sessionStorage.getItem(PENDING_ROOM_KEY)).toBeNull()
  })
})
