import { Children, createElement, isValidElement, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '../game/store'
import { renderMarkup } from './testing/markup'

type ModalProps = { children: ReactNode; escDisabled: boolean; onClose(): void }
const model = vi.hoisted(() => ({
  settings: null as unknown as Settings, modal: null as ModalProps | null,
  setTab: vi.fn(), setCapture: vi.fn(), setSettings: vi.fn(), toggle: vi.fn(),
  assignKey: vi.fn(() => ({ ok: true, note: 'Assigned' })), clearSecondary: vi.fn(), resetSlotLayout: vi.fn(),
  captureEffect: null as (() => void | (() => void)) | null,
}))

// SSR covers real widgets and markup; the dialog takes its tab and key capture as props. Effects
// do not run in SSR, so the key-capture effect (the one that receives onCapture) is kept to call.
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return {
    ...react,
    useEffect: ((effect, deps) => {
      if (deps?.includes(model.setCapture)) model.captureEffect = effect
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
import { SettingsDialog, SettingsModal, type KeyCapture, type SettingsTab } from './SettingsModal'

const TABS: SettingsTab[] = ['gameplay', 'controls', 'video', 'audio', 'interface']
const initialSettings = { ...model.settings }
function render(tab: SettingsTab = 'gameplay', capturing: KeyCapture | null = null) {
  model.captureEffect = null
  return renderMarkup(createElement(SettingsDialog, { tab, onTab: model.setTab, capturing, onCapture: model.setCapture }))
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
const pressed = (html: ReturnType<typeof render>, group: string) => html.get(`[role="group"][aria-label="${group}"] [aria-pressed="true"]`).text

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  model.settings = { ...initialSettings }
})

describe('tabbed settings', () => {
  it('opens on Gameplay as one labelled modal dialog with a tab list and a close button', () => {
    model.captureEffect = null
    const html = renderMarkup(createElement(SettingsModal))
    const dialog = html.get('[role="dialog"]')
    expect(dialog.attr('aria-modal')).toBe('true')
    expect(dialog.attr('aria-label')).toBe('Settings')
    expect(html.get('[role="tablist"]').attr('aria-label')).toBe('Settings categories')
    const gameplay = html.get('#settings-tab-gameplay')
    expect(gameplay.attr('aria-selected')).toBe('true')
    expect(gameplay.attr('tabindex')).toBe('0')
    expect(gameplay.attr('aria-controls')).toBe('settings-panel-gameplay')
    expect(html.find('[aria-label="Close"]')).toBeDefined()
    expect(html.find('[aria-label="Player name"]')).toBeDefined()
    expect(html.find('[aria-label="Quality"]')).toBeUndefined()
    expect(html.find('[aria-label="Master volume"]')).toBeUndefined()
  })

  it.each(TABS)('links every tab and mounts only the %s category', (tab) => {
    const html = render(tab)
    expect(html.findAll('[role="tab"]')).toHaveLength(TABS.length)
    expect(html.findAll('[role="tabpanel"]')).toHaveLength(TABS.length)
    expect(html.findAll('[role="tabpanel"][hidden]')).toHaveLength(TABS.length - 1)
    expect(html.findAll('[aria-selected="true"]').map((el) => el.attr('id'))).toEqual([`settings-tab-${tab}`])
    for (const id of TABS) expect(html.get(`#settings-panel-${id}`).attr('aria-labelledby')).toBe(`settings-tab-${id}`)
    const uniqueControl: Record<SettingsTab, string> = { gameplay: 'Player name', controls: 'Hotkey preset', video: 'Quality', audio: 'Master volume', interface: 'HUD layout' }
    for (const [id, label] of Object.entries(uniqueControl)) expect(html.find(`[aria-label="${label}"]`) !== undefined).toBe(id === tab)
  })

  it('preserves camera, identity and online settings in Gameplay', () => {
    model.settings = { ...model.settings, playerName: 'Ashbinder', cameraReach: 'far', edgePan: false, edgePanSpeed: 1.75, serverRegion: 'eu' }
    const html = render()
    for (const label of ['Player name', 'Move cancels cast', 'Camera reach', 'Edge pan', 'Edge pan speed', 'Game server region']) expect(html.find(`[aria-label="${label}"]`), label).toBeDefined()
    expect(render('controls').find('[aria-label="Move cancels cast"]')).toBeUndefined()
    expect(html.get('[aria-label="Player name"]').attr('value')).toBe('Ashbinder')
    expect(pressed(html, 'Camera reach')).toBe('Far')
    expect(html.get('[role="switch"][aria-label="Edge pan"]').attr('aria-checked')).toBe('false')
    expect(html.get('input[aria-label="Edge pan speed"]').attr('value')).toBe('1.75')
    expect(html.get('[aria-label="Game server region"]').text).toContain('Europe')
  })

  it('preserves all video values and audio controls', () => {
    model.settings = { ...model.settings, quality: 'ultra', fxIntensity: 0.35, screenShake: 0, fpsCap: 144, resolutionScale: 0.7 }
    const video = render('video')
    for (const label of ['Quality', 'Fullscreen', 'Effects intensity', 'Screen shake', 'Frame rate limit', 'Resolution scale']) expect(video.find(`[aria-label="${label}"]`), label).toBeDefined()
    expect(pressed(video, 'Quality')).toBe('Ultra')
    expect(video.get('input[aria-label="Effects intensity"]').attr('value')).toBe('0.35')
    expect(video.get('input[aria-label="Screen shake"]').attr('value')).toBe('0')
    expect(pressed(video, 'Frame rate limit')).toBe('144')
    expect(video.get('input[aria-label="Resolution scale"]').attr('value')).toBe('0.7')
    const sound = render('audio')
    for (const label of ['Mute', 'Master volume', 'Effects volume', 'Music volume', 'Ambience volume', 'Announcer volume', 'Announcer voice', 'Sound style']) expect(sound.find(`[aria-label="${label}"]`), label).toBeDefined()
    expect(sound.find('[data-testid="test-sound"]')).toBeDefined()
  })

  it('retains both binding keys, per-slot cast modes, drag swapping and resets', () => {
    model.settings = { ...model.settings, keybinds: { spell0: 'KeyH' }, keybindsAlt: { spell0: 'KeyJ' }, castModeSlots: { 0: 'release' } }
    const html = render('controls')
    expect(html.find('[aria-label="Hotkey preset"]')).toBeDefined()
    expect(html.find('[aria-label="Cast mode"]')).toBeDefined()
    expect(html.get('[data-action="spell0"][data-which="primary"]').text).toBe('H')
    expect(html.get('[data-action="spell0"][data-which="secondary"]').text).toBe('J')
    expect(html.get('select[data-slot="0"] option[selected]').attr('value')).toBe('release')
    expect(html.find('[data-drop-slot="0"]')).toBeDefined()
    expect(html.find('[data-drop-slot="11"]')).toBeDefined()
    // custom keys on a spell slot: both resets are offered
    expect(html.get('[data-testid="reset-slot-layout"]').attr('disabled')).toBeUndefined()
    expect(html.get('[data-testid="reset-to-preset"]').attr('disabled')).toBeUndefined()
  })

  it('preserves every interface control', () => {
    const html = render('interface')
    for (const label of ['HUD layout', 'HUD scale', 'Colorblind-safe player colors', 'Key hints', 'Show FPS', 'Net graph']) expect(html.find(`[aria-label="${label}"]`), label).toBeDefined()
    expect(html.find('[aria-label="Player name"]')).toBeUndefined()
  })

  it('clears capture when changing tabs, removes its listener, and restores Escape closing', () => {
    render('controls', { action: 'spell0', which: 'secondary' })
    expect(model.modal!.escDisabled).toBe(true)
    const addEventListener = vi.fn(), removeEventListener = vi.fn()
    vi.stubGlobal('window', { addEventListener, removeEventListener })
    const cleanup = model.captureEffect!()
    const listener = addEventListener.mock.calls[0][1]
    tabs(model.modal!.children).find((tab) => tab.id === 'settings-tab-audio')!.onClick()
    expect(model.setCapture).toHaveBeenCalledExactlyOnceWith(null)
    expect(model.setTab).toHaveBeenCalledExactlyOnceWith('audio')
    if (typeof cleanup !== 'function') throw new Error('Capture effect must remove its listener on unmount')
    cleanup()
    expect(removeEventListener).toHaveBeenCalledExactlyOnceWith('keydown', listener, true)
    render('audio')
    expect(model.modal!.escDisabled).toBe(false)
    expect(model.captureEffect).toBe(null)
  })

  it.each([
    ['Escape', 'primary'], ['Delete', 'secondary'], ['KeyK', 'primary'],
  ] as const)('keeps %s key-capture behavior for the %s binding', (code, which) => {
    render('controls', { action: 'spell0', which })
    const addEventListener = vi.fn()
    vi.stubGlobal('window', { addEventListener, removeEventListener: vi.fn() })
    vi.stubGlobal('document', { querySelectorAll: () => [{ getAttribute: () => 'Settings' }] })
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
  ] as const)('supports keyboard navigation %s + %s → %s', (from, key, target) => {
    render(from)
    const focus = vi.fn(), querySelector = vi.fn(() => ({ focus })), preventDefault = vi.fn()
    const event = { key, preventDefault, currentTarget: { parentElement: { querySelector } } } as unknown as ReactKeyboardEvent<HTMLButtonElement>
    tabs(model.modal!.children).find((tab) => tab.id === `settings-tab-${from}`)!.onKeyDown(event)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(model.setTab).toHaveBeenCalledExactlyOnceWith(target)
    expect(querySelector).toHaveBeenCalledExactlyOnceWith(`#settings-tab-${target}`)
    expect(focus).toHaveBeenCalledOnce()
  })
})
