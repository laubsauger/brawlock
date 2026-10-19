import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getCareer, type Career } from '../../game/stats'
import { useGame } from '../../game/store'
import { session } from '../../game/session'
import { guidedPractice, hostGame, hostOnServer, joinRoom, playOffline, quickPlay } from '../flow'
import { tutorial } from './onboarding'

vi.mock('../../game/stats', () => ({ getCareer: vi.fn(() => null) }))
vi.mock('../../game/session', () => ({ session: {
  openOffline: vi.fn(),
  openPractice: vi.fn(),
  openHost: vi.fn(async () => ({ ok: true, mode: 'p2p', region: null })),
  openHostServer: vi.fn(async () => ({ ok: true, mode: 'server', region: null })),
  quickPlay: vi.fn(async () => ({ ok: true, mode: 'server', region: null })),
  join: vi.fn(async () => {}),
} }))

let saved: Map<string, string>
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  tutorial.dismiss()
  vi.clearAllMocks()
  vi.mocked(getCareer).mockReturnValue(null)
  saved = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { saved.set(key, value) },
  })
  useGame.getState().setSettings({ tutorialSeen: false })
  useGame.getState().setScreen('menu')
})
afterEach(() => {
  tutorial.dismiss()
  vi.unstubAllGlobals()
})

describe('first-play onboarding', () => {
  it('chooses guided practice without executing the intercepted matchmaking action', () => {
    quickPlay('eu')
    guidedPractice()
    expect(tutorial.get()).toBeNull()
    expect(session.openPractice).toHaveBeenCalledOnce()
    expect(session.quickPlay).not.toHaveBeenCalled()
    expect(session.openOffline).not.toHaveBeenCalled()
    expect(useGame.getState().settings.tutorialSeen).toBe(true)
  })
  it('cancels a pending invite when practice is chosen instead, without joining it later', () => {
    const run = vi.fn(), cancel = vi.fn()
    tutorial.request({ label: 'Join game', run, cancel })
    guidedPractice()
    tutorial.continue()
    expect(cancel).toHaveBeenCalledOnce()
    expect(run).not.toHaveBeenCalled()
    expect(session.openPractice).toHaveBeenCalledOnce()
  })
  it('keeps the action private until Continue, then runs it exactly once and persists completion', () => {
    const run = vi.fn()
    const changed = vi.fn()
    const unsubscribe = tutorial.subscribe(changed)
    tutorial.request({ label: 'Find a game', run })
    const snapshot = tutorial.get()
    expect(snapshot).toEqual({ label: 'Find a game' })
    expect(tutorial.get()).toBe(snapshot)
    expect(run).not.toHaveBeenCalled()
    expect(useGame.getState().settings.tutorialSeen).toBe(false)
    tutorial.continue()
    tutorial.continue()
    expect(run).toHaveBeenCalledTimes(1)
    expect(tutorial.get()).toBeNull()
    expect(useGame.getState().settings.tutorialSeen).toBe(true)
    expect(JSON.parse(saved.get('brawlock.settings.v1')!).tutorialSeen).toBe(true)
    expect(changed).toHaveBeenCalledTimes(2)
    unsubscribe()
    tutorial.open()
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('dismisses a pending choice without joining and calls its cancellation callback once', () => {
    const run = vi.fn()
    const cancel = vi.fn()
    tutorial.request({ label: 'Join game', run, cancel })
    tutorial.dismiss()
    tutorial.continue()
    tutorial.dismiss()
    expect(run).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(tutorial.get()).toBeNull()
    expect(useGame.getState().settings.tutorialSeen).toBe(true)
  })

  it('runs immediately for someone who has already seen the guide', () => {
    useGame.getState().setSettings({ tutorialSeen: true })
    const run = vi.fn()
    tutorial.request({ label: 'Find a game', run })
    expect(run).toHaveBeenCalledOnce()
    expect(tutorial.get()).toBeNull()
  })

  it('runs immediately for a returning player with career history', () => {
    vi.mocked(getCareer).mockReturnValue({} as Career)
    const run = vi.fn()
    tutorial.request({ label: 'Play vs bots', run })
    expect(run).toHaveBeenCalledOnce()
    expect(tutorial.get()).toBeNull()
  })

  it('opens manually even after completion and has no saved session action', () => {
    useGame.getState().setSettings({ tutorialSeen: true })
    tutorial.open()
    expect(tutorial.get()).toEqual({ label: null })
    tutorial.continue()
    expect(tutorial.get()).toBeNull()
    expect(session.openOffline).not.toHaveBeenCalled()
    expect(session.join).not.toHaveBeenCalled()
    tutorial.open()
    tutorial.dismiss()
    expect(tutorial.get()).toBeNull()
  })

  it('returns an intercepted invite link to the menu if the guide is dismissed', () => {
    useGame.getState().setScreen('boot')
    expect(joinRoom('https://game.test/?room=KRZBW')).toBeNull()
    expect(useGame.getState().screen).toBe('menu')
    expect(session.join).not.toHaveBeenCalled()
    tutorial.dismiss()
    expect(useGame.getState().screen).toBe('menu')
    expect(session.join).not.toHaveBeenCalled()
  })

  it('rejects invalid room codes before opening the guide or touching the network', () => {
    expect(joinRoom('I0')).toMatchObject({ problem: expect.any(String) })
    expect(tutorial.get()).toBeNull()
    expect(session.join).not.toHaveBeenCalled()
  })

  it('cancels the previous pending choice when another choice replaces it', () => {
    const oldRun = vi.fn()
    const cancel = vi.fn()
    const nextRun = vi.fn()
    tutorial.request({ label: 'Join game', run: oldRun, cancel })
    tutorial.request({ label: 'Play vs bots', run: nextRun })
    expect(cancel).toHaveBeenCalledOnce()
    tutorial.continue()
    expect(oldRun).not.toHaveBeenCalled()
    expect(nextRun).toHaveBeenCalledOnce()
  })

  it.each([
    { label: 'offline play', start: () => playOffline(), called: () => session.openOffline },
    { label: 'PC hosting', start: () => hostGame(), called: () => session.openHost },
    { label: 'server hosting', start: () => hostOnServer('eu'), called: () => session.openHostServer },
    { label: 'quick play', start: () => quickPlay('eu'), called: () => session.quickPlay },
    { label: 'joining a room', start: () => joinRoom('krz-bw'), called: () => session.join },
  ])('intercepts $label before creating a session', ({ start, called }) => {
    start()
    for (const method of [session.openOffline, session.openHost, session.openHostServer, session.quickPlay, session.join]) expect(method).not.toHaveBeenCalled()
    expect(tutorial.get()).not.toBeNull()
    tutorial.continue()
    expect(called()).toHaveBeenCalledOnce()
  })

  it('preserves the chosen region and normalized invite code through the guide', () => {
    quickPlay('eu')
    tutorial.continue()
    expect(session.quickPlay).toHaveBeenCalledWith({ region: 'eu' })
    useGame.getState().setSettings({ tutorialSeen: false })
    hostOnServer('us-west')
    tutorial.continue()
    expect(session.openHostServer).toHaveBeenCalledWith('us-west')
    useGame.getState().setSettings({ tutorialSeen: false })
    joinRoom('https://game.test/?room=krz-bw')
    tutorial.continue()
    expect(session.join).toHaveBeenCalledWith('KRZBW', undefined)
  })

  it.each([{ kind: 'p2p' }, { kind: 'server', region: 'us-west' }] as const)('preserves the selected $kind hosting mode through the guide', (route) => {
    joinRoom('krz-bw', undefined, route)
    expect(session.join).not.toHaveBeenCalled()
    tutorial.continue()
    expect(session.join).toHaveBeenCalledWith('KRZBW', route)
  })
})
