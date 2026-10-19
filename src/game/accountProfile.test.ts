import { afterEach, expect, it, vi } from 'vitest'
import { useAccount } from './accountState'
import { _resetProfileCache, getProfile, setPreferredColor } from './profile'
import { useGame } from './store'

const initialName = useGame.getState().settings.playerName
afterEach(() => {
  useAccount.setState({ player: null, loaded: false, error: null })
  useGame.getState().setSettings({ playerName: initialName })
  _resetProfileCache()
  vi.unstubAllGlobals()
})

it('uses the authenticated reserved profile without overwriting guest identity or preferences', () => {
  const data = new Map([['brawlock.profile.v1', JSON.stringify({ id: 'local-guest-profile', color: 0x2e7bff })]])
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } })
  useGame.getState().setSettings({ playerName: 'GuestFox' })
  _resetProfileCache()
  const guest = getProfile()
  useAccount.setState({ loaded: true, player: { id: 'AccountStableID', profile: { name: 'ReservedFox', color: 0x14e0c8 }, game: null } })
  expect(getProfile()).toEqual({ id: 'a_AccountStableID', name: 'ReservedFox', color: 0x14e0c8 })
  useGame.getState().setSettings({ playerName: 'ChangedGuestName' })
  setPreferredColor(0x123456)
  expect(getProfile()).toEqual({ id: 'a_AccountStableID', name: 'ReservedFox', color: 0x14e0c8 })
  useAccount.setState({ player: { id: 'AccountStableID', profile: { name: 'RenamedFox', color: 0x14e0c8 }, game: null } })
  expect(getProfile()).toEqual({ id: 'a_AccountStableID', name: 'RenamedFox', color: 0x14e0c8 })
  useAccount.setState({ player: null })
  expect(getProfile()).toEqual({ ...guest, name: 'ChangedGuestName', color: 0x123456 })
})
