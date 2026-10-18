import { afterEach, describe, expect, it, vi } from 'vitest'
import { _resetProfileCache, getProfile } from './profile'
import { useGame } from './store'
import { chooseName } from '../ui/lib/name'
import { getDeviceId } from './device'

const initialName = useGame.getState().settings.playerName
afterEach(() => {
  useGame.getState().setSettings({ playerName: initialName })
  _resetProfileCache()
  vi.unstubAllGlobals()
})

describe('display names and persistent identities', () => {
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
