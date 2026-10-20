import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const transport = vi.hoisted(() => vi.fn(() => 'p2p'))
vi.mock('../game/session', () => ({ session: { transport } }))

beforeEach(() => {
  vi.resetModules()
  transport.mockReturnValue('p2p')
  const values = new Map<string, string>()
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
  vi.stubGlobal('window', { location: { href: 'https://example.com/brawlock/?mute', replace: vi.fn() } })
})
afterEach(() => vi.unstubAllGlobals())

describe('new-build notice and explicit reload', () => {
  it('keeps an update available for late-mounted UI and notifies subscribers once', async () => {
    const { useGame } = await import('../game/store')
    const update = await import('./staleBuild')
    useGame.getState().setScreen('menu')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ build: 'new' }) })))
    const listener = vi.fn()
    const off = update.onBuildUpdate(listener)
    await update.checkBuildVersion('old')
    await update.checkBuildVersion('old')
    expect(update.getBuildUpdate()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
    off()
  })

  it('does not interrupt a match, including one entered while the request is pending', async () => {
    const { useGame } = await import('../game/store')
    const update = await import('./staleBuild')
    useGame.getState().setScreen('match')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await update.checkBuildVersion('old')
    expect(fetch).not.toHaveBeenCalled()
    useGame.getState().setScreen('menu')
    let answer!: (response: unknown) => void
    fetch.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    const pending = update.checkBuildVersion('old')
    useGame.getState().setScreen('match')
    answer({ ok: true, json: async () => ({ build: 'new' }) })
    await pending
    expect(update.getBuildUpdate()).toBe(false)
  })

  it('preserves a guest room when the user reloads, without an automatic cooldown', async () => {
    const { useGame } = await import('../game/store')
    const update = await import('./staleBuild')
    useGame.getState().setLobby({ role: 'client', roomCode: 'KRZBW' })
    sessionStorage.setItem('brawlock.staleReloadAt', String(Date.now()))
    update.reloadLatestBuild()
    expect(window.location.replace).toHaveBeenCalledWith('https://example.com/brawlock/?mute=&room=KRZBW')
    useGame.getState().setLobby({ role: 'host' })
    update.reloadLatestBuild()
    expect(window.location.replace).toHaveBeenLastCalledWith('https://example.com/brawlock/?mute=')
    transport.mockReturnValue('server')
    update.reloadLatestBuild()
    expect(window.location.replace).toHaveBeenLastCalledWith('https://example.com/brawlock/?mute=&room=KRZBW')
  })

  it('requires a reload before play when a fresh version check detects a different build', async () => {
    const { useGame } = await import('../game/store')
    const version = await import('./buildVersion')
    useGame.getState().setScreen('lobby')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ build: 'new' }) })))
    await expect(version.ensureCurrentBuild('old')).rejects.toThrow(version.BUILD_UPDATE_REQUIRED)
    expect(version.getBuildUpdate()).toBe(true)
    await expect(version.ensureCurrentBuild('old')).rejects.toThrow(version.BUILD_UPDATE_REQUIRED)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('coalesces background and play-entry checks without allowing entry before the response', async () => {
    const { useGame } = await import('../game/store')
    const version = await import('./buildVersion')
    useGame.getState().setScreen('menu')
    let answer!: (response: unknown) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { answer = resolve })))
    const background = version.checkBuildVersion('old')
    const entry = version.ensureCurrentBuild('old')
    expect(fetch).toHaveBeenCalledTimes(1)
    const rejected = expect(entry).rejects.toThrow(version.BUILD_UPDATE_REQUIRED)
    answer({ ok: true, json: async () => ({ build: 'new' }) })
    await Promise.all([background, rejected])
  })

  it.each(['network', 'http', 'invalid'] as const)('blocks entry on a %s version-check failure but lets a later successful retry play', async (failure) => {
    const { useGame } = await import('../game/store')
    const version = await import('./buildVersion')
    useGame.getState().setScreen('menu')
    const request = vi.fn(async () => {
      if (failure === 'network') throw new Error('offline')
      return { ok: failure !== 'http', json: async () => ({ build: null as string | null }) }
    })
    vi.stubGlobal('fetch', request)
    await expect(version.ensureCurrentBuild('current')).rejects.toThrow()
    expect(version.getBuildUpdate()).toBe(false)
    request.mockResolvedValue({ ok: true, json: async () => ({ build: 'current' }) })
    await expect(version.ensureCurrentBuild('current')).resolves.toBeUndefined()
  })
})
