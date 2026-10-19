import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { frame } from './frame'
import { useGame } from './store'
import { usePractice } from './practiceState'
import { startPractice, stopPractice } from './practice'
import type { InputCommand } from '../sim'

const fake = vi.hoisted(() => ({ pulse: null as ((at: number) => void) | null, stop: vi.fn(), cmds: [] as InputCommand[], audio: vi.fn() }))
vi.mock('../net/clock', () => ({ startClock: (pulse: (at: number) => void) => { fake.pulse = pulse; return fake.stop } }))
vi.mock('../audio', () => ({ audio: { playEvents: fake.audio } }))
vi.mock('./input', () => ({ input: { drain: () => fake.cmds.splice(0) } }))

beforeEach(() => {
  vi.stubGlobal('document', { visibilityState: 'visible' })
  vi.spyOn(performance, 'now').mockReturnValue(0)
  fake.stop.mockClear(); fake.audio.mockClear(); fake.cmds = []
  useGame.getState().toggle('paused', false)
  useGame.getState().toggle('settingsOpen', false)
})
afterEach(() => { stopPractice(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('offline practice lifecycle', () => {
  it('uses live frames and input, pauses without catching up, and tears down its clock on exit', () => {
    startPractice({ name: 'Learner', color: null }, () => true)
    expect(useGame.getState().screen).toBe('match')
    expect(useGame.getState().lobby).toMatchObject({ role: 'offline', roomCode: null })
    expect(frame.localPlayer).toBe(0)
    expect(usePractice.getState().view?.step).toBe('move')
    fake.cmds.push({ kind: 'move', x: -300, y: 180 })
    fake.pulse!(100)
    const tick = frame.curr!.tick
    useGame.getState().toggle('paused', true)
    fake.pulse!(10000)
    expect(frame.curr!.tick).toBe(tick)
    useGame.getState().toggle('paused', false)
    fake.pulse!(10020)
    expect(frame.curr!.tick - tick).toBeLessThan(3)
    useGame.getState().setScreen('menu')
    expect(fake.stop).toHaveBeenCalledOnce()
    expect(usePractice.getState().view).toBeNull()
    expect(frame.curr).toBeNull()
  })
  it('stops the previous lesson before starting another and clears queued input', () => {
    startPractice({ name: 'First', color: null }, () => true)
    fake.cmds.push({ kind: 'move', x: 999, y: 999 })
    startPractice({ name: 'Again', color: null }, () => true)
    expect(fake.stop).toHaveBeenCalledOnce()
    expect(fake.cmds).toEqual([])
    expect(frame.curr?.slots[0].name).toBe('Again')
    expect(frame.curr?.pawns[0].moveTarget).toBeNull()
  })
})
