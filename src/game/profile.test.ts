import { afterEach, describe, expect, it, vi } from 'vitest'
import { _resetProfileCache, getProfile, setPreferredColor } from './profile'
import { useGame } from './store'
import { chooseName, NAME_MAX, suggestedName } from '../ui/lib/name'
import { getDeviceId } from './device'

const initialName = useGame.getState().settings.playerName
afterEach(() => {
  useGame.getState().setSettings({ playerName: initialName })
  _resetProfileCache()
  vi.unstubAllGlobals()
})

describe('display names and persistent identities', () => {
  it('offers usable themed first-run names and saves color without changing either identity', () => {
    for (const n of [0, 0.3, 0.65, 0.9999]) {
      const suggestion = suggestedName(() => n)
      expect(suggestion.length).toBeLessThanOrEqual(NAME_MAX)
      expect(suggestion).not.toBe('Warlock')
      expect(suggestion).toMatch(/^[A-Za-z]+\d{2}$/)
    }
    const data = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } })
    const before = getProfile()
    const device = getDeviceId()
    setPreferredColor(0x14e0c8)
    chooseName('EmberFox42')
    _resetProfileCache()
    expect(getProfile()).toEqual({ id: before.id, name: 'EmberFox42', color: 0x14e0c8 })
    expect(getDeviceId()).toBe(device)
  })
  it('renaming and reloading preserve separate browser profile and server device IDs', async () => {
    const data = new Map([
      ['brawlock.profile.v1', JSON.stringify({ id: 'browser-profile-fixed', color: 0x123456 })],
      ['brawlock.device.v1', 'server-device-fixed'],
    ])
    vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } })
    _resetProfileCache()
    const original = getProfile()
    const device = getDeviceId()
    chooseName('  A new name  ')
    expect(getProfile()).toEqual({ ...original, name: 'A new name' })
    expect(getDeviceId()).toBe(device)
    _resetProfileCache()
    expect(getProfile()).toEqual({ id: 'browser-profile-fixed', name: 'A new name', color: 0x123456 })
    vi.resetModules()
    const reloaded = await import('./device')
    expect(reloaded.getDeviceId()).toBe('server-device-fixed')
    expect(JSON.parse(data.get('brawlock.profile.v1')!)).toEqual({ id: 'browser-profile-fixed', color: 0x123456 })
  })
})
