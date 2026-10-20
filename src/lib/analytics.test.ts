import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const config = vi.hoisted(() => ({ measurementId: 'G-TEST123456' as string | null, origin: 'https://brawlock.osc.link' }))
vi.mock('./analyticsConfig', () => ({ analyticsConfig: config }))

let append: ReturnType<typeof vi.fn>
let deleted: string[]
let game: typeof import('../game/store').useGame
let practice: typeof import('../game/practiceState').usePractice
let analytics: typeof import('./analytics')
const calls = () => (window.dataLayer ?? []).map((command) => Array.from(command))
const events = (name: string) => calls().filter((command) => command[0] === 'event' && command[1] === name)

beforeEach(async () => {
  vi.resetModules()
  config.measurementId = 'G-TEST123456'
  deleted = []
  append = vi.fn()
  vi.stubGlobal('window', { location: new URL('https://brawlock.osc.link/?utm_source=x&utm_medium=social&utm_campaign=launch&room=SECRET&accountReturn=PRIVATE#token') })
  vi.stubGlobal('document', { referrer: 'https://example.test/private/person?email=private@example.test',
    createElement: () => ({}), head: { append }, set cookie(value: string) { deleted.push(value) } })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  game = (await import('../game/store')).useGame
  practice = (await import('../game/practiceState')).usePractice
  game.getState().setSettings({ analyticsConsent: null })
  analytics = await import('./analytics')
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('optional product analytics', () => {
  it('sends nothing and loads no Google script before consent or after a refusal', () => {
    analytics.installAnalytics()
    analytics.trackEvent('match_start', { mode: 'custom', transport: 'server', players: 2, bots: 8 })
    game.getState().setScreen('menu')
    game.getState().setSettings({ analyticsConsent: false })
    expect(append).not.toHaveBeenCalled()
    expect(window.dataLayer).toBeUndefined()
  })

  it('initializes only once after opt-in and strips invite/auth/referral details from all events', async () => {
    analytics.installAnalytics()
    analytics.installAnalytics()
    game.getState().setScreen('menu')
    game.getState().setSettings({ analyticsConsent: true })
    expect(append).toHaveBeenCalledOnce()
    const { useAccount } = await import('../game/accountState')
    useAccount.setState({ player: { id: 'private-account-id', email: 'private@example.test', profile: { name: 'Private Player', color: null }, game: null } })
    analytics.trackEvent('match_start', { mode: 'custom', transport: 'server', players: 2, bots: 8 })
    expect(events('match_start')[0][2]).toMatchObject({ player_type: 'account', mode: 'custom' })
    for (const secret of ['private-account-id', 'private@example.test', 'Private Player']) expect(JSON.stringify(calls())).not.toContain(secret)
    expect(append.mock.calls[0][0].src).toBe('https://www.googletagmanager.com/gtag/js?id=G-TEST123456')
    expect(events('page_view')).toHaveLength(1)
    expect(events('page_view')[0][2]).toMatchObject({
      screen_name: 'menu', player_type: 'guest', page_location: 'https://brawlock.osc.link/?utm_source=x&utm_medium=social&utm_campaign=launch', page_referrer: 'https://example.test',
    })
    expect(calls()[0]).toEqual(['consent', 'default', { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' }])
    const commands = JSON.stringify(calls())
    for (const secret of ['SECRET', 'PRIVATE', 'token', 'email', 'private/person', 'user_id']) expect(commands).not.toContain(secret)
    game.getState().setScreen('match')
    expect(events('page_view')).toHaveLength(2)
    expect(append).toHaveBeenCalledOnce()
  })

  it('immediately disables measurement and expires analytics cookies when consent is withdrawn', () => {
    analytics.installAnalytics()
    game.getState().setSettings({ analyticsConsent: true })
    const count = calls().length
    game.getState().setSettings({ analyticsConsent: false })
    game.getState().setScreen('match')
    analytics.trackEvent('match_exit', { mode: 'casual' })
    expect(window['ga-disable-G-TEST123456']).toBe(true)
    expect(calls()).toHaveLength(count)
    expect(deleted).toContain('_ga=; Max-Age=0; path=/; domain=osc.link; SameSite=Lax; Secure')
    expect(deleted.some((cookie) => cookie.startsWith('_ga_TEST123456='))).toBe(true)
    game.getState().setSettings({ analyticsConsent: true })
    expect(window['ga-disable-G-TEST123456']).toBe(false)
    expect(append).toHaveBeenCalledOnce()
  })

  it('tracks actual practice steps and completion once, distinguishing early exits', () => {
    analytics.installAnalytics()
    game.getState().setSettings({ analyticsConsent: true })
    const view = (step: 'move' | 'fireball' | 'complete', retries = 0) => ({ step, retries, target: null })
    practice.setState({ view: view('move') })
    practice.setState({ view: view('move', 1) })
    practice.setState({ view: view('fireball') })
    practice.setState({ view: view('complete') })
    practice.setState({ view: null })
    expect(events('tutorial_begin')).toHaveLength(1)
    expect(events('tutorial_step')).toHaveLength(2)
    expect(events('tutorial_complete')).toHaveLength(1)
    expect(events('tutorial_exit')).toHaveLength(0)
    practice.setState({ view: view('move') })
    practice.setState({ view: null })
    expect(events('tutorial_exit')).toHaveLength(1)
    expect(events('tutorial_exit')[0][2]).toMatchObject({ step: 'move' })
  })

  it('keeps tracking disabled on local previews and when no Measurement ID is configured', async () => {
    vi.resetModules()
    config.measurementId = null
    expect((await import('./analytics')).analyticsAvailable).toBe(false)
    vi.resetModules()
    config.measurementId = 'G-TEST123456'
    vi.stubGlobal('window', { location: new URL('http://localhost:5173') })
    const preview = await import('./analytics')
    expect(preview.analyticsAvailable).toBe(false)
    preview.installAnalytics()
    expect(append).not.toHaveBeenCalled()
  })

  it('rejects malformed configuration and drops unsupported campaign values', async () => {
    expect(analytics.analyticsLocation('https://brawlock.osc.link/?utm_source=private@example.test&email=private@example.test#secret')).toBe('https://brawlock.osc.link/')
    vi.resetModules()
    config.measurementId = 'https://untrusted.test/'
    await expect(import('./analytics')).rejects.toThrow('Invalid Google Analytics measurement ID')
  })
})
