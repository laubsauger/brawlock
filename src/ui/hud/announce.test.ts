import { describe, expect, it } from 'vitest'
import { ANNOUNCER_TEXT } from '../../game/announcer'
import { calloutLines } from './Announce'

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
