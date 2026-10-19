import { describe, expect, it } from 'vitest'
import { ANNOUNCER_TEXT } from '../../game/announcer'
import { bigTier, calloutLines } from './Announce'

const thorn = { name: 'Thorn', color: '#a24bff' }
const LOCAL = 0

describe('the KO callout shows the announcer line word for word', () => {
  it('puts your own line ("Double Kill!") on top of your knockout, exactly as spoken', () => {
    const r = calloutLines(thorn, { text: ANNOUNCER_TEXT.double_kill, player: LOCAL }, LOCAL)
    expect(r.top).toBe('Double Kill!')
    expect(r.main?.name).toBe('Thorn')
    expect(r.other).toBeNull()
  })

  it('shows a line someone else earned as its own chip, never as your knockout', () => {
    const r = calloutLines(null, { text: ANNOUNCER_TEXT.rampage, player: 3 }, LOCAL)
    expect(r.top).toBeNull()
    expect(r.main).toBeNull()
    expect(r.other?.text).toBe('Rampage!')
  })

  it('shows a plain knockout when the announcer has nothing to say', () => {
    const r = calloutLines(thorn, null, LOCAL)
    expect(r.top).toBeNull()
    expect(r.main?.name).toBe('Thorn')
  })
})

describe('big kill lines', () => {
  it('shows every streak, multi kill, First Blood and Shutdown big, and nothing else', () => {
    // Why: these are the lines players brag about; a small chip under the clock went unseen.
    // Round flow has its own center banner, occasional lines stay in the small chip.
    const big = ['first_blood', 'double_kill', 'triple_kill', 'multi_kill', 'mega_kill', 'ultra_kill', 'monster_kill', 'killing_spree', 'rampage', 'unstoppable', 'godlike', 'shutdown'] as const
    for (const line of big) expect(bigTier(line)).toBeGreaterThan(0)
    for (const line of ['round_one', 'fight', 'victory', 'arena_shrinks', 'revenge', 'close_call'] as const) expect(bigTier(line)).toBe(0)
    // louder lines are never drawn smaller than the ones they top
    expect(bigTier('godlike')).toBeGreaterThan(bigTier('rampage'))
    expect(bigTier('unstoppable')).toBeGreaterThan(bigTier('killing_spree'))
  })
})
