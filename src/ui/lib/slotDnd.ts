/**
 * Drag a slot onto any other slot (spell columns 0..5 and items 6..11 mix
 * freely: Fireball on Q is fine) to swap their keys; used by the HUD bar, the
 * shop's owned tiles and Settings > Controls. A drop that cannot apply shakes
 * and says why. Keyboard / click alternative: select a slot,
 * then press the key it should use (startSlotCapture).
 */
import type { HTMLAttributes, PointerEvent as ReactPointerEvent } from 'react'
import { keyLabel, slotAction } from './keys'
import { assignKey, canSwap, slotName, swapSlots } from './remap'
import { pop } from './motion'
import { toast } from './toast'
import { sfx } from './sound'

/*
 * Pointer Events drag, not HTML5 drag-and-drop: native DnD was unreliable in
 * WebKit (Safari) for normal-speed drags. pointerdown arms, moving past a few
 * pixels starts the drag with a floating ghost, pointerup hit-tests the element
 * under the pointer ([data-drop-slot]). A plain click (no movement) still
 * reaches onClick (click-to-rebind in the HUD, buy in the shop).
 */
interface DragState {
  slot: number
  el: HTMLElement
  pointerId: number
  x0: number
  y0: number
  dragging: boolean
  ghost: HTMLElement | null
  over: HTMLElement | null
}
let drag: DragState | null = null
let swallowClickUntil = 0

// the click that ends a drag must not buy / start a rebind
if (typeof window !== 'undefined') {
  window.addEventListener(
    'click',
    (e) => {
      if (performance.now() < swallowClickUntil) {
        e.stopPropagation()
        e.preventDefault()
      }
    },
    true,
  )
}

function shake(el: HTMLElement | null): void {
  if (!el) return
  el.dataset.shake = 'false'
  void el.offsetWidth
  el.dataset.shake = 'true'
  window.setTimeout(() => delete el.dataset.shake, 400)
}

function targetAt(x: number, y: number): HTMLElement | null {
  const hit = document.elementFromPoint(x, y)
  return (hit?.closest('[data-drop-slot]') as HTMLElement | null) ?? null
}

function setOver(d: DragState, el: HTMLElement | null): void {
  if (d.over === el) return
  if (d.over) delete d.over.dataset.drop
  d.over = el
  if (el) el.dataset.drop = 'true'
}

function makeGhost(d: DragState, x: number, y: number): HTMLElement {
  const icon = d.el.querySelector<HTMLElement>('img, svg') ?? d.el
  const r = icon.getBoundingClientRect()
  const ghost = document.createElement('div')
  ghost.className = 'slot-ghost'
  ghost.style.width = `${r.width}px`
  ghost.style.height = `${r.height}px`
  ghost.appendChild(icon.cloneNode(true))
  ghost.style.left = `${x}px`
  ghost.style.top = `${y}px`
  document.body.appendChild(ghost)
  return ghost
}

function endGhost(ghost: HTMLElement | null, toEl: HTMLElement | null, accepted: boolean): void {
  if (!ghost) return
  const r = toEl?.getBoundingClientRect()
  if (r) {
    ghost.style.transition = 'left 0.18s ease, top 0.18s ease, opacity 0.18s ease, transform 0.18s ease'
    ghost.style.left = `${r.left + r.width / 2}px`
    ghost.style.top = `${r.top + r.height / 2}px`
    ghost.style.transform = `translate(-50%, -50%) scale(${accepted ? 0.9 : 1})`
    ghost.style.opacity = '0'
    window.setTimeout(() => ghost.remove(), 200)
  } else ghost.remove()
}

function onMove(e: PointerEvent): void {
  const d = drag
  if (!d || e.pointerId !== d.pointerId) return
  if (!d.dragging) {
    const dx = e.clientX - d.x0
    const dy = e.clientY - d.y0
    if (dx * dx + dy * dy < 25) return
    d.dragging = true
    try {
      d.el.setPointerCapture(d.pointerId)
    } catch {
      /* element gone */
    }
    d.el.dataset.dragging = 'true'
    document.body.dataset.slotDrag = 'true'
    d.ghost = makeGhost(d, e.clientX, e.clientY)
  }
  e.preventDefault()
  if (d.ghost) {
    d.ghost.style.left = `${e.clientX}px`
    d.ghost.style.top = `${e.clientY}px`
  }
  const t = targetAt(e.clientX, e.clientY)
  setOver(d, t && Number(t.dataset.dropSlot) !== d.slot ? t : null)
}

function stopListening(): void {
  window.removeEventListener('pointermove', onMove, true)
  window.removeEventListener('pointerup', onUp, true)
  window.removeEventListener('pointercancel', onCancel, true)
}

function finish(d: DragState): void {
  setOver(d, null)
  delete d.el.dataset.dragging
  delete document.body.dataset.slotDrag
  try {
    d.el.releasePointerCapture(d.pointerId)
  } catch {
    /* not captured */
  }
}

function onUp(e: PointerEvent): void {
  const d = drag
  if (!d || e.pointerId !== d.pointerId) return
  drag = null
  stopListening()
  if (!d.dragging) return // a plain click: onClick handles it
  e.preventDefault()
  swallowClickUntil = performance.now() + 350
  const t = targetAt(e.clientX, e.clientY)
  finish(d)
  const slot = t ? Number(t.dataset.dropSlot) : -1
  if (t && canSwap(d.slot, slot)) {
    swapSlots(d.slot, slot)
    sfx('click')
    endGhost(d.ghost, t, true)
    pop(t, 1.15)
    pop(d.el, 1.15)
    return
  }
  // never a silent no-op: the ghost snaps back, the source shakes, the toast says why
  endGhost(d.ghost, d.el, false)
  sfx('error')
  shake(d.el)
  toast(slot === d.slot ? 'Dropped on the same slot: nothing changed.' : 'Drop it on another spell or item slot to swap their keys.')
}

function onCancel(e: PointerEvent): void {
  const d = drag
  if (!d || e.pointerId !== d.pointerId) return
  drag = null
  stopListening()
  finish(d)
  endGhost(d.ghost, d.el, false)
}

/** Props that make an element a drop target for `slot` (any other slot may land here). */
export function slotDropProps(slot: number): HTMLAttributes<HTMLElement> & { 'data-drop-slot': number } {
  return { 'data-drop-slot': slot }
}

/** Props that make an element draggable as `slot` (and a drop target for it). */
export function slotDragProps(slot: number, enabled = true): HTMLAttributes<HTMLElement> & { 'data-drop-slot': number } {
  const drop = slotDropProps(slot)
  if (!enabled) return drop
  return {
    ...drop,
    // @ts-expect-error data attribute for the touch-action / grab cursor CSS
    'data-drag-slot': slot,
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0 || drag) return
      drag = { slot, el: e.currentTarget, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, dragging: false, ghost: null, over: null }
      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', onUp, true)
      window.addEventListener('pointercancel', onCancel, true)
    },
    // keep the browser's own image / text drag out of the way
    onDragStart: (e) => e.preventDefault(),
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
