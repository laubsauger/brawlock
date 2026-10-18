import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Children, createElement, isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PlayerSlot } from '../../sim/types'
import { PLAYER_COLORS } from '../../net/lobbyColors'

const request = vi.hoisted(() => vi.fn())
vi.mock('../../game/session', () => ({ session: { setPlayerColor: request } }))
import { PlayerColorPicker } from './PlayerColorPicker'

const slot = (id: number, color: number, kind: PlayerSlot['kind'] = 'human'): PlayerSlot => ({ id, color, kind, name: kind === 'bot' ? 'Thorn' : `Player ${id}`, team: id })
const local = slot(0, PLAYER_COLORS[0])
const slots = [local, slot(1, PLAYER_COLORS[1]), slot(2, PLAYER_COLORS[2], 'bot')]
type ButtonProps = { 'aria-label': string; onClick(): void; disabled: boolean; children?: ReactNode }

function buttons(node: ReactNode): ButtonProps[] {
  const found: ButtonProps[] = []
  Children.forEach(node, (child) => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return
    if (child.type === 'button') found.push(child.props as ButtonProps)
    else found.push(...buttons(child.props.children))
  })
  return found
}

beforeEach(() => request.mockClear())

describe('lobby color picker', () => {
  it('labels the selected, human-reserved, bot-swappable and free palette colors', () => {
    const markup = renderToStaticMarkup(createElement(PlayerColorPicker, { local, slots, editable: true }))
    expect(markup).toContain('aria-label="Red, selected" aria-pressed="true"')
    expect(markup).toMatch(/aria-label="Blue, used by Player 1"[^>]*disabled=""/)
    expect(markup).toContain('aria-label="Teal, swaps with Thorn (bot)"')
    expect(markup).toContain('aria-label="Purple, available"')
    expect(buttons(PlayerColorPicker({ local, slots, editable: true }))).toHaveLength(PLAYER_COLORS.length)
  })

  it('requests a bot color but keeps the current selection until the authoritative slot changes', () => {
    const before = structuredClone(slots)
    const options = buttons(PlayerColorPicker({ local, slots, editable: true }))
    options.find((button) => button['aria-label'].startsWith('Teal,'))!.onClick()
    expect(request).toHaveBeenCalledExactlyOnceWith(PLAYER_COLORS[2])
    expect(slots).toEqual(before)
    const waiting = renderToStaticMarkup(createElement(PlayerColorPicker, { local, slots, editable: true }))
    expect(waiting).toContain('aria-label="Red, selected" aria-pressed="true"')
    const confirmed = { ...local, color: PLAYER_COLORS[2] }
    const confirmedSlots = [confirmed, slots[1], { ...slots[2], color: local.color }]
    const result = renderToStaticMarkup(createElement(PlayerColorPicker, { local: confirmed, slots: confirmedSlots, editable: true }))
    expect(result).toContain('aria-label="Teal, selected" aria-pressed="true"')
    expect(result).toContain('aria-label="Red, swaps with Thorn (bot)"')
  })

  it('does not emit a selected, human-occupied or noneditable request', () => {
    const options = buttons(PlayerColorPicker({ local, slots, editable: true }))
    options.find((button) => button['aria-label'].startsWith('Red,'))!.onClick()
    options.find((button) => button['aria-label'].startsWith('Blue,'))!.onClick()
    for (const button of buttons(PlayerColorPicker({ local, slots, editable: false }))) {
      expect(button.disabled).toBe(true)
      button.onClick()
    }
    expect(request).not.toHaveBeenCalled()
  })

  it('never exposes a player color selector for a bot slot', () => {
    expect(renderToStaticMarkup(createElement(PlayerColorPicker, { local: slots[2], slots, editable: true }))).toBe('')
  })
})
