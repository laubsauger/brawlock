import { Children, createElement, isValidElement, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '../game/store'

type Capture = { action: 'spell0'; which: 'primary' | 'secondary' }
type ModalProps = { children: ReactNode; escDisabled: boolean; onClose(): void }
const model = vi.hoisted(() => ({
  tab: 'gameplay', capture: null as Capture | null, stateIndex: 0,
  settings: null as unknown as Settings, modal: null as ModalProps | null,
  setTab: vi.fn(), setCapture: vi.fn(), setSettings: vi.fn(), toggle: vi.fn(),
  assignKey: vi.fn(() => ({ ok: true, note: 'Assigned' })), clearSecondary: vi.fn(), resetSlotLayout: vi.fn(),
  captureEffect: null as (() => void | (() => void)) | null,
}))

// SSR covers real widgets and markup. Only the two panel/capture states are
// controlled so every category and its event handlers can be exercised without
// adding a browser/DOM dependency to the test suite.
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return {
    ...react,
    useState: ((initial: unknown) => {
      const index = model.stateIndex++
      if (index === 1) return [model.capture, model.setCapture]
      if (index === 2) return [model.tab, model.setTab]
      return react.useState(initial)
    }) as typeof react.useState,
    useEffect: ((effect, deps) => {
      if (deps?.[1] === model.setCapture) model.captureEffect = effect
      react.useEffect(effect, deps)
    }) as typeof react.useEffect,
  }
})
vi.mock('../game/store', async (original) => {
  const store = await original<typeof import('../game/store')>()
  model.settings = { ...store.useGame.getState().settings }
  return {
    ...store,
    useGame: <T,>(selector: (state: ReturnType<typeof store.useGame.getState>) => T) => selector({
      ...store.useGame.getState(), settings: model.settings, setSettings: model.setSettings, toggle: model.toggle,
    }),
  }
})
vi.mock('../game/session', () => ({ online: { configured: true, status: () => [{ id: 'eu', label: 'Europe', state: 'up', rttMs: 42 }] } }))
vi.mock('./lib/remap', () => ({ assignKey: model.assignKey, clearSecondary: model.clearSecondary, resetSlotLayout: model.resetSlotLayout }))
vi.mock('./widgets', async (original) => {
  const widgets = await original<typeof import('./widgets')>()
  return { ...widgets, Modal: (props: Parameters<typeof widgets.Modal>[0]) => {
    model.modal = props as ModalProps
    return createElement(widgets.Modal, props)
  } }
})
import { SettingsModal } from './SettingsModal'

const initialSettings = { ...model.settings }
function markup(tab = model.tab) {
  model.tab = tab
  model.stateIndex = 0
  model.captureEffect = null
  return renderToStaticMarkup(createElement(SettingsModal))
}
type TabProps = { id: string; role: 'tab'; onClick(): void; onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void }
function tabs(node: ReactNode): TabProps[] {
  const found: TabProps[] = []
  Children.forEach(node, (child) => {
    if (!isValidElement<{ children?: ReactNode; role?: string }>(child)) return
    if (child.props.role === 'tab') found.push(child.props as TabProps)
    else found.push(...tabs(child.props.children))
  })
  return found
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  model.tab = 'gameplay'
  model.capture = null
  model.settings = { ...initialSettings }
})

describe('tabbed settings', () => {
  it('opens Gameplay in a wider dialog with a wrapping sticky tab bar and persistent close button', () => {
    const html = markup()
    expect(html).toContain('max-w-4xl')
    expect(html).toContain('role="dialog" aria-modal="true" aria-label="Settings"')
    expect(html).toContain('role="tablist" aria-label="Settings categories"')
    expect(html).toContain('sticky top-0')
    expect(html).toContain('flex-wrap')
    expect(html).toContain('id="settings-tab-gameplay" aria-controls="settings-panel-gameplay" aria-selected="true" tabindex="0"')
    expect(html).toContain('aria-label="Close"')
    expect(html).toContain('aria-label="Player name"')
    expect(html).not.toContain('aria-label="Quality"')
    expect(html).not.toContain('aria-label="Master volume"')
  })

  it.each(['gameplay', 'controls', 'video', 'audio', 'interface'])('links every tab and mounts only the %s category', (tab) => {
    const html = markup(tab)
    expect(html.match(/role="tab"/g)).toHaveLength(5)
    expect(html.match(/role="tabpanel"/g)).toHaveLength(5)
    expect(html.match(/hidden=""/g)).toHaveLength(4)
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
    for (const id of ['gameplay', 'controls', 'video', 'audio', 'interface']) {
      expect(html).toContain(`id="settings-panel-${id}" aria-labelledby="settings-tab-${id}"`)
    }
    const uniqueControl: Record<string, string> = { gameplay: 'Player name', controls: 'Hotkey preset', video: 'Quality', audio: 'Master volume', interface: 'HUD layout' }
    for (const [id, label] of Object.entries(uniqueControl)) expect(html.includes(`aria-label="${label}"`)).toBe(id === tab)
  })

  it('preserves camera, identity and online settings in Gameplay', () => {
    model.settings = { ...model.settings, playerName: 'Ashbinder', cameraReach: 'far', edgePan: false, edgePanSpeed: 1.75, serverRegion: 'eu' }
    const html = markup()
    for (const label of ['Player name', 'Move cancels cast', 'Camera reach', 'Edge pan', 'Edge pan speed', 'Game server region']) expect(html).toContain(`aria-label="${label}"`)
    expect(html).not.toContain('as in the original')
    expect(markup('controls')).not.toContain('Move cancels cast')
    expect(html).toContain('value="Ashbinder"')
    expect(html).toMatch(/aria-pressed="true"[^>]*>Far</)
    expect(html).toContain('aria-checked="false" aria-label="Edge pan"')
    expect(html).toMatch(/aria-label="Edge pan speed"[^>]*value="1.75"/)
    expect(html).toContain('Europe')
  })

  it('preserves all video values and audio controls', () => {
    model.settings = { ...model.settings, quality: 'ultra', fxIntensity: 0.35, screenShake: 0, fpsCap: 144, resolutionScale: 0.7 }
    const video = markup('video')
    for (const label of ['Quality', 'Fullscreen', 'Effects intensity', 'Screen shake', 'Frame rate limit', 'Resolution scale']) expect(video).toContain(`aria-label="${label}"`)
    expect(video).toMatch(/aria-pressed="true"[^>]*>Ultra</)
    expect(video).toMatch(/aria-label="Effects intensity"[^>]*value="0.35"/)
    expect(video).toMatch(/aria-label="Screen shake"[^>]*value="0"/)
    expect(video).toMatch(/aria-pressed="true"[^>]*>144</)
    expect(video).toMatch(/aria-label="Resolution scale"[^>]*value="0.7"/)
    const sound = markup('audio')
    for (const label of ['Mute', 'Master volume', 'Effects volume', 'Music volume', 'Ambience volume', 'Announcer volume', 'Announcer voice', 'Sound style']) expect(sound).toContain(`aria-label="${label}"`)
    expect(sound).toContain('Test sound')
  })

  it('retains both binding keys, per-slot cast modes, drag swapping and resets', () => {
    model.settings = { ...model.settings, keybinds: { spell0: 'KeyH' }, keybindsAlt: { spell0: 'KeyJ' }, castModeSlots: { 0: 'release' } }
    const html = markup('controls')
    expect(html).toContain('aria-label="Hotkey preset"')
    expect(html).toContain('aria-label="Cast mode"')
    expect(html).toContain('main key: H. Click to change')
    expect(html).toContain('second key: J. Click to change')
    expect(html).toContain('aria-label="Cast mode for Column 1, knockout"')
    expect(html).toContain('<option value="release" selected="">On release</option>')
    expect(html).toContain('data-drop-slot="0"')
    expect(html).toContain('data-drop-slot="11"')
    expect(html).toContain('Reset slot layout')
    expect(html).toContain('Reset to preset')
    expect(html).toContain('sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]')
  })

  it('preserves every interface control', () => {
    const html = markup('interface')
    for (const label of ['HUD layout', 'HUD scale', 'Colorblind-safe player colors', 'Key hints', 'Performance overlay', 'Net graph']) expect(html).toContain(`aria-label="${label}"`)
    expect(html).not.toContain('aria-label="Player name"')
  })

  it('clears capture before changing tabs, removes its listener, and restores Escape closing', () => {
    model.capture = { action: 'spell0', which: 'secondary' }
    markup('controls')
    expect(model.modal!.escDisabled).toBe(true)
    const addEventListener = vi.fn(), removeEventListener = vi.fn()
    vi.stubGlobal('window', { addEventListener, removeEventListener })
    const cleanup = model.captureEffect!()
    const listener = addEventListener.mock.calls[0][1]
    tabs(model.modal!.children).find((tab) => tab.id === 'settings-tab-audio')!.onClick()
    expect(model.setCapture).toHaveBeenCalledExactlyOnceWith(null)
    expect(model.setTab).toHaveBeenCalledExactlyOnceWith('audio')
    expect(model.setCapture.mock.invocationCallOrder[0]).toBeLessThan(model.setTab.mock.invocationCallOrder[0])
    if (typeof cleanup !== 'function') throw new Error('Capture effect must remove its listener on unmount')
    cleanup()
    expect(removeEventListener).toHaveBeenCalledExactlyOnceWith('keydown', listener, true)
    model.capture = null
    markup('audio')
    expect(model.modal!.escDisabled).toBe(false)
    expect(model.captureEffect).toBe(null)
  })

  it.each([
    ['Escape', 'primary'], ['Delete', 'secondary'], ['KeyK', 'primary'],
  ] as const)('keeps %s key-capture behavior for the %s binding', (code, which) => {
    model.capture = { action: 'spell0', which }
    markup('controls')
    const addEventListener = vi.fn()
    vi.stubGlobal('window', { addEventListener, removeEventListener: vi.fn() })
    const cleanup = model.captureEffect!()
    const event = { code, preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn() }
    addEventListener.mock.calls[0][1](event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(model.setCapture).toHaveBeenCalledExactlyOnceWith(null)
    if (code === 'KeyK') expect(model.assignKey).toHaveBeenCalledExactlyOnceWith('spell0', which, 'KeyK')
    else expect(model.assignKey).not.toHaveBeenCalled()
    if (code === 'Delete') expect(model.clearSecondary).toHaveBeenCalledExactlyOnceWith('spell0')
    else expect(model.clearSecondary).not.toHaveBeenCalled()
    if (typeof cleanup === 'function') cleanup()
  })

  it.each([
    ['gameplay', 'ArrowLeft', 'interface'], ['interface', 'ArrowRight', 'gameplay'],
    ['controls', 'ArrowRight', 'video'], ['audio', 'Home', 'gameplay'], ['video', 'End', 'interface'],
  ])('supports keyboard navigation %s + %s → %s', (from, key, target) => {
    markup(from)
    const focus = vi.fn(), querySelector = vi.fn(() => ({ focus })), preventDefault = vi.fn()
    const event = { key, preventDefault, currentTarget: { parentElement: { querySelector } } } as unknown as ReactKeyboardEvent<HTMLButtonElement>
    tabs(model.modal!.children).find((tab) => tab.id === `settings-tab-${from}`)!.onKeyDown(event)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(model.setTab).toHaveBeenCalledExactlyOnceWith(target)
    expect(querySelector).toHaveBeenCalledExactlyOnceWith(`#settings-tab-${target}`)
    expect(focus).toHaveBeenCalledOnce()
  })
})
