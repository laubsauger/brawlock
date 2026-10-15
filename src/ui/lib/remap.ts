/**
 * Key remapping shared by the HUD bar, the shop and Settings > Controls.
 * UI-only: it changes which key casts which slot (settings.keybinds /
 * keybindsAlt); sim slot indices never change, so online play is unaffected.
 * The last change can be undone (Ctrl/Cmd+Z).
 */
import { useGame } from '../../game/store'
import { ACTION_LABEL, PRESETS, PRESETS_ALT, RESERVED_KEYS, keyLabel, resolveBinds, slotAction, type BindAction, type Binds } from './keys'
import { toast } from './toast'

type Which = 'primary' | 'secondary'

let lastSnapshot: { keybinds: Record<string, string>; keybindsAlt: Record<string, string> } | null = null

function current(): Binds {
  return resolveBinds(useGame.getState().settings)
}

function snapshot(): void {
  const s = useGame.getState().settings
  lastSnapshot = { keybinds: { ...(s.keybinds as Record<string, string>) }, keybindsAlt: { ...(s.keybindsAlt as Record<string, string>) } }
}

/** Store only what differs from the preset, so preset updates still reach the player. */
export function saveBinds(next: Binds): void {
  const preset = useGame.getState().settings.keyPreset
  const base = PRESETS[preset]
  const baseAlt = PRESETS_ALT[preset]
  const p: Record<string, string> = {}
  const s: Record<string, string> = {}
  for (const k of Object.keys(next.primary) as BindAction[]) if (next.primary[k] !== base[k]) p[k] = next.primary[k]
  for (const k of Object.keys(next.secondary) as BindAction[]) if (next.secondary[k] !== baseAlt[k]) s[k] = next.secondary[k]
  useGame.getState().setSettings({ keybinds: p, keybindsAlt: s })
}

/** Spell columns (0..5) and items (6..11) are separate groups; swaps stay inside one. */
export function sameGroup(a: number, b: number): boolean {
  return a !== b && a >= 0 && b >= 0 && a < 12 && b < 12 && a < 6 === b < 6
}

function slotName(slot: number): string {
  return slot < 6 ? `column ${slot + 1}` : `item ${slot - 5}`
}

/** Swap both keys of two slots. Returns false for slots in different groups. */
export function swapSlots(a: number, b: number): boolean {
  if (!sameGroup(a, b)) return false
  const cur = current()
  const next = { primary: { ...cur.primary }, secondary: { ...cur.secondary } }
  const A = slotAction(a)
  const B = slotAction(b)
  ;[next.primary[A], next.primary[B]] = [next.primary[B], next.primary[A]]
  ;[next.secondary[A], next.secondary[B]] = [next.secondary[B], next.secondary[A]]
  snapshot()
  saveBinds(next)
  toast(`${keyLabel(next.primary[A])} now casts ${slotName(a)}, ${keyLabel(next.primary[B])} casts ${slotName(b)}. Ctrl+Z undoes.`)
  return true
}

/**
 * Put `code` on one action's main or second key. A key already in use moves
 * here: the other action takes this cell's old key, or loses that key if this
 * cell was empty (a main key falls back to its second key when it has one).
 */
export function assignKey(action: BindAction, which: Which, code: string): { ok: boolean; note: string | null } {
  if (RESERVED_KEYS.has(code)) return { ok: false, note: `${keyLabel(code)} is reserved. Pick another key.` }
  const cur = current()
  const next = { primary: { ...cur.primary }, secondary: { ...cur.secondary } }
  const slotName = (a: BindAction, w: Which) => `${ACTION_LABEL[a]}${w === 'secondary' ? ' (second key)' : ''}`
  const old = next[which][action]
  const other: Which = which === 'primary' ? 'secondary' : 'primary'
  snapshot()
  if (next[other][action] === code) {
    next[other][action] = old
    next[which][action] = code
    saveBinds(next)
    return { ok: true, note: null }
  }
  let clash: { a: BindAction; w: Which } | null = null
  for (const w of ['primary', 'secondary'] as Which[]) {
    for (const a of Object.keys(next[w]) as BindAction[]) if (next[w][a] === code && !(a === action && w === which)) clash = { a, w }
  }
  next[which][action] = code
  let note: string | null = null
  if (clash) {
    if (old) {
      next[clash.w][clash.a] = old
      note = `${keyLabel(code)} was on ${slotName(clash.a, clash.w)}; that now uses ${keyLabel(old)}.`
    } else if (clash.w === 'primary' && next.secondary[clash.a]) {
      next.primary[clash.a] = next.secondary[clash.a]
      next.secondary[clash.a] = ''
      note = `${keyLabel(code)} moved here; ${ACTION_LABEL[clash.a]} now uses ${keyLabel(next.primary[clash.a])}.`
    } else {
      next[clash.w][clash.a] = ''
      note = `${keyLabel(code)} moved here; ${slotName(clash.a, clash.w)} has no key now.`
    }
  }
  saveBinds(next)
  return { ok: true, note }
}

/** Clear a second key. */
export function clearSecondary(action: BindAction): void {
  const cur = current()
  snapshot()
  saveBinds({ primary: cur.primary, secondary: { ...cur.secondary, [action]: '' } })
}

/** Spell and item keys back to the preset; other keys stay as the player set them. */
export function resetSlotLayout(): void {
  const s = useGame.getState().settings
  snapshot()
  const strip = (m: Partial<Record<string, string>>) => Object.fromEntries(Object.entries(m).filter(([k]) => !/^(spell|item)\d$/.test(k)))
  useGame.getState().setSettings({ keybinds: strip(s.keybinds), keybindsAlt: strip(s.keybindsAlt) })
  toast('Spell and item keys are back to the preset. Ctrl+Z undoes.')
}

/** True when any spell or item key differs from the preset. */
export function slotLayoutCustom(): boolean {
  const s = useGame.getState().settings
  return [...Object.keys(s.keybinds ?? {}), ...Object.keys(s.keybindsAlt ?? {})].some((k) => /^(spell|item)\d$/.test(k))
}

/** Undo the last key change. */
export function undoRemap(): boolean {
  if (!lastSnapshot) return false
  const snap = lastSnapshot
  lastSnapshot = null
  useGame.getState().setSettings({ keybinds: snap.keybinds, keybindsAlt: snap.keybindsAlt })
  toast('Key change undone.')
  return true
}
