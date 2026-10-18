import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { frame, pushState, resetFrame } from '../../game/frame'
import { newMatch } from '../../sim/testkit'
import { AbilityCardHost, abilityCardProps, hideAbilityCard } from './AbilityCard'

// Render the actual portal content without a browser; retain its real event
// handlers so the test can drive the source → crossed icon → card sequence.
const captured = vi.hoisted(() => ({ props: null as null | { onPointerEnter: () => void; onKeyDown: (e: { key: string; shiftKey: boolean; preventDefault(): void; stopPropagation(): void }) => void } }))
vi.mock('react', async (load) => ({ ...await load<typeof import('react')>(), useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() }))
vi.mock('react-dom', async (load) => ({ ...await load<typeof import('react-dom')>(), createPortal: (children: ReactNode) => children }))
vi.mock('react/jsx-dev-runtime', async (load) => {
  const actual = await load<typeof import('react/jsx-dev-runtime')>()
  return { ...actual, jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => {
    const props = args[1] as Record<string, unknown>
    if (props?.['data-ability-card']) captured.props = props as unknown as NonNullable<typeof captured.props>
    return actual.jsxDEV(...args)
  } }
})
vi.mock('../lib/abilityMedia', () => ({ hasClip: () => false, loadMediaIndex: async () => new Set(), saveData: () => true, posterUrl: () => '', showClip: () => {}, stopClip: () => {} }))

function anchor(left: number) {
  return { getBoundingClientRect: () => ({ left, right: left + 60, top: 300, bottom: 360 }), closest: () => null, focus: vi.fn() } as unknown as HTMLElement
}
const props = (id: string) => abilityCardProps(() => ({ id, kind: 'spell', context: 'shop', side: 'left' }))
const enter = (handlers: ReturnType<typeof props>, element: HTMLElement) => handlers.onPointerEnter({ currentTarget: element, pointerType: 'mouse', buttons: 0 } as Parameters<typeof handlers.onPointerEnter>[0])
const html = () => renderToStaticMarkup(createElement(AbilityCardHost))

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  vi.stubGlobal('document', { activeElement: null })
  resetFrame()
  frame.localPlayer = 0
  pushState(newMatch(), 0)
  captured.props = null
})
afterEach(() => {
  hideAbilityCard()
  resetFrame()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('interactive hover intent', () => {
  it('keeps the original details while crossing icons toward the card, then permits scrolling inside', () => {
    const grip = props('grip'), boomerang = props('boomerang'), lightning = props('lightning')
    enter(grip, anchor(1100))
    vi.advanceTimersByTime(150)
    expect(html()).toContain('data-ability-card="grip"')
    const card = captured.props!
    grip.onPointerLeave()
    enter(boomerang, anchor(900))
    vi.advanceTimersByTime(50)
    expect(html()).toContain('data-ability-card="grip"')
    boomerang.onPointerLeave()
    enter(lightning, anchor(750))
    vi.advanceTimersByTime(50)
    // Entering the active details cancels both a pending icon switch and hide.
    card.onPointerEnter()
    vi.advanceTimersByTime(450)
    expect(html()).toContain('data-ability-card="grip"')
    expect(html()).toContain('Scroll all ability levels')
  })

  it('switches on an intentional hover and immediately on keyboard focus', () => {
    const grip = props('grip'), boomerang = props('boomerang')
    const source = anchor(1100)
    grip.onFocus({ currentTarget: source } as Parameters<typeof grip.onFocus>[0])
    expect(html()).toContain('data-ability-card="grip"')
    enter(boomerang, anchor(900))
    vi.advanceTimersByTime(149)
    expect(html()).toContain('data-ability-card="grip"')
    vi.advanceTimersByTime(1)
    expect(html()).toContain('data-ability-card="boomerang"')
    grip.onFocus({ currentTarget: source } as Parameters<typeof grip.onFocus>[0])
    expect(html()).toContain('data-ability-card="grip"')
    captured.props!.onKeyDown({ key: 'Escape', shiftKey: false, preventDefault() {}, stopPropagation() {} })
    expect(source.focus).toHaveBeenCalledOnce()
    expect(html()).toBe('')
  })
})
