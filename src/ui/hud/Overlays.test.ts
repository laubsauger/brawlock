import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { frame, pushState, resetFrame } from '../../game/frame'
import { fight, grant } from '../../sim/testkit'
import { addModifier } from '../../sim/modifiers'
import { CharacterBody, Scoreboard } from './Overlays'

afterEach(resetFrame)

describe('character sheet effective ability values', () => {
  it('uses the local mastery, level, active effects and match settings for current/next values', () => {
    const s = fight(2, undefined, { dmgMultiplier: 1.5 })
    grant(s, 0, 'rush', 2)
    addModifier(s, s.pawns[0], 'pact', 300, 0, { mult: 1.5, slowTime: 6, slow: 66 })
    s.scores[0].masteries.duration = 3
    s.scores[0].masteries.range = 2
    frame.localPlayer = 0
    pushState(s, 0)
    const html = renderToStaticMarkup(createElement(CharacterBody))
    expect(html).toContain('Duration 8.13s')
    expect(html).toContain('Duration 8.75s')
    // Starting Fireball is level 1: 70 x Pact 1.5 x match damage 1.5.
    expect(html).toContain('Damage 157.5')
    expect(html).toContain('Range 1220')
    expect(html).toContain('Before target damage reduction.')
  })
})

describe('scoreboard net worth', () => {
  /** Why: net worth measures all gold a player gathered, and a purchase must not change it (it
   * would leak a live shop phase's hidden buys). */
  it('shows gold on hand plus gold spent, unchanged by a purchase', () => {
    const s = fight(2)
    s.scores[0].gold = 20
    s.scores[0].spent = 35
    frame.localPlayer = 0
    pushState(s, 0)
    const before = renderToStaticMarkup(createElement(Scoreboard))
    expect(before).toContain('Worth')
    expect(before).toContain('>55<')
    s.scores[0].gold = 5
    s.scores[0].spent = 50
    pushState(s, 1)
    expect(renderToStaticMarkup(createElement(Scoreboard))).toContain('>55<')
  })
})
