import { describe, expect, it } from 'vitest'
import { KillStamps, MULTI_WINDOW, STAMP_LIFE } from './killStamps'

const thorn = { player: 3, name: 'Thorn', color: 0xa24bff }
const vex = { player: 4, name: 'Vex', color: 0xffd60a }
// pawn ids differ from player ids on purpose: plates are keyed by pawn
const KILLER_PLAYER = 1
const KILLER_PAWN = 101
const VICTIM_PAWN = 103

describe('kill stamps credit the killer', () => {
  it('puts the stamp over the killer, naming the victim, and never over the victim', () => {
    const k = new KillStamps()
    k.death(thorn, KILLER_PLAYER, KILLER_PAWN, 10)
    expect(k.stampOf(KILLER_PAWN, 10.5)?.victim.name).toBe('Thorn')
    expect(k.stampOf(VICTIM_PAWN, 10.5)).toBeNull()
    expect(k.pipsOf(KILLER_PAWN)).toBe(1)
    expect(k.pipsOf(VICTIM_PAWN)).toBe(0)
  })

  it('gives no stamp and no pip for a death nobody caused (walked into the lava)', () => {
    const k = new KillStamps()
    expect(k.death(thorn, null, null, 10)).toBeNull()
    expect(k.pipsOf(KILLER_PAWN)).toBe(0)
  })

  it('gives no credit for a self-inflicted death', () => {
    const k = new KillStamps()
    expect(k.death(thorn, thorn.player, VICTIM_PAWN, 10)).toBeNull()
    expect(k.stampOf(VICTIM_PAWN, 10)).toBeNull()
  })

  it('stacks quick kills into a streak (×2) that names the latest victim', () => {
    const k = new KillStamps()
    k.death(thorn, KILLER_PLAYER, KILLER_PAWN, 10)
    k.death(vex, KILLER_PLAYER, KILLER_PAWN, 10 + MULTI_WINDOW - 0.5)
    const s = k.stampOf(KILLER_PAWN, 12.6)!
    expect(s.count).toBe(2)
    expect(s.victim.name).toBe('Vex')
  })

  it('starts a new count when kills are far apart', () => {
    const k = new KillStamps()
    k.death(thorn, KILLER_PLAYER, KILLER_PAWN, 10)
    k.death(vex, KILLER_PLAYER, KILLER_PAWN, 10 + MULTI_WINDOW + 1)
    expect(k.stampOf(KILLER_PAWN, 10 + MULTI_WINDOW + 1)?.count).toBe(1)
    expect(k.pipsOf(KILLER_PAWN)).toBe(2)
  })

  it('lets the stamp expire, but keeps the round pips until the next round', () => {
    const k = new KillStamps()
    k.death(thorn, KILLER_PLAYER, KILLER_PAWN, 10)
    expect(k.stampOf(KILLER_PAWN, 10 + STAMP_LIFE + 0.1)).toBeNull()
    expect(k.pipsOf(KILLER_PAWN)).toBe(1)
    k.resetRound()
    expect(k.pipsOf(KILLER_PAWN)).toBe(0)
  })
})

describe('streak wording', () => {
  it('names quick multi-kills the way the HUD callout reads them', async () => {
    const { streakWord } = await import('./killStamps')
    expect(streakWord(1)).toBe('')
    expect(streakWord(2)).toBe('Double')
    expect(streakWord(3)).toBe('Triple')
  })
})
