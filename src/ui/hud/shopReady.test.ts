import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { frame, pushState, resetFrame } from '../../game/frame'
import { killPawn } from '../../sim/combat'
import { step } from '../../sim'
import { cmd, newMatch, pawn, toCombat } from '../../sim/testkit'
import type { SimState } from '../../sim/types'
import { renderMarkup, testId } from '../testing/markup'
import { ShopReady } from './Shop'

afterEach(resetFrame)

/** `humans` human seats, the rest bots, viewed by seat `local` */
function view(s: SimState, local: number) {
  frame.localPlayer = local
  pushState(s)
  return renderMarkup(createElement('div', null, createElement(ShopReady)))
}
function table(humans: number, n = 4): SimState {
  const s = newMatch({}, n)
  for (const slot of s.slots) if (slot.id >= humans) Object.assign(slot, { kind: 'bot', difficulty: 'medium' })
  return s
}

describe('Shop Ready button', () => {
  it('walks idle, ready and starting, and counts the humans who are ready', () => {
    const s = table(2)
    let html = view(s, 0)
    expect(html.get(testId('shop-ready')).attr('data-state')).toBe('idle')
    expect(html.get(testId('shop-ready-count')).attr('data-ready')).toBe('0')
    expect(html.get(testId('shop-ready-count')).attr('data-total')).toBe('2')
    step(s, [cmd(0, { kind: 'shopReady', ready: true })])
    html = view(s, 0)
    expect(html.get(testId('shop-ready')).attr('data-state')).toBe('ready')
    expect(html.get(testId('shop-ready-count')).attr('data-ready')).toBe('1')
    step(s, [cmd(1, { kind: 'shopReady', ready: true })])
    html = view(s, 1)
    expect(html.get(testId('shop-ready')).attr('data-state')).toBe('starting')
    expect(html.get(testId('shop-ready')).attr('disabled')).toBeDefined()
  })

  it('hides the count when you are the only human: "1/1" says nothing', () => {
    expect(view(table(1), 0).find(testId('shop-ready-count'))).toBeUndefined()
  })

  it('is absent for seats whose Ready never counts', () => {
    expect(view(table(1), 2).find(testId('shop-ready'))).toBeUndefined()
    expect(view(table(1), -1).find(testId('shop-ready'))).toBeUndefined()
  })

  it('appears for a knocked-out player during the fight, never for one still fighting', () => {
    const s = table(2)
    toCombat(s)
    expect(view(s, 0).find(testId('shop-ready'))).toBeUndefined()
    killPawn(s, pawn(s, 0), null, 'lava')
    expect(view(s, 0).get(testId('shop-ready')).attr('data-state')).toBe('idle')
  })
})
