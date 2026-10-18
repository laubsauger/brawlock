import { describe, expect, it } from 'vitest'
import { actionForCode, bindLabel, PRESET_INFO, PRESETS, resolveBinds, slotKeyLabel } from './keys'
import { migrateSettings, type KeyPreset } from '../../game/store'

const presets = Object.keys(PRESETS) as KeyPreset[]

describe('keybinds', () => {
  it.each(presets)('preset %s never puts two actions on one key, secondaries included', (keyPreset) => {
    // a double-booked key would silently make one action unreachable
    const b = resolveBinds({ keyPreset, keybinds: {}, keybindsAlt: {} })
    const codes = [...Object.values(b.primary), ...Object.values(b.secondary)].filter(Boolean)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it.each(presets)('preset %s opens the shop with P as well, so Mac players never need Fn+F4', (keyPreset) => {
    const b = resolveBinds({ keyPreset, keybinds: {}, keybindsAlt: {} })
    expect(actionForCode(b, 'KeyP')).toBe('shop')
  })

  it('keeps a saved primary override on P working: the default shop secondary yields to it', () => {
    // settings saved before secondaries existed must not lose their meaning after the update
    const b = resolveBinds({ keyPreset: 'dota', keybinds: { spell0: 'KeyP' }, keybindsAlt: {} })
    expect(actionForCode(b, 'KeyP')).toBe('spell0')
    expect(b.secondary.shop).toBe('')
    expect(actionForCode(b, 'F4')).toBe('shop')
  })

  it('lets the player clear a default secondary', () => {
    const b = resolveBinds({ keyPreset: 'modern', keybinds: {}, keybindsAlt: { shop: '' } })
    expect(actionForCode(b, 'KeyP')).toBeNull()
    expect(bindLabel(b, 'shop')).toBe('B')
  })

  it('shows both keys where they exist', () => {
    const b = resolveBinds({ keyPreset: 'dota', keybinds: {}, keybindsAlt: {} })
    expect(bindLabel(b, 'shop')).toBe('F4 / P')
    expect(bindLabel(b, 'shop', true)).toBe('F4')
  })
})

describe('Brawlock default keys', () => {
  const b = resolveBinds({ keyPreset: 'brawlock', keybinds: {}, keybindsAlt: {} })

  it('puts the two spells used from round 1 on the prime keys: Fireball Q, Scourge W', () => {
    expect(slotKeyLabel(b, 6)).toBe('Q')
    expect(slotKeyLabel(b, 7)).toBe('W')
  })

  it('lays the six spell columns out as E R T / D F G and the free items as Z X C V', () => {
    expect([0, 1, 2, 3, 4, 5].map((s) => slotKeyLabel(b, s))).toEqual(['E', 'R', 'T', 'D', 'F', 'G'])
    expect([8, 9, 10, 11].map((s) => slotKeyLabel(b, s))).toEqual(['Z', 'X', 'C', 'V'])
    expect(bindLabel(b, 'shop')).toBe('B / P')
    expect(bindLabel(b, 'character')).toBe('K')
  })

  it.each(presets)('preset %s puts camera peek on A, a key no other action uses', (keyPreset) => {
    const pb = resolveBinds({ keyPreset, keybinds: {}, keybindsAlt: {} })
    expect(actionForCode(pb, 'KeyA')).toBe('peek')
  })

  it('is the default and listed first in Settings', () => {
    expect(migrateSettings({}).keyPreset).toBe('brawlock')
    expect(PRESET_INFO[0].value).toBe('brawlock')
  })
})

describe('one-time move to the new default keys', () => {
  it('moves a player still on the old default with no keys of their own', () => {
    expect(migrateSettings({ keyPreset: 'dota', keybinds: {}, keybindsAlt: {} }).keyPreset).toBe('brawlock')
  })

  it('keeps Dota for anyone who changed a key, and any other preset as chosen', () => {
    expect(migrateSettings({ keyPreset: 'dota', keybinds: { spell0: 'KeyA' }, keybindsAlt: {} }).keyPreset).toBe('dota')
    expect(migrateSettings({ keyPreset: 'dota', keybinds: {}, keybindsAlt: { shop: '' } }).keyPreset).toBe('dota')
    expect(migrateSettings({ keyPreset: 'classic', keybinds: {}, keybindsAlt: {} }).keyPreset).toBe('classic')
  })

  it('runs once: a player who picks Dota again after the move keeps it', () => {
    const once = migrateSettings({ keyPreset: 'dota', keybinds: {}, keybindsAlt: {} })
    expect(migrateSettings({ ...once, keyPreset: 'dota' }).keyPreset).toBe('dota')
  })
})
