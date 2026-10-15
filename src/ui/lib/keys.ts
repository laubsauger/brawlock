import { useMemo } from 'react'
import { useGame, type KeyPreset, type Settings } from '../../game/store'

/**
 * Keybindings. Three presets (docs/PLAN.md §6), every action rebindable in
 * Settings > Controls; overrides live in settings.keybinds on top of the
 * preset. Physical key codes (KeyboardEvent.code), so the keyboard layout
 * does not matter. Slots 0..5 = spell columns, 6..11 = items.
 */
export type BindAction =
  | 'spell0'
  | 'spell1'
  | 'spell2'
  | 'spell3'
  | 'spell4'
  | 'spell5'
  | 'item0'
  | 'item1'
  | 'item2'
  | 'item3'
  | 'item4'
  | 'item5'
  | 'stop'
  | 'hold'
  | 'shop'
  | 'character'
  | 'scoreboard'
  | 'recenter'
  | 'mute'

/** Key per action (KeyboardEvent.code); '' = unbound. */
export type BindMap = Record<BindAction, string>

/** Primary and secondary key for every action. Either one triggers the action. */
export interface Binds {
  primary: BindMap
  secondary: BindMap
}

export const BIND_GROUPS: { title: string; actions: { id: BindAction; label: string }[] }[] = [
  {
    title: 'Spells',
    actions: [
      { id: 'spell0', label: 'Column 1, knockout' },
      { id: 'spell1', label: 'Column 2, transport' },
      { id: 'spell2', label: 'Column 3, damage' },
      { id: 'spell3', label: 'Column 4, devastator' },
      { id: 'spell4', label: 'Column 5, defense' },
      { id: 'spell5', label: 'Column 6, control' },
    ],
  },
  {
    title: 'Items',
    actions: [
      { id: 'item0', label: 'Item 1 (Fireball)' },
      { id: 'item1', label: 'Item 2 (Scourge)' },
      { id: 'item2', label: 'Item 3' },
      { id: 'item3', label: 'Item 4' },
      { id: 'item4', label: 'Item 5' },
      { id: 'item5', label: 'Item 6' },
    ],
  },
  {
    title: 'Commands',
    actions: [
      { id: 'stop', label: 'Stop (cancels a windup)' },
      { id: 'hold', label: 'Hold position' },
    ],
  },
  {
    title: 'Interface',
    actions: [
      { id: 'shop', label: 'Shop' },
      { id: 'character', label: 'Character stats' },
      { id: 'scoreboard', label: 'Scoreboard (hold)' },
      { id: 'recenter', label: 'Center camera' },
      { id: 'mute', label: 'Mute' },
    ],
  },
]

export const ACTION_LABEL: Record<BindAction, string> = Object.fromEntries(BIND_GROUPS.flatMap((g) => g.actions.map((a) => [a.id, a.label]))) as Record<
  BindAction,
  string
>

const COMMON = { stop: 'KeyS', hold: 'KeyH', scoreboard: 'Tab', recenter: 'Space', mute: 'KeyM' } as const
const DIGITS = { item0: 'Digit1', item1: 'Digit2', item2: 'Digit3', item3: 'Digit4', item4: 'Digit5', item5: 'Digit6' } as const

export const PRESETS: Record<KeyPreset, BindMap> = {
  // Dota 2 defaults. B is item 5 there, so the shop sits on F4 as in Dota; C is item 3, so stats move to K.
  dota: {
    spell0: 'KeyQ',
    spell1: 'KeyW',
    spell2: 'KeyE',
    spell3: 'KeyD',
    spell4: 'KeyF',
    spell5: 'KeyR',
    item0: 'KeyZ',
    item1: 'KeyX',
    item2: 'KeyC',
    item3: 'KeyV',
    item4: 'KeyB',
    item5: 'KeyN',
    shop: 'F4',
    character: 'KeyK',
    ...COMMON,
  },
  modern: {
    spell0: 'KeyQ',
    spell1: 'KeyW',
    spell2: 'KeyE',
    spell3: 'KeyR',
    spell4: 'KeyD',
    spell5: 'KeyF',
    ...DIGITS,
    shop: 'KeyB',
    character: 'KeyC',
    ...COMMON,
  },
  // the original's WC3-era column letters; C is a spell column, so stats sit on K
  classic: {
    spell0: 'KeyD',
    spell1: 'KeyR',
    spell2: 'KeyT',
    spell3: 'KeyE',
    spell4: 'KeyC',
    spell5: 'KeyY',
    ...DIGITS,
    shop: 'KeyB',
    character: 'KeyK',
    ...COMMON,
  },
}

export const PRESET_INFO: { value: KeyPreset; label: string; hint: string }[] = [
  { value: 'dota', label: 'Dota', hint: 'Spells Q W E D F R, items Z X C V B N, shop F4' },
  { value: 'modern', label: 'Modern', hint: 'Spells Q W E R D F, items 1 to 6' },
  { value: 'classic', label: 'Classic', hint: 'Spells D R T E C Y, items 1 to 6, as in the original' },
]

/**
 * Preset secondaries. Shop on P everywhere (League's shop key; no preset uses P), so Mac
 * players never need Fn for F4.
 */
const NO_KEYS = Object.fromEntries(Object.keys(PRESETS.dota).map((k) => [k, ''])) as BindMap
export const PRESETS_ALT: Record<KeyPreset, BindMap> = {
  dota: { ...NO_KEYS, shop: 'KeyP' },
  modern: { ...NO_KEYS, shop: 'KeyP' },
  classic: { ...NO_KEYS, shop: 'KeyP' },
}

/** Keys that stay fixed: Esc opens the menu, F2 the perf overlay, F3 the net graph; F5 / F11 / F12 belong to the browser. */
export const RESERVED_KEYS = new Set(['Escape', 'F2', 'F3', 'F5', 'F11', 'F12', 'MetaLeft', 'MetaRight', 'ContextMenu'])

export function resolveBinds(s: Pick<Settings, 'keyPreset' | 'keybinds' | 'keybindsAlt'>): Binds {
  const preset = PRESETS[s.keyPreset] ? s.keyPreset : 'dota'
  const primary = { ...PRESETS[preset] }
  for (const [k, v] of Object.entries(s.keybinds ?? {})) if (k in primary && typeof v === 'string' && v) primary[k as BindAction] = v
  const secondary = { ...PRESETS_ALT[preset] }
  for (const [k, v] of Object.entries(s.keybindsAlt ?? {})) if (k in secondary && typeof v === 'string') secondary[k as BindAction] = v
  // a primary always wins: a default secondary on a key the player already uses elsewhere is dropped,
  // so saved overrides from before secondaries existed keep working unchanged
  const used = new Set(Object.values(primary).filter(Boolean))
  for (const k of Object.keys(secondary) as BindAction[]) {
    const code = secondary[k]
    if (!code) continue
    if (used.has(code)) secondary[k] = ''
    else used.add(code)
  }
  return { primary, secondary }
}

let cacheKey: unknown = null
let cacheVal: Binds = { primary: PRESETS.dota, secondary: PRESETS_ALT.dota }
/** Current bindings from the store (cached on the settings object). */
export function currentBinds(): Binds {
  const s = useGame.getState().settings
  if (s !== cacheKey) {
    cacheKey = s
    cacheVal = resolveBinds(s)
  }
  return cacheVal
}

/** React: current bindings, re-rendering only when preset or overrides change. */
export function useBinds(): Binds {
  const preset = useGame((s) => s.settings.keyPreset)
  const keybinds = useGame((s) => s.settings.keybinds)
  const keybindsAlt = useGame((s) => s.settings.keybindsAlt)
  return useMemo(() => resolveBinds({ keyPreset: preset, keybinds, keybindsAlt }), [preset, keybinds, keybindsAlt])
}

export function actionForCode(binds: Binds, code: string): BindAction | null {
  const c = code.startsWith('Numpad') && /\d$/.test(code) ? 'Digit' + code.slice(6) : code
  for (const k in binds.primary) if (binds.primary[k as BindAction] === c) return k as BindAction
  for (const k in binds.secondary) if (binds.secondary[k as BindAction] === c) return k as BindAction
  return null
}

/** "F4 / P", or just the primary when there is no secondary (or `short`). */
export function bindLabel(binds: Binds, action: BindAction, short = false): string {
  const a = keyLabel(binds.primary[action])
  const b = keyLabel(binds.secondary[action])
  if (short || !b) return a || b
  return a ? `${a} / ${b}` : b
}

export function slotAction(slot: number): BindAction {
  return (slot < 6 ? `spell${slot}` : `item${slot - 6}`) as BindAction
}

/** 'KeyQ' -> 'Q', 'Digit1' -> '1', 'Space' -> 'Space' */
export function keyLabel(code: string | undefined): string {
  if (!code) return ''
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6)
  if (code.startsWith('Arrow')) return code.slice(5)
  const named: Record<string, string> = {
    Escape: 'Esc',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backslash: '\\',
    ShiftLeft: 'Shift',
    ShiftRight: 'R Shift',
    ControlLeft: 'Ctrl',
    ControlRight: 'R Ctrl',
    AltLeft: 'Alt',
    AltRight: 'R Alt',
    CapsLock: 'Caps',
  }
  return named[code] ?? code
}

/** Hotkey label for slot 0..11 (primary key; secondaries only where space allows). */
export function slotKeyLabel(binds: Binds, slot: number): string {
  const a = slotAction(slot)
  return keyLabel(binds.primary[a] || binds.secondary[a])
}

/** True when the event target is a text-entry control (keys belong to it). */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable) return true
  const tag = t.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type
    return type !== 'range' && type !== 'checkbox' && type !== 'button'
  }
  return false
}
