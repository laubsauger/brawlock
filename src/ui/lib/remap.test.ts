import { beforeEach, describe, expect, it } from 'vitest'
import { useGame } from '../../game/store'
import { actionForCode, resolveBinds } from './keys'
import { resetSlotLayout, sameGroup, swapSlots, undoRemap } from './remap'

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

  it('keeps spells and items apart', () => {
    expect(sameGroup(0, 6)).toBe(false)
    expect(swapSlots(0, 6)).toBe(false)
    expect(actionForCode(binds(), 'KeyQ')).toBe('spell0')
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
