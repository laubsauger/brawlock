import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const KEY = 'brawlock.settings.v1'

function storage(saved: Record<string, unknown> | null) {
  const values = new Map<string, string>()
  if (saved !== null) values.set(KEY, JSON.stringify(saved))
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  })
  return values
}

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

describe('optional analytics preference', () => {
  it.each([undefined, 'true', 1, {}])('never treats malformed or missing consent as approval: %j', async (analyticsConsent) => {
    storage({ settingsVersion: 2, analyticsConsent })
    const { useGame } = await import('./store')
    expect(useGame.getState().settings.analyticsConsent).toBeNull()
  })

  it.each([true, false])('persists and restores an explicit choice: %s', async (analyticsConsent) => {
    storage(null)
    const { useGame } = await import('./store')
    useGame.getState().setSettings({ analyticsConsent })
    vi.resetModules()
    const { useGame: reloaded } = await import('./store')
    expect(reloaded.getState().settings.analyticsConsent).toBe(analyticsConsent)
  })
})

describe('music volume preferences', () => {
  it.each([null, { settingsVersion: 2, playerName: 'Existing player' }])('uses the louder default when no music preference is saved: %j', async (saved) => {
    storage(saved)
    const { useGame } = await import('./store')
    expect(useGame.getState().settings.musicVolume).toBe(0.65)
  })

  it.each([0, 0.2, 0.5, 0.85, 1])('keeps a saved music volume of %s on initial load', async (musicVolume) => {
    storage({ settingsVersion: 2, musicVolume, muted: true })
    const { useGame } = await import('./store')
    expect(useGame.getState().settings).toMatchObject({ musicVolume, muted: true })
  })

  it('persists a new volume choice and restores it after reload', async () => {
    const values = storage(null)
    const { useGame } = await import('./store')
    useGame.getState().setSettings({ musicVolume: 0.23 })
    expect(JSON.parse(values.get(KEY)!)).toMatchObject({ musicVolume: 0.23 })
    vi.resetModules()
    const { useGame: reloaded } = await import('./store')
    expect(reloaded.getState().settings.musicVolume).toBe(0.23)
  })
})
