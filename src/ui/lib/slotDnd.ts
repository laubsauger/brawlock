/**
 * Drag a slot onto another slot of the same group (spell columns 0..5 or
 * items 6..11) to swap their keys; used by the HUD bar, the shop's owned
 * tiles and Settings > Controls. Keyboard / click alternative: select a slot,
 * then press the key it should use (startSlotCapture).
 */
import type { DragEvent, HTMLAttributes } from 'react'
import { keyLabel, slotAction } from './keys'
import { assignKey, sameGroup, slotName, swapSlots } from './remap'
import { pop } from './motion'
import { toast } from './toast'
import { sfx } from './sound'

let dragSrc: { slot: number; el: HTMLElement } | null = null

const group = (slot: number) => (slot < 6 ? 'spell' : 'item')

/** Props that make an element a drop target for `slot`. */
export function slotDropProps(slot: number): HTMLAttributes<HTMLElement> & { 'data-drop-group': string } {
  return {
    'data-drop-group': group(slot),
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!dragSrc || !sameGroup(dragSrc.slot, slot)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      e.currentTarget.dataset.drop = 'true'
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      delete e.currentTarget.dataset.drop
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault()
      const target = e.currentTarget
      delete target.dataset.drop
      const src = dragSrc
      dragSrc = null
      if (!src || !sameGroup(src.slot, slot)) return
      if (swapSlots(src.slot, slot)) {
        sfx('click')
        pop(target, 1.15)
        pop(src.el, 1.15)
      }
    },
  }
}

/** Props that make an element draggable as `slot` (and a drop target for it). */
export function slotDragProps(slot: number, enabled = true): HTMLAttributes<HTMLElement> & { 'data-drop-group': string } {
  const drop = slotDropProps(slot)
  if (!enabled) return drop
  return {
    ...drop,
    draggable: true,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      const el = e.currentTarget
      dragSrc = { slot, el }
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', `slot:${slot}`)
      // the painted icon follows the cursor as the ghost
      const icon = el.querySelector<HTMLElement>('img, svg')
      if (icon) {
        const r = icon.getBoundingClientRect()
        e.dataTransfer.setDragImage(icon, r.width / 2, r.height / 2)
      }
      el.dataset.dragging = 'true'
      document.body.dataset.slotDrag = group(slot)
    },
    onDragEnd: (e: DragEvent<HTMLElement>) => {
      delete e.currentTarget.dataset.dragging
      delete document.body.dataset.slotDrag
      dragSrc = null
    },
  }
}

let capture: { el: HTMLElement; stop: () => void } | null = null

/**
 * Click / keyboard alternative to dragging: the slot waits for a key, which
 * becomes its main key (a key used elsewhere moves here, as in Settings).
 * Esc or a click elsewhere cancels.
 */
export function startSlotCapture(slot: number, el: HTMLElement): void {
  capture?.stop()
  const action = slotAction(slot)
  el.dataset.capture = 'true'
  toast(`Press the key for ${slotName(slot)}. Esc cancels.`)
  const onKey = (e: KeyboardEvent) => {
    e.preventDefault()
    e.stopImmediatePropagation()
    if (e.code === 'Escape') {
      stop()
      toast('Key change cancelled.')
      return
    }
    const r = assignKey(action, 'primary', e.code)
    if (!r.ok) {
      sfx('error')
      toast(r.note ?? 'That key cannot be used.')
      return
    }
    sfx('click')
    toast(r.note ?? `${keyLabel(e.code)} now casts ${slotName(slot)}. Ctrl+Z undoes.`)
    pop(el, 1.15)
    stop()
  }
  const onDown = (e: PointerEvent) => {
    if (!el.contains(e.target as Node)) stop()
  }
  function stop() {
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('pointerdown', onDown, true)
    delete el.dataset.capture
    capture = null
  }
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('pointerdown', onDown, true)
  capture = { el, stop }
}
