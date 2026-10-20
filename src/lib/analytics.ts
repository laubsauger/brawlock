import { useGame } from '../game/store'
import { usePractice } from '../game/practiceState'
import { useAccount } from '../game/accountState'
import { analyticsConfig } from './analyticsConfig'

declare const __RELEASE__: { version: string }
type Tag = (...args: unknown[]) => void
export type MatchAnalyticsMode = 'ranked' | 'casual' | 'custom' | 'offline'
declare global {
  interface Window {
    dataLayer?: IArguments[]
    gtag?: Tag
    [key: `ga-disable-${string}`]: boolean | undefined
  }
}
interface Events {
  how_to_play_view: { entry_point: 'menu' | 'first_play' }
  how_to_play_exit: { choice: 'continue' | 'close' | 'practice'; entry_point: 'menu' | 'first_play' }
  how_to_play_lesson_view: { lesson: string; entry_point: 'menu' | 'first_play' }
  how_to_play_clip_start: { lesson: string; playback: 'autoplay' | 'manual' }
  guided_practice_click: { entry_point: 'menu' | 'first_play' }
  tutorial_begin: Record<string, never>
  tutorial_step: { step: string }
  tutorial_complete: Record<string, never>
  tutorial_exit: { step: string }
  match_start: { mode: MatchAnalyticsMode; transport: 'server' | 'p2p' | 'offline'; players: number; bots: number }
  match_complete: { mode: MatchAnalyticsMode; outcome: 'win' | 'loss'; rounds: number; duration_seconds: number }
  match_exit: { mode: MatchAnalyticsMode }
}

/** Only marketing parameters leave the app. Invite codes, auth callbacks and hashes never do. */
export function analyticsLocation(href: string): string {
  const input = new URL(href)
  const output = new URL(input.pathname, input.origin)
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id']) {
    const value = input.searchParams.get(key)
    if (value && /^[a-zA-Z0-9_. -]{1,100}$/.test(value)) output.searchParams.set(key, value)
  }
  return output.href
}

function referralOrigin(referrer: string): string {
  if (!referrer) return ''
  try { const url = new URL(referrer); return /^https?:$/.test(url.protocol) ? url.origin : '' }
  catch { return '' } // Invalid external referrer data is discarded.
}

// Capture acquisition before the splash scrubs invite/auth parameters from history.
const landing = typeof window === 'undefined' ? '' : analyticsLocation(window.location.href)
const referrer = typeof document === 'undefined' ? '' : referralOrigin(document.referrer)
const id = analyticsConfig.measurementId
if (id !== null && !/^G-[A-Z0-9]{5,20}$/.test(id)) throw new Error('Invalid Google Analytics measurement ID')
export const analyticsAvailable = id !== null && typeof window !== 'undefined' && window.location.origin === analyticsConfig.origin
let started = false
let installed = false

function enabled(): boolean {
  return analyticsAvailable && useGame.getState().settings.analyticsConsent === true
}

function tag(...args: unknown[]): void { window.gtag?.(...args) }

function pageView(): void {
  if (!enabled()) return
  tag('event', 'page_view', { page_location: landing, page_referrer: referrer, page_title: 'Brawlock', screen_name: useGame.getState().screen, app_version: __RELEASE__.version, player_type: useAccount.getState().player ? 'account' : 'guest' })
}

function clearAnalyticsCookies(): void {
  const host = window.location.hostname.split('.')
  const domains = ['', ...host.slice(0, -1).map((_, index) => `; domain=${host.slice(index).join('.')}`)]
  for (const name of ['_ga', `_ga_${id!.slice(2)}`]) {
    for (const domain of domains) document.cookie = `${name}=; Max-Age=0; path=/${domain}; SameSite=Lax; Secure`
  }
}

function applyConsent(): void {
  if (!analyticsAvailable) return
  const win = window
  win[`ga-disable-${id}`] = !enabled()
  if (!enabled()) {
    if (started) clearAnalyticsCookies()
    return
  }
  if (!started) {
    started = true
    win.dataLayer = []
    win.gtag = function (..._args) { win.dataLayer!.push(arguments) }
    tag('consent', 'default', { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' })
    tag('js', new Date())
    tag('config', id, { send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false, page_location: landing, page_referrer: referrer, page_title: 'Brawlock' })
    const script = document.createElement('script')
    script.async = true
    script.src = `https://www.googletagmanager.com/gtag/js?id=${id}`
    script.onerror = () => console.warn('Optional Google Analytics could not load.')
    document.head.append(script)
  }
  pageView()
}

export function trackEvent<N extends keyof Events>(name: N, params: Events[N]): void {
  if (!enabled() || !started) return
  tag('event', name, { ...params, app_version: __RELEASE__.version, page_location: landing, page_referrer: referrer, page_title: 'Brawlock', player_type: useAccount.getState().player ? 'account' : 'guest' })
}

/** One installation outside React effects: no duplicate subscriptions under StrictMode. */
export function installAnalytics(): void {
  if (installed || !analyticsAvailable) return
  installed = true
  applyConsent()
  useGame.subscribe((next, previous) => {
    if (next.settings.analyticsConsent !== previous.settings.analyticsConsent) applyConsent()
    else if (next.screen !== previous.screen) pageView()
  })
  usePractice.subscribe((next, previous) => {
    if (!next.view) {
      if (previous.view && previous.view.step !== 'complete') trackEvent('tutorial_exit', { step: previous.view.step })
      return
    }
    if (!previous.view) trackEvent('tutorial_begin', {})
    if (next.view.step === previous.view?.step) return
    if (next.view.step === 'complete') trackEvent('tutorial_complete', {})
    else trackEvent('tutorial_step', { step: next.view.step })
  })
}
