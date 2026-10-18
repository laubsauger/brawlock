import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { frame } from './frame'
import { input, inputViz, inspectClick, requestMove } from './input'
import { useGame } from './store'
import type { SimState } from '../sim/types'

/** The local warlock (player 0) with Fireball in slot 6, optionally winding up a cast. */
function setLocal(casting: boolean) {
  const cast = casting ? { slot: 6, spell: 'fireball', ticksLeft: 8, x: 100, y: 0, started: true } : null
  frame.localPlayer = 0
  frame.curr = {
    pawns: [{ owner: 0, alive: true, cast, slots: [null, null, null, null, null, null, 'fireball', null, null, null, null, null], cooldowns: Array(12).fill(0) }],
  } as unknown as SimState
}

const moves = () => input.drain().filter((c) => c.kind === 'move')

describe('Move cancels cast, off: a move during the windup waits for the spell', () => {
  beforeEach(() => {
    useGame.getState().setSettings({ moveCancelsCast: false })
    input.drain()
  })
  afterEach(() => {
    useGame.getState().setSettings({ moveCancelsCast: true })
    frame.curr = null
    input.drain()
  })

  it('sends nothing while winding up, then exactly the latest move once the windup ends', () => {
    setLocal(true)
    requestMove(100, 0)
    requestMove(200, 50)
    expect(moves()).toEqual([])
    // the marker still shows the order was taken
    expect([inputViz.move.x, inputViz.move.y]).toEqual([200, 50])
    setLocal(false)
    expect(moves()).toEqual([{ kind: 'move', x: 200, y: 50 }])
    expect(moves()).toEqual([])
  })

  it('lets Stop cancel at once and drops the held move', () => {
    setLocal(true)
    requestMove(100, 0)
    input.issue({ kind: 'stop' })
    expect(input.drain()).toEqual([{ kind: 'stop' }])
    setLocal(false)
    expect(moves()).toEqual([])
  })

  it('also holds a move right after pressing a cast the state does not show yet', () => {
    setLocal(false)
    input.issue({ kind: 'cast', slot: 6, x: 100, y: 0 })
    requestMove(300, 0)
    expect(moves()).toEqual([])
    setLocal(true) // the sim started the windup
    expect(moves()).toEqual([])
    setLocal(false) // the fireball went off
    expect(moves()).toEqual([{ kind: 'move', x: 300, y: 0 }])
  })

  it('moves at once when no cast is going on', () => {
    setLocal(false)
    requestMove(100, 0)
    expect(moves()).toEqual([{ kind: 'move', x: 100, y: 0 }])
  })
})

describe('Move cancels cast, on (default, as in the original): unchanged', () => {
  afterEach(() => {
    frame.curr = null
    input.drain()
  })

  it('sends the move during a windup immediately, so it cancels the cast', () => {
    useGame.getState().setSettings({ moveCancelsCast: true })
    setLocal(true)
    requestMove(100, 0)
    expect(moves()).toEqual([{ kind: 'move', x: 100, y: 0 }])
  })
})

describe('camera peek: held while the key or the middle button is down, never stuck', () => {
  // a minimal DOM for attach(): window / element event targets, no real browser needed
  const win = new EventTarget() as EventTarget & Record<string, unknown>
  win.setInterval = setInterval
  win.clearInterval = clearInterval
  const g = globalThis as Record<string, unknown>
  let el: EventTarget & { dataset: Record<string, string> }
  let detach: () => void = () => {}
  const fire = (target: EventTarget, type: string, props: Record<string, unknown>) =>
    target.dispatchEvent(Object.assign(new Event(type), { preventDefault() {}, ...props }))

  beforeEach(() => {
    g.window = win
    g.HTMLElement ??= class {}
    el = Object.assign(new EventTarget(), { dataset: {} as Record<string, string> })
    useGame.getState().setSettings({ keyPreset: 'brawlock', keybinds: {}, keybindsAlt: {} })
    useGame.getState().toggle('paused', false)
    useGame.getState().toggle('settingsOpen', false)
    detach = input.attach(el as unknown as HTMLElement)
  })
  afterEach(() => {
    detach()
    useGame.getState().toggle('paused', false)
  })

  it('peeks while A is held and stops on release', () => {
    fire(win, 'keydown', { code: 'KeyA' })
    expect(inputViz.peek).toBe(true)
    fire(win, 'keyup', { code: 'KeyA' })
    expect(inputViz.peek).toBe(false)
  })

  it('peeks while the middle mouse button is held', () => {
    fire(el, 'pointerdown', { button: 1 })
    expect(inputViz.peek).toBe(true)
    fire(win, 'pointerup', { button: 1 })
    expect(inputViz.peek).toBe(false)
  })

  it('lets go when the window loses focus (the key-up would never arrive)', () => {
    fire(win, 'keydown', { code: 'KeyA' })
    fire(win, 'blur', {})
    expect(inputViz.peek).toBe(false)
  })

  it('lets go when the menu opens', () => {
    fire(el, 'pointerdown', { button: 1 })
    useGame.getState().toggle('paused', true)
    expect(inputViz.peek).toBe(false)
  })
})

describe('left click: inspect a warlock, never in the way of casting', () => {
  const win = new EventTarget() as EventTarget & Record<string, unknown>
  win.setInterval = setInterval
  win.clearInterval = clearInterval
  const g = globalThis as Record<string, unknown>
  let el: EventTarget & { dataset: Record<string, string> }
  let detach: () => void = () => {}
  const fire = (target: EventTarget, type: string, props: Record<string, unknown>) =>
    target.dispatchEvent(Object.assign(new Event(type), { preventDefault() {}, ...props }))
  const pawn = (owner: number, x: number) => ({ id: 100 + owner, owner, x, y: 0, alive: true, cast: null, slots: [null, null, null, null, null, null, 'fireball', null, null, null, null, null], levels: Array(12).fill(1), cooldowns: Array(12).fill(0) })

  beforeEach(async () => {
    const { inspectStore } = await import('./inspect')
    inspectStore.reset()
    g.window = win
    g.HTMLElement ??= class {}
    el = Object.assign(new EventTarget(), { dataset: {} as Record<string, string> })
    useGame.getState().setSettings({ keyPreset: 'brawlock', keybinds: {}, keybindsAlt: {}, castMode: 'normal' })
    frame.localPlayer = 0
    frame.curr = { tick: 1, phase: 'shop', pawns: [pawn(0, 0), pawn(1, 400)], slots: [{ id: 0, team: 0 }, { id: 1, team: 1 }], scores: [], settings: { teamMode: 'ffa' } } as unknown as SimState
    input.drain()
    detach = input.attach(el as unknown as HTMLElement)
  })
  afterEach(() => {
    detach()
    useGame.getState().setSettings({ castMode: 'quick' })
    frame.curr = null
    input.drain()
  })

  it('opens the card of the warlock under the cursor and sends no command', async () => {
    const { inspectStore } = await import('./inspect')
    frame.cursor = { x: 410, y: 10, valid: true }
    fire(el, 'pointerdown', { button: 0, clientX: 0, clientY: 0 })
    expect(inspectStore.get().inspect).toBe(1)
    expect(input.drain()).toEqual([])
  })

  it('in normal-cast targeting, the left click casts and does not inspect, even on a warlock', async () => {
    const { inspectStore } = await import('./inspect')
    fire(win, 'keydown', { code: 'KeyQ' }) // Fireball, normal cast: enter targeting
    expect(inputViz.aim?.mode).toBe('normal')
    frame.cursor = { x: 410, y: 10, valid: true } // right on the other warlock
    fire(el, 'pointerdown', { button: 0, clientX: 0, clientY: 0 })
    expect(input.drain()).toEqual([{ kind: 'cast', slot: 6, x: 410, y: 10 }])
    expect(inspectStore.get().inspect).toBe(-1)
  })

  it('inspects an opponent while fighting without changing the camera, and follows while down', async () => {
    const { inspectStore } = await import('./inspect')
    frame.curr!.phase = 'fight'
    frame.cursor = { x: 410, y: 10, valid: true }
    fire(el, 'pointerdown', { button: 0, clientX: 0, clientY: 0 })
    expect(inspectStore.get().inspect).toBe(1)
    expect(inspectStore.get().follow).toBe(-1)
    frame.curr!.pawns[0].alive = false
    inspectStore.set({ inspect: -1 })
    fire(el, 'pointerdown', { button: 0, clientX: 0, clientY: 0 })
    expect(inspectStore.get().inspect).toBe(1)
    expect(inspectStore.get().follow).toBe(1)
    expect(input.drain()).toEqual([])
  })

  it('inspects combat nameplates even when the ground cursor is invalid', async () => {
    const { inspectStore } = await import('./inspect')
    const originalDocument = g.document
    g.document = { querySelectorAll: () => [{ style: { display: '' }, dataset: { pawn: '101' }, getBoundingClientRect: () => ({ left: 0, top: 0, right: 20, bottom: 20 }) }] }
    try {
      frame.cursor.valid = false // only the nameplate can resolve the target
      frame.curr!.phase = 'fight'
      inspectClick(10, 10)
      expect(inspectStore.get().inspect).toBe(1)
      frame.curr!.phase = 'shop'
      inspectClick(10, 10)
      expect(inspectStore.get().inspect).toBe(-1)
    } finally {
      if (originalDocument === undefined) delete g.document
      else g.document = originalDocument
    }
  })

  it('allows replay inspection without changing spectator camera selection or issuing commands', async () => {
    const { inspectStore } = await import('./inspect')
    frame.localPlayer = -1
    frame.cursor = { x: 410, y: 10, valid: true }
    inspectClick(0, 0, { follow: false })
    expect(inspectStore.get()).toEqual({ inspect: 1, follow: -1 })
    expect(input.drain()).toEqual([])
  })

  it('closes the card on a click on empty ground', async () => {
    const { inspectStore } = await import('./inspect')
    inspectStore.set({ inspect: 1 })
    frame.cursor = { x: 200, y: 300, valid: true }
    fire(el, 'pointerdown', { button: 0, clientX: 0, clientY: 0 })
    expect(inspectStore.get().inspect).toBe(-1)
  })

  it('while down, the right arrow moves on from the warlock on screen (not back to it)', async () => {
    const { inspectStore } = await import('./inspect')
    const s = frame.curr as unknown as { pawns: ReturnType<typeof pawn>[]; slots: { id: number; team: number }[] }
    s.pawns = [{ ...pawn(0, 0), alive: false }, pawn(1, 400), pawn(2, 800)]
    s.slots = [0, 1, 2].map((id) => ({ id, team: id }))
    // automatic follow shows player 1 (first one standing): → must go to 2
    fire(win, 'keydown', { code: 'ArrowRight' })
    expect(inspectStore.get().follow).toBe(2)
    fire(win, 'keydown', { code: 'Space' })
    expect(inspectStore.get().follow).toBe(-1)
    expect(input.drain()).toEqual([])
  })
})
