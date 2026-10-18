import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { frame, pushState, resetFrame } from '../../game/frame'
import { attr, masteryFactor, PASSIVE_ITEMS, spellDef, SPELL_MAX_LEVEL } from '../../sim'
import { newMatch } from '../../sim/testkit'
import { AbilityCardPanel, placeCard, type CardTarget } from './AbilityCard'

const target = (id: string, patch: Partial<CardTarget> = {}): CardTarget => ({
  id, kind: 'spell', context: 'shop', side: 'left',
  anchor: { left: 900, top: 400, right: 960, bottom: 460 }, edge: 800,
  ...patch,
})
const render = (t: CardTarget) => renderToStaticMarkup(createElement(AbilityCardPanel, { t }))
const secs = (value: number) => `${Number(value.toFixed(2))}s`

beforeEach(() => {
  resetFrame()
  frame.localPlayer = 0
})
afterEach(resetFrame)

describe('full ability progression remains a preview, independent of purchases', () => {
  it('keeps current-to-next numbers and exposes every future spell level without buying', () => {
    const s = newMatch()
    s.pawns[0].slots[0] = 'boomerang'
    s.pawns[0].levels[0] = 2
    pushState(s, 0)
    const before = JSON.stringify(s)
    const html = render(target('boomerang'))
    expect(html).toContain('Owned level 2 of 7')
    expect(html).toContain('Full level progression')
    expect(html).toContain('Changes by level')
    for (let level = 1; level <= SPELL_MAX_LEVEL; level++) expect(html).toContain(`aria-label="Level ${level}`)
    expect(html).toContain('aria-label="Level 2, owned"')
    expect(html).toContain('aria-label="Level 3, next purchase"')
    const futureDamage = attr(spellDef('boomerang')!, 'damage', 7)
    expect(html).toMatch(new RegExp(`<td[^>]*>${futureDamage}</td>`))
    expect(html).toContain('Upgrade to level 3')
    expect(html).toContain('ability-media') // the existing clip/poster stays present
    expect(JSON.stringify(s)).toBe(before)
  })

  it('shows passive item progression and all levels even when the item is already maxed', () => {
    const s = newMatch()
    const def = PASSIVE_ITEMS.ring_of_health
    s.pawns[0].slots[8] = 'ring_of_health'
    s.pawns[0].levels[8] = def.maxLevel
    pushState(s, 0)
    const html = render(target('ring_of_health', { kind: 'item' }))
    expect(html).toContain(`Owned level ${def.maxLevel} of ${def.maxLevel}`)
    expect(html).toContain('Max level')
    expect(html).toContain('Full level progression')
    expect(html).toContain('aria-label="Level 1"')
    expect(html).toContain(`+${def.levels.hp_bonus[0]}`)
    expect(html).toContain(`+${def.levels.hp_bonus[def.maxLevel - 1]}`)
    expect(html).not.toContain('next purchase')
  })

  it('shows individual mastery future levels without spending gold or pretending to own them', () => {
    const s = newMatch()
    s.scores[0].masteries.duration = 1
    pushState(s, 0)
    const html = render(target('duration', { kind: 'mastery' }))
    expect(html).toContain('Owned level 1 of 6')
    expect(html).toContain('aria-label="Level 6"')
    expect(html).toContain(`+${Math.round((masteryFactor('duration', 6) - 1) * 100)}%`)
    expect(s.scores[0].masteries.duration).toBe(1)
  })
})

describe('progression respects inspection privacy and effective owner stats', () => {
  it('uses committed opponent Duration for every preview level, never current purchases or local mastery', () => {
    const s = newMatch()
    s.scores[0].masteries.duration = 6
    s.pawns[1].slots[4] = 'grip'
    s.pawns[1].levels[4] = 2
    s.scores[1].masteries.duration = 1
    s.phase = 'fight'
    s.round = 1
    pushState(s, 0)
    s.phase = 'shop'
    s.scores[1].masteries.duration = 5
    pushState(s, 1)
    const html = render(target('grip', { context: 'inspect', player: 1, slot: 4 }))
    const def = spellDef('grip')!
    const historicalMax = secs(attr(def, 'duration', SPELL_MAX_LEVEL) * masteryFactor('duration', 1))
    expect(html).toMatch(new RegExp(`<td[^>]*>${historicalMax}</td>`))
    for (const hiddenMastery of [5, 6]) {
      const hiddenMax = secs(attr(def, 'duration', SPELL_MAX_LEVEL) * masteryFactor('duration', hiddenMastery))
      expect(html).not.toMatch(new RegExp(`<td[^>]*>${hiddenMax}</td>`))
    }
    expect(html).not.toContain('Upgrade to level')
    expect(html).toContain('Owned level 2 of 7')
  })

  it('keeps the first shop private, then shows own and opponent progression during living combat and spectating', () => {
    const s = newMatch()
    s.pawns[1].slots[0] = 'boomerang'
    s.pawns[1].levels[0] = 2
    s.pawns[0].slots[4] = 'shield'
    s.pawns[0].levels[4] = 3
    s.scores[0].masteries.duration = 2
    pushState(s, 0)
    const t = target('boomerang', { context: 'inspect', player: 1, slot: 0 })
    expect(render(t)).toBe('')
    s.phase = 'fight'
    s.round = 1
    pushState(s, 1)
    const alive = render(t)
    expect(alive).toContain('Owned level 2 of 7')
    expect(alive).toContain('Full level progression')
    expect(alive).toContain('aria-label="Level 7"')
    expect(alive).not.toContain('Upgrade to level')
    const own = render(target('shield', { context: 'inspect', player: 0, slot: 4 }))
    expect(own).toContain('Owned level 3 of 7')
    expect(own).toContain('Full level progression')
    expect(own).toContain(secs(attr(spellDef('shield')!, 'duration', 3) * masteryFactor('duration', 2)))
    s.pawns[0].alive = false
    const dead = render(t)
    expect(dead).toContain('Owned level 2 of 7')
    expect(dead).toContain('Full level progression')
    expect(dead).toContain('aria-label="Level 7"')
  })

  it('explains target-dependent stats and gives the scrollable card pointer and keyboard access', () => {
    const s = newMatch()
    pushState(s, 0)
    const html = render(target('grip'))
    expect(html).toContain('target')
    expect(html).toContain('pointer-events-auto')
    expect(html).toContain('role="region"')
    expect(html).toContain('aria-label="All ability levels"')
    expect(html).not.toContain('overflow-x-auto')
    expect(html).not.toContain('min-width:338px')
    expect(html).toContain('max-height:calc(100dvh - 16px)')
  })
})

describe('expanded hover card placement', () => {
  it('keeps a tall progression card inside a short viewport', () => {
    const p = placeCard(target('boomerang'), 300, 620, 1280, 640)
    expect(p.x).toBeGreaterThanOrEqual(8)
    expect(p.y).toBeGreaterThanOrEqual(8)
    expect(p.y + 620).toBeLessThanOrEqual(632)
  })

  it('never computes negative origins on a narrower-than-card viewport', () => {
    const p = placeCard(target('boomerang', { side: 'top' }), 300, 600, 280, 480)
    expect(p.x).toBe(8)
    expect(p.y).toBe(8)
  })

  it('keeps details visible after a resize leaves the original source rectangle outside the viewport', () => {
    for (const side of ['left', 'right', 'top', 'bar'] as const) {
      const p = placeCard(target('boomerang', { side, bar: { left: 900, right: 1200, top: 800, bottom: 900 } }), 300, 450, 640, 480)
      expect(p.x).toBeGreaterThanOrEqual(8)
      expect(p.x + 300).toBeLessThanOrEqual(632)
      expect(p.y).toBeGreaterThanOrEqual(8)
      expect(p.y + 450).toBeLessThanOrEqual(472)
    }
  })
})
