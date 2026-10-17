/**
 * Input contract: maps keyboard / mouse to InputCommands for the local player.
 * Owned by the UI workstream (keybinds live in settings). The session drains
 * it once per sim tick, and may subscribe with onCommand() to send each
 * command the instant it is issued (lossless animation canceling).
 *
 * Mapping (bindings: src/ui/lib/keys.ts, presets Dota / Modern / Classic):
 * - right mouse button: move to the ground point under the cursor. Every
 *   press sends a move (spam-clicking is fine); holding re-issues it as the
 *   cursor travels, throttled.
 * - spell / item keys: cast slot 0..11 by cast mode (settings.castMode, per
 *   slot override in settings.castModeSlots), as in Dota:
 *     quick   - cast at the cursor on key down
 *     release - hold to aim (inputViz.aim drives the range ring), cast on key up
 *     normal  - key enters targeting; left click casts, right click / Esc cancels
 *   Spells without a target point (Scourge) always cast at once.
 * - stop / hold: 'stop' at once, also cancels any aiming
 * - "Move cancels cast" (settings.moveCancelsCast, default on = original): when
 *   off, a move issued while your warlock winds up a cast is held here, not
 *   sent; the latest held move goes out the moment the windup ends (fired or
 *   cancelled). Client-side only: the sim and the protocol are unchanged, and
 *   both net modes read the same queue.
 * - recenter (Space), scoreboard (hold), shop, character sheet, Esc menu
 * Keys are ignored while typing in a text field, while the in-match menu or
 * settings are open, and when Ctrl / Cmd / Alt is held (browser shortcuts).
 */
import type { InputCommand } from '../sim/types'
import { attr, masteryFactor, spellDef } from '../sim'
import { frame } from './frame'
import { useGame, type CastMode } from './store'
import { actionForCode, currentBinds, isTypingTarget, type BindAction } from '../ui/lib/keys'

export interface AttachOptions {
  /** Space: snap the camera back to the local warlock (render workstream). */
  recenter?: () => void
}

export interface InputApi {
  /** Attach listeners to the game viewport element. Returns a detach function. */
  attach(el: HTMLElement, opts?: AttachOptions): () => void
  /** Queue a command from UI (shop buttons etc.). */
  issue(cmd: InputCommand): void
  /** Commands issued since the last drain, in order. */
  drain(): InputCommand[]
  /**
   * Called synchronously for every queued command, so the session can send it
   * without waiting for the next tick. The command also stays queued for drain().
   */
  onCommand(cb: (cmd: InputCommand) => void): () => void
}

/**
 * Input feedback for render (read every frame, never React state):
 * - move: last move order (game units), performance.now() when issued, seq += 1 per order
 * - aim: an aim in progress (quick-cast-on-release held, or normal-cast targeting),
 *   with the spell's range in game units for the range ring; null when not aiming
 */
export interface InputViz {
  move: { x: number; y: number; at: number; seq: number }
  aim: { slot: number; spell: string; range: number; mode: 'release' | 'normal' } | null
}

export const inputViz: InputViz = {
  move: { x: 0, y: 0, at: -1, seq: 0 },
  aim: null,
}

const queue: InputCommand[] = []
const listeners = new Set<(cmd: InputCommand) => void>()

function push(cmd: InputCommand): void {
  if (cmd.kind === 'cast') notePendingCast(cmd.slot)
  queue.push(cmd)
  for (const cb of listeners) {
    try {
      cb(cmd)
    } catch (e) {
      console.error('[input] onCommand listener failed', e)
    }
  }
}

/** Move held back during a cast windup (moveCancelsCast off): only the latest counts. */
let heldMove: { x: number; y: number } | null = null

/**
 * A cast just sent that the state does not show yet (the sim runs it next
 * tick; a client sees it a round trip later): moves wait for it too, until it
 * appears and ends, or this deadline passes (the cast was refused).
 */
let pendingCast: { until: number; seen: boolean } | null = null

function notePendingCast(slot: number): void {
  const s = frame.curr
  const pawn = s?.pawns.find((p) => p.owner === frame.localPlayer)
  const id = pawn?.slots[slot]
  const def = id ? spellDef(id) : undefined
  // nothing to wait for: empty slot, on cooldown, or an instant spell (no windup)
  if (!pawn || !def || (pawn.cooldowns[slot] ?? 0) > 0 || def.immediate || def.castPoint <= 0) return
  const rtt = Math.max(0, frame.net.rttMs || 0)
  pendingCast = { until: performance.now() + def.castPoint * 1000 + rtt + 250, seen: false }
}

/** The local warlock is winding up a cast (turning to face, or counting down the cast point), or one is on its way. */
function localWindup(now = performance.now()): boolean {
  const s = frame.curr
  const pawn = s?.pawns.find((p) => p.owner === frame.localPlayer)
  if (!pawn?.alive) {
    pendingCast = null
    return false
  }
  if (pawn.cast) {
    if (pendingCast) pendingCast.seen = true
    return true
  }
  // the cast showed up and is over, or never came in time
  if (pendingCast && (pendingCast.seen || now >= pendingCast.until)) pendingCast = null
  return !!pendingCast
}

function movesCancelCasts(): boolean {
  return useGame.getState().settings.moveCancelsCast ?? true
}

/**
 * A move order for the local warlock. Shows on the move marker at once; goes
 * out now, or (moveCancelsCast off, during a windup) as soon as the windup ends.
 */
export function requestMove(x: number, y: number, now = performance.now()): void {
  const m = inputViz.move
  m.x = x
  m.y = y
  m.at = now
  m.seq++
  if (!movesCancelCasts() && localWindup()) {
    heldMove = { x, y }
    return
  }
  heldMove = null
  push({ kind: 'move', x, y })
}

/** The held move, once the windup is over (called whenever the session drains). */
function releaseHeldMove(): void {
  if (!heldMove) return
  if (movesCancelCasts() || !localWindup()) {
    const { x, y } = heldMove
    heldMove = null
    push({ kind: 'move', x, y })
  }
}

/** Last ground point the cursor was valid on; casts fall back to it. */
const lastAim = { x: 0, y: 0, has: false }

function aimPoint(): { x: number; y: number } | null {
  const c = frame.cursor
  if (c.valid) {
    lastAim.x = c.x
    lastAim.y = c.y
    lastAim.has = true
    return { x: c.x, y: c.y }
  }
  return lastAim.has ? { x: lastAim.x, y: lastAim.y } : null
}

/** In-match menu or settings modal is up: gameplay keys are inert. */
function menusBlock(): boolean {
  const s = useGame.getState()
  return s.paused || s.settingsOpen
}

function localSlot(slot: number): { spell: string | null; level: number } {
  const s = frame.curr
  const pawn = s?.pawns.find((p) => p.owner === frame.localPlayer)
  return { spell: pawn?.slots[slot] ?? null, level: pawn?.levels[slot] ?? 0 }
}

/** Range ring radius for a slot: KV range (Range mastery for projectiles), or the AoE radius. */
function slotRange(spell: string, level: number): number {
  const def = spellDef(spell)
  if (!def) return 0
  const range = attr(def, 'range', level)
  if (range > 0) {
    if (spell === 'teleport') return range // no Range mastery (spells.md §8.9)
    const s = frame.curr
    const lvl = s?.scores.find((x) => x.id === frame.localPlayer)?.masteries.range ?? 0
    return range * masteryFactor('range', lvl)
  }
  return attr(def, 'radius', level)
}

function castModeFor(slot: number, spell: string | null): CastMode {
  if (spell && spellDef(spell)?.target === 'none') return 'quick'
  const s = useGame.getState().settings
  return s.castModeSlots?.[slot] ?? s.castMode ?? 'quick'
}

function slotOf(action: BindAction): number {
  if (action.startsWith('spell')) return Number(action.slice(5))
  if (action.startsWith('item')) return 6 + Number(action.slice(4))
  return -1
}

/** Held right button re-issues moves at most this often, and only after this much travel. */
const HOLD_MOVE_MS = 90
const HOLD_MOVE_MIN_DIST = 24

export const input: InputApi = {
  attach(el, opts = {}) {
    let rightHeld = false
    let lastMoveAt = 0
    let lastMoveX = 0
    let lastMoveY = 0
    let holdTimer = 0
    /** release-mode aim: the key code being held */
    let releaseCode: string | null = null

    const setAim = (slot: number, mode: 'release' | 'normal') => {
      const { spell, level } = localSlot(slot)
      inputViz.aim = { slot, spell: spell ?? '', range: spell ? slotRange(spell, level) : 0, mode }
      el.dataset.targeting = mode
    }
    const clearAim = () => {
      inputViz.aim = null
      releaseCode = null
      delete el.dataset.targeting
    }
    const cast = (slot: number) => {
      const p = aimPoint()
      if (p) push({ kind: 'cast', slot, x: p.x, y: p.y })
    }

    const issueMove = (force: boolean) => {
      const c = frame.cursor
      if (!c.valid) return
      const now = performance.now()
      if (!force) {
        if (now - lastMoveAt < HOLD_MOVE_MS) return
        const dx = c.x - lastMoveX
        const dy = c.y - lastMoveY
        if (dx * dx + dy * dy < HOLD_MOVE_MIN_DIST * HOLD_MOVE_MIN_DIST) return
      }
      lastMoveAt = now
      lastMoveX = c.x
      lastMoveY = c.y
      lastAim.x = c.x
      lastAim.y = c.y
      lastAim.has = true
      requestMove(c.x, c.y, now)
    }

    const stopHold = () => {
      rightHeld = false
      if (holdTimer) {
        window.clearInterval(holdTimer)
        holdTimer = 0
      }
    }

    const onContextMenu = (e: Event) => e.preventDefault()

    const onPointerDown = (e: PointerEvent) => {
      if (menusBlock()) return
      if (e.button === 0) {
        // normal cast: left click confirms the target
        if (inputViz.aim?.mode === 'normal') {
          e.preventDefault()
          const slot = inputViz.aim.slot
          clearAim()
          cast(slot)
        }
        return
      }
      if (e.button !== 2) return
      e.preventDefault()
      // right click cancels targeting (as in Dota) instead of moving
      if (inputViz.aim?.mode === 'normal') {
        clearAim()
        return
      }
      issueMove(true)
      rightHeld = true
      if (!holdTimer) holdTimer = window.setInterval(() => rightHeld && issueMove(false), HOLD_MOVE_MS)
    }

    const onPointerUp = (e: PointerEvent) => {
      if (e.button === 2) stopHold()
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (isTypingTarget(e.target)) return
      const store = useGame.getState()
      const code = e.code

      if (code === 'Escape') {
        e.preventDefault()
        if (inputViz.aim) clearAim()
        else if (store.settingsOpen) store.toggle('settingsOpen', false)
        else if (store.paused) store.toggle('paused', false)
        else if (store.shopOpen) store.toggle('shopOpen', false)
        else if (store.characterOpen) store.toggle('characterOpen', false)
        else store.toggle('paused', true)
        return
      }
      if (menusBlock()) return

      const action = actionForCode(currentBinds(), code)
      if (!action) return

      if (action === 'scoreboard') {
        // hold to show; never let Tab move focus around the page
        e.preventDefault()
        if (!store.scoreboardOpen) store.toggle('scoreboardOpen', true)
        return
      }
      if (action === 'mute') return // handled globally (App), works outside matches too
      e.preventDefault()
      if (e.repeat) return

      const slot = slotOf(action)
      if (slot >= 0) {
        const { spell } = localSlot(slot)
        const mode = castModeFor(slot, spell)
        if (mode === 'quick' || !spell) {
          if (inputViz.aim) clearAim()
          cast(slot)
        } else if (mode === 'release') {
          releaseCode = code
          setAim(slot, 'release')
        } else {
          setAim(slot, 'normal')
        }
        return
      }
      switch (action) {
        case 'stop':
        case 'hold':
          clearAim()
          // stop wins over a move waiting for the windup
          heldMove = null
          pendingCast = null
          push({ kind: 'stop' })
          break
        case 'recenter':
          opts.recenter?.()
          break
        case 'shop':
          store.toggle('shopOpen')
          break
        case 'character':
          store.toggle('characterOpen')
          break
      }
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (releaseCode && e.code === releaseCode) {
        const slot = inputViz.aim?.slot
        clearAim()
        if (slot != null && !menusBlock()) cast(slot)
        return
      }
      if (actionForCode(currentBinds(), e.code) === 'scoreboard') useGame.getState().toggle('scoreboardOpen', false)
    }

    const onBlur = () => {
      stopHold()
      clearAim()
      useGame.getState().toggle('scoreboardOpen', false)
    }

    el.addEventListener('contextmenu', onContextMenu)
    el.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)

    return () => {
      stopHold()
      clearAim()
      heldMove = null
      pendingCast = null
      el.removeEventListener('contextmenu', onContextMenu)
      el.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  },
  issue(cmd) {
    if (cmd.kind === 'stop') {
      heldMove = null
      pendingCast = null
    }
    push(cmd)
  },
  drain() {
    // once per sim tick: a move held for a windup goes out the tick the windup ends
    releaseHeldMove()
    return queue.splice(0, queue.length)
  },
  onCommand(cb) {
    listeners.add(cb)
    return () => listeners.delete(cb)
  },
}
