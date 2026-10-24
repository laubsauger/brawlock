import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../sim'
import { isDeniedEscape, isTeleportSave, slideDecay, type SlideSnapshot } from './teleportSave'

const lava: SlideSnapshot = { x: 5000, y: 0, kbx: 0, kby: 0, inLava: true }
const decay = slideDecay(0.96)
const full = { hp: 1000, moveSpeed: 210 }
const hp = (n: number) => ({ ...full, hp: n })
/** layer 15 (radius 1400), default friction, `lavaDps` per second */
const sim = (lavaDps = 100) => ({ settings: { ...DEFAULT_SETTINGS, lavaDps }, arena: { layer: 15, nextShrinkTick: -1, theme: 0 } })

describe('Denied escape callouts', () => {
  it('keeps ordinary full-health lava blinks quiet without changing their statistical classification', () => {
    expect(isTeleportSave(lava, 0, 0, 15, decay)).toBe(true)
    expect(isDeniedEscape(lava, full, 0, 0, sim())).toBe(false)
  })
  it('recognizes at most one second of lava survival, not merely low health', () => {
    expect(isDeniedEscape(lava, hp(100), 0, 0, sim())).toBe(true)
    expect(isDeniedEscape(lava, full, 0, 0, sim(1000))).toBe(true)
    // 30% health is 3 s of lava: a routine blink, not a save
    expect(isDeniedEscape(lava, hp(300), 0, 0, sim())).toBe(false)
    expect(isDeniedEscape(lava, hp(300), 0, 0, sim(0))).toBe(false)
  })
  it('calls a slide off the arena only when the lava it ends in would leave at most one second', () => {
    // pushed out at 1500 u/s from 1000 units out: ~350 lava damage before walking back
    const sliding: SlideSnapshot = { x: 1000, y: 0, kbx: 1500, kby: 0, inLava: false }
    expect(isTeleportSave(sliding, 0, 0, 15, decay)).toBe(true)
    // healthy or half health survives the lava with seconds to spare: a routine blink (playtest:
    // "Denied!" at 50% HP)
    expect(isDeniedEscape(sliding, full, 0, 0, sim())).toBe(false)
    expect(isDeniedEscape(sliding, hp(500), 0, 0, sim())).toBe(false)
    // 400 HP would come back with 50: within a second of death. 300 would burn
    expect(isDeniedEscape(sliding, hp(400), 0, 0, sim())).toBe(true)
    expect(isDeniedEscape(sliding, hp(300), 0, 0, sim())).toBe(true)
    // a softer push ends in the lava, but walking back keeps the pawn off it
    expect(isDeniedEscape({ ...sliding, kbx: 600 }, hp(150), 0, 0, sim())).toBe(false)
    expect(isDeniedEscape({ ...sliding, kbx: 0 }, hp(300), 0, 0, sim())).toBe(false)
    // landing in the lava is no escape
    expect(isDeniedEscape(sliding, hp(300), 5000, 0, sim())).toBe(false)
  })
})
