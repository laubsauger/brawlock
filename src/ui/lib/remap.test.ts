import { beforeEach, describe, expect, it } from 'vitest'
import { useGame } from '../../game/store'
import { actionForCode, resolveBinds } from './keys'
import { canSwap, resetSlotLayout, swapSlots, undoRemap } from './remap'

const binds = () => resolveBinds(useGame.getState().settings)

describe('slot key remapping', () => {
  beforeEach(() => useGame.getState().setSettings({ keyPreset: 'dota', keybinds: {}, keybindsAlt: {} }))

  it('swaps the keys of two spell slots, so Q casts what W cast and back', () => {
    // a UI-only remap: it must change bindings, never which slot a cast command names
    expect(swapSlots(0, 1)).toBe(true)
    expect(actionForCode(binds(), 'KeyQ')).toBe('spell1')
    expect(actionForCode(binds(), 'KeyW')).toBe('spell0')
  })

  it('moves second keys along with main keys', () => {
    useGame.getState().setSettings({ keybindsAlt: { item0: 'Digit1' } })
    swapSlots(6, 7)
    expect(binds().secondary.item1).toBe('Digit1')
    expect(binds().secondary.item0).toBe('')
  })

  it('swaps across spells and items: Fireball can live on Q', () => {
    // a keybinding remap only; any two slots may trade keys
    expect(canSwap(0, 6)).toBe(true)
    expect(swapSlots(0, 6)).toBe(true)
    expect(actionForCode(binds(), 'KeyQ')).toBe('item0')
    expect(actionForCode(binds(), 'KeyZ')).toBe('spell0')
  })

  it('undoes a cross-group swap', () => {
    swapSlots(5, 11)
    expect(undoRemap()).toBe(true)
    expect(actionForCode(binds(), 'KeyR')).toBe('spell5')
    expect(actionForCode(binds(), 'KeyN')).toBe('item5')
  })

  it('refuses only a slot onto itself', () => {
    expect(canSwap(3, 3)).toBe(false)
    expect(swapSlots(3, 3)).toBe(false)
  })

  it('undoes the last swap', () => {
    swapSlots(2, 3)
    expect(undoRemap()).toBe(true)
    expect(actionForCode(binds(), 'KeyE')).toBe('spell2')
    expect(undoRemap()).toBe(false)
  })

  it('resets only the slot layout, keeping other custom keys', () => {
    useGame.getState().setSettings({ keybinds: { shop: 'KeyY' } })
    swapSlots(0, 5)
    resetSlotLayout()
    expect(actionForCode(binds(), 'KeyQ')).toBe('spell0')
    expect(binds().primary.shop).toBe('KeyY')
  })
})
