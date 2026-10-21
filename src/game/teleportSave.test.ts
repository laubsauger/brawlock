import { describe, expect, it } from 'vitest'
import { isDeniedEscape, isTeleportSave, slideDecay, type SlideSnapshot } from './teleportSave'

const lava: SlideSnapshot = { x: 5000, y: 0, kbx: 0, kby: 0, inLava: true }
const decay = slideDecay(0.96)
const full = { hp: 1000, maxHp: 1000 }

describe('Denied escape callouts', () => {
  it('keeps ordinary full-health lava blinks quiet without changing their statistical classification', () => {
    expect(isTeleportSave(lava, 0, 0, 15, decay)).toBe(true)
    expect(isDeniedEscape(lava, full, 0, 0, 15, decay, 100)).toBe(false)
  })
  it('recognizes low health or less than a second and a half of lava survival', () => {
    expect(isDeniedEscape(lava, { hp: 300, maxHp: 1000 }, 0, 0, 15, decay, 100)).toBe(true)
    expect(isDeniedEscape(lava, full, 0, 0, 15, decay, 800)).toBe(true)
    expect(isDeniedEscape(lava, { hp: 300, maxHp: 1000 }, 0, 0, 15, decay, 0)).toBe(false)
  })
  it('recognizes a knockback slide heading off the arena even with full health', () => {
    const sliding = { x: 1000, y: 0, kbx: 1500, kby: 0, inLava: false }
    expect(isDeniedEscape(sliding, full, 0, 0, 15, decay, 100)).toBe(true)
    expect(isDeniedEscape({ ...sliding, kbx: 0 }, full, 0, 0, 15, decay, 100)).toBe(false)
    expect(isDeniedEscape(sliding, full, 5000, 0, 15, decay, 100)).toBe(false)
  })
})
