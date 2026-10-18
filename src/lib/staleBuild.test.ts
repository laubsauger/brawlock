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
})
