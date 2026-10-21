import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../sim'
import { rememberRoomOptions, savedRoomOptions } from './roomOptions'
import type { KV } from './profile'

const memKV = (data: Record<string, string> = {}): KV & { data: Record<string, string> } => ({
  data,
  getItem: (k) => data[k] ?? null,
  setItem: (k, v) => { data[k] = v },
})

describe('room options carry over to the next custom room', () => {
  it('remembers what the owner changed, so a new room does not need setting up again', () => {
    const kv = memKV()
    expect(savedRoomOptions(kv)).toEqual({})
    rememberRoomOptions({ spectatorBets: false }, kv)
    rememberRoomOptions({ winScore: DEFAULT_SETTINGS.winScore + 2 }, kv)
    expect(savedRoomOptions(kv)).toEqual({ spectatorBets: false, winScore: DEFAULT_SETTINGS.winScore + 2 })
  })

  it('Reset to defaults forgets them, and a value set back to its default is dropped', () => {
    const kv = memKV()
    rememberRoomOptions({ spectatorBets: false, bounties: !DEFAULT_SETTINGS.bounties }, kv)
    rememberRoomOptions({ spectatorBets: DEFAULT_SETTINGS.spectatorBets }, kv)
    expect(savedRoomOptions(kv)).toEqual({ bounties: !DEFAULT_SETTINGS.bounties })
    rememberRoomOptions(DEFAULT_SETTINGS, kv)
    expect(savedRoomOptions(kv)).toEqual({})
  })

  it('ignores unknown keys, wrong types and broken storage', () => {
    expect(savedRoomOptions(memKV({ 'brawlock.roomOptions.v1': '{"spectatorBets":"no","hack":1,"winScore":7}' }))).toEqual({ winScore: 7 })
    expect(savedRoomOptions(memKV({ 'brawlock.roomOptions.v1': 'not json' }))).toEqual({})
    expect(savedRoomOptions(null)).toEqual({})
  })
})
