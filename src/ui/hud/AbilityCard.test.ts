import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { frame, pushState, resetFrame } from '../../game/frame'
import { attr, masteryFactor, PASSIVE_ITEMS, spellDef, SPELL_MAX_LEVEL } from '../../sim'
import { newMatch } from '../../sim/testkit'
import { MASTERY_MAX_LEVEL } from '../data/catalog'
import { renderMarkup, testId, type MarkupElement } from '../testing/markup'
import { AbilityCardPanel, placeCard, type CardTarget } from './AbilityCard'

const target = (id: string, patch: Partial<CardTarget> = {}): CardTarget => ({
  id, kind: 'spell', context: 'shop', side: 'left',
  anchor: { left: 900, top: 400, right: 960, bottom: 460 }, edge: 800,
  ...patch,
})
const render = (t: CardTarget) => renderMarkup(createElement(AbilityCardPanel, { t }))
const secs = (value: number) => `${Number(value.toFixed(2))}s`
/** owned level and level count, as the numbers in the level line */
const levels = (html: MarkupElement) => html.get(testId('ability-card-level')).text.match(/\d+/g)!.map(Number)
const cells = (html: MarkupElement) => html.findAll('td').map((td) => td.text)
const progression = (html: MarkupElement) => html.find('[aria-label="Full level progression"]')

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
    expect(levels(html)).toEqual([2, SPELL_MAX_LEVEL])
    expect(progression(html)).toBeDefined()
    for (let level = 1; level <= SPELL_MAX_LEVEL; level++) expect(html.find(`th[aria-label^="Level ${level}"]`), `level ${level}`).toBeDefined()
    expect(html.find('[aria-label="Level 2, owned"]')).toBeDefined()
    expect(html.find('[aria-label="Level 3, next purchase"]')).toBeDefined()
    expect(cells(html)).toContain(String(attr(spellDef('boomerang')!, 'damage', 7)))
    expect(html.get(testId('ability-card-action')).attr('data-state')).toBe('ok')
    expect(html.find('.ability-media')).toBeDefined() // the existing clip/poster stays present
    expect(JSON.stringify(s)).toBe(before)
  })

  it('shows passive item progression and all levels even when the item is already maxed', () => {
    const s = newMatch()
    const def = PASSIVE_ITEMS.ring_of_health
    s.pawns[0].slots[8] = 'ring_of_health'
    s.pawns[0].levels[8] = def.maxLevel
    pushState(s, 0)
    const html = render(target('ring_of_health', { kind: 'item' }))
    expect(levels(html)).toEqual([def.maxLevel, def.maxLevel])
    expect(html.get(testId('ability-card-action')).attr('data-state')).toBe('max')
    expect(progression(html)).toBeDefined()
    expect(html.find('[aria-label="Level 1"]')).toBeDefined()
    expect(html.text).toContain(`+${def.levels.hp_bonus[0]}`)
    expect(html.text).toContain(`+${def.levels.hp_bonus[def.maxLevel - 1]}`)
    expect(html.find('[aria-label$="next purchase"]')).toBeUndefined()
  })

  it('shows individual mastery future levels without spending gold or pretending to own them', () => {
    const s = newMatch()
    s.scores[0].masteries.duration = 1
    pushState(s, 0)
    const html = render(target('duration', { kind: 'mastery' }))
    expect(levels(html)).toEqual([1, MASTERY_MAX_LEVEL])
    expect(html.find(`[aria-label="Level ${MASTERY_MAX_LEVEL}"]`)).toBeDefined()
    expect(html.text).toContain(`+${Math.round((masteryFactor('duration', MASTERY_MAX_LEVEL) - 1) * 100)}%`)
    expect(s.scores[0].masteries.duration).toBe(1)
  })
})

// Which kit an inspect card may show is game/inspect.test.ts; this is the card's wiring to it.
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
    expect(cells(html)).toContain(secs(attr(def, 'duration', SPELL_MAX_LEVEL) * masteryFactor('duration', 1)))
    for (const hiddenMastery of [5, 6]) {
      expect(cells(html)).not.toContain(secs(attr(def, 'duration', SPELL_MAX_LEVEL) * masteryFactor('duration', hiddenMastery)))
    }
    expect(html.find(testId('ability-card-action'))).toBeUndefined()
    expect(levels(html)).toEqual([2, SPELL_MAX_LEVEL])
  })

  it('explains target-dependent stats and keeps the scrollable card keyboard-reachable inside the viewport', () => {
    const s = newMatch()
    pushState(s, 0)
    const html = render(target('grip'))
    expect(html.findAll(testId('ability-card-note')).length).toBeGreaterThan(0)
    const card = html.get('[role="region"]')
    expect(card.attr('tabindex')).toBe('-1')
    expect(card.style['max-height']).toBeDefined()
    expect(card.style['overflow-y']).toBe('auto')
    expect(card.find('[aria-label="All ability levels"]')).toBeDefined()
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
