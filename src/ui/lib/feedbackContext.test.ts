import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eventLog, frame, resetFrame } from '../../game/frame'
import { useGame } from '../../game/store'
import { validFeedbackSubmission, type FeedbackContext } from '../../net/feedback'
import { fight, grant, pawn } from '../../sim/testkit'
import type { SimEvent } from '../../sim/types'

const sources = vi.hoisted(() => ({
  perf: null as Record<string, unknown> | null,
  peers: [] as { rttMs: number | null; lossPct: number | null }[],
}))
vi.mock('../../game/session', () => ({ session: { region: () => ({ id: 'eu', url: 'https://private.example?token=secret' }), transport: () => 'server' } }))
vi.mock('../renderBridge', () => ({ renderPerf: () => sources.perf }))
vi.mock('./netmonitor', () => ({ netState: () => ({ snap: { peers: sources.peers } }) }))
import { captureFeedbackContext } from './feedbackContext'

function valid(context: FeedbackContext): boolean {
  return validFeedbackSubmission({ id: '12345678-1234-4123-8123-123456789abc', kind: 'bug', message: 'A test bug report', context })
}

beforeEach(() => {
  resetFrame()
  useGame.setState(useGame.getInitialState(), true)
  useGame.getState().setScreen('menu')
  vi.stubGlobal('window', { innerWidth: 1366, innerHeight: 768, devicePixelRatio: 1.25 })
  vi.stubGlobal('navigator', { userAgent: 'Browser test', language: 'en-GB', maxTouchPoints: 0, hardwareConcurrency: 8, deviceMemory: 8, onLine: true })
  sources.peers = []
  sources.perf = null
})
afterEach(() => vi.unstubAllGlobals())

describe('feedback context at the click', () => {
  it('copies only explicit settings, rules, own build and numeric telemetry into a detached valid context', () => {
    const state = fight()
    state.tick = 100
    state.slots[0].profileId = 'private-owner-id'
    state.slots[1].profileId = 'private-opponent-id'
    const slot = grant(state, 0, 'lightning', 3)
    state.scores[0].masteries.range = 2
    frame.curr = state
    frame.localPlayer = 0
    useGame.getState().setScreen('match')
    useGame.getState().setSettings({ playerName: 'private-player-name', keybinds: { privateAction: 'SecretKey' } })
    useGame.getState().setLobby({ role: 'client', status: 'open', roomCode: 'ABCDE', ranked: true, quick: true, slots: state.slots, chat: [{ id: 1, player: 1, name: 'Private chat sender', text: 'Private chat content', color: 0 }] })
    sources.perf = { backend: 'webgpu', fps: 60, frameMs: 16.7, drawCalls: 120, triangles: 100000, cpuMs: 3, gpuMs: 2, privateToken: 'private-render-token' }
    sources.peers = [{ rttMs: 20, lossPct: 0 }, { rttMs: 45, lossPct: 2 }]
    const context = captureFeedbackContext('Shop')
    expect(valid(context)).toBe(true)
    expect(context).toMatchObject({ screen: 'match', panel: 'Shop', connection: { transport: 'server', region: 'eu', room: 'ABCDE', rttMs: 45, lossPct: 2, peers: 2 }, render: { backend: 'webgpu', fps: 60, frameMs: 16.7 }, game: { tick: 100, ownBuild: { masteries: { range: 2 } } } })
    const json = JSON.stringify(context)
    expect(json).not.toMatch(/private-|Private chat|SecretKey|cpuMs|gpuMs|keybinds|joinUrl|profileId/)
    pawn(state, 0).levels[slot] = 4
    state.scores[0].masteries.range = 3
    state.settings.startGold = 99
    sources.perf.fps = 20
    sources.peers[1].rttMs = 1000
    expect(JSON.stringify(context)).toBe(json)
    expect(context.game!.ownBuild!.levels[slot]).toBe(3)
  })

  it.each(['menu', 'lobby', 'credits'] as const)('omits stale game/build/events while viewing %s', (screen) => {
    frame.curr = fight()
    frame.localPlayer = 0
    eventLog.push({ tick: 1, events: [{ type: 'cast', pawn: 1, spell: 'fireball', x: 0, y: 0 }] })
    useGame.getState().setScreen(screen)
    const context = captureFeedbackContext()
    expect(context.game).toBeNull()
    expect(context.recentEvents).toEqual([])
    expect(valid(context)).toBe(true)
  })

  it('never includes another player build while spectating, and rejects malformed render numbers', () => {
    frame.curr = fight()
    frame.localPlayer = -1
    useGame.getState().setScreen('replay')
    sources.perf = { backend: 'bad', fps: NaN, frameMs: Infinity, drawCalls: -1, triangles: 1.5 }
    const context = captureFeedbackContext()
    expect(context.game!.ownBuild).toBeNull()
    expect(context.render).toEqual({ backend: 'unknown' })
    expect(valid(context)).toBe(true)
  })

  it('keeps at most fifty chronological event summaries, excluding future events and arbitrary strings', () => {
    const state = fight()
    state.tick = 100
    frame.curr = state
    frame.localPlayer = 0
    useGame.getState().setScreen('results')
    for (let tick = 1; tick <= 80; tick++) eventLog.push({ tick, events: [
      { type: 'modifier', pawn: 1, id: 'private-modifier-name', on: true, source: 0 },
      { type: 'damage', target: 2, source: 0, amount: tick, cause: 'lightning', x: 1, y: 2, kb: 3 },
    ] })
    eventLog.push({ tick: 101, events: [{ type: 'cast', pawn: 1, spell: 'fireball', x: 0, y: 0 }] })
    eventLog.push({ tick: 99, events: [{ type: 'projectileBounce', id: 99, spell: 'fireball', x: 0, y: 0 }] })
    eventLog.push({ tick: 100, events: [{ type: 'damage', target: 2, source: 0, amount: 7, cause: 'private-arbitrary-cause', x: 0, y: 0, kb: 0 } as SimEvent] })
    const context = captureFeedbackContext()
    expect(context.recentEvents).toHaveLength(50)
    expect(context.recentEvents.at(-1)).toEqual({ tick: 100, type: 'damage', actor: 0, target: 2, value: 7 })
    expect(context.recentEvents.every((event, i, list) => i === 0 || event.tick >= list[i - 1].tick)).toBe(true)
    expect(JSON.stringify(context.recentEvents)).not.toMatch(/private|cause|\"x\"|projectileBounce/)
    expect(valid(context)).toBe(true)
  })

  it('sanitizes and bounds existing captured errors without installing listeners or copying credentials', () => {
    const secret = 'person@example.test Bearer abc.def key=KEYSECRET token="TOKENSECRET" sk_123456789abcdef eyJabcd.abcdef.abcdef wss://socket.test?ticket=SOCKETSECRET#HASHSECRET'
    const summary = vi.fn(() => Array.from({ length: 12 }, (_, i) => ({ atMs: i, error: `uncaught: Failure ${i} ${secret} https://example.test/app.js?access_token=URLSECRET#HASHSECRET`, stack: Array.from({ length: 20 }, () => `at https://example.test/app.js?key=STACKSECRET#HASHSECRET ${secret} ${'x'.repeat(500)}`).join('\n') })))
    Object.assign(window, { __errorCapture: { summary }, addEventListener: vi.fn() })
    const context = captureFeedbackContext(`Account person@example.test ${'long '.repeat(30)}`)
    expect(context.errors).toHaveLength(8)
    expect(context.errors[0].message).toContain('Failure 4')
    expect(context.errors.every((error) => error.stack!.split('\n').length === 8 && error.stack!.split('\n').every((line) => line.length <= 300))).toBe(true)
    expect(context.panel!.length).toBeLessThanOrEqual(64)
    expect(JSON.stringify(context)).not.toMatch(/person@example|abc\.def|KEYSECRET|TOKENSECRET|URLSECRET|STACKSECRET|SOCKETSECRET|HASHSECRET|sk_123|eyJabcd/)
    expect(JSON.stringify(context)).toContain('https://example.test/app.js')
    expect(summary).toHaveBeenCalledOnce()
    expect(window.addEventListener).not.toHaveBeenCalled()
    expect(valid(context)).toBe(true)
  })

  it('records unavailable optional device measurements as null and constrains physical viewport dimensions', () => {
    Object.assign(window, { innerWidth: 40000, innerHeight: 0, devicePixelRatio: 10 })
    vi.stubGlobal('navigator', { userAgent: 'test', language: 'en', maxTouchPoints: 2, onLine: false })
    const context = captureFeedbackContext('  ')
    expect(context.device).toMatchObject({ width: 32768, height: 1, dpr: 8, touch: true, cores: null, memory: null, online: false })
    expect(context.panel).toBeNull()
    expect(valid(context)).toBe(true)
  })
})
