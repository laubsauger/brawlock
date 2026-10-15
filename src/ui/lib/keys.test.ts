import { describe, expect, it } from 'vitest'
import { actionForCode, bindLabel, PRESETS, resolveBinds } from './keys'
import type { KeyPreset } from '../../game/store'

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
