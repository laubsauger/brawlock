import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { renderMarkup, testId } from '../testing/markup'
import { MenuPlayerCard } from './MenuPlayerCard'

const props: ComponentProps<typeof MenuPlayerCard> = {
  name: 'Laub', account: null, accountsEnabled: true, siteHost: null, accountLoaded: true, accountError: null, accountBusy: false,
  rating: null, ratingState: 'ready', emberBalance: null, emberProblem: null,
  onProfile() {}, onSignIn() {}, onLeaderboard() {}, onCollection() {}, onRetryAccount() {},
}
const render = (patch: Partial<typeof props> = {}) => renderMarkup(createElement(MenuPlayerCard, { ...props, ...patch }))
// the menu gets the whole account, email included, as MainMenu passes it
const account = { email: 'laub@example.test', profile: { name: 'Laub', color: null } }
const newAccount = { email: 'new@example.test', profile: null }

const state = (html: ReturnType<typeof render>, id: string) => html.get(testId(id)).attr('data-state')

describe('menu player card states', () => {
  it('keeps guest profile editing and sign-in available without exposing signed-in controls', () => {
    const html = render()
    expect(state(html, 'player-profile')).toBe('guest')
    expect(html.get(testId('player-profile')).attr('aria-label')).toContain('Laub')
    expect(html.get(testId('player-sign-in')).attr('disabled')).toBeUndefined()
    expect(html.find(testId('open-collection'))).toBeUndefined()
  })

  it('waits for the account check before offering an actionable sign-in', () => {
    const html = render({ accountLoaded: false })
    expect(state(html, 'player-profile')).toBe('checking')
    const signIn = html.get(testId('player-sign-in'))
    expect(signIn.attr('disabled')).toBeDefined()
    expect(signIn.attr('aria-busy')).toBe('true')
  })

  it('distinguishes pending and failed rating reads from a genuinely unranked player', () => {
    expect(state(render({ ratingState: 'loading' }), 'profile-elo')).toBe('loading')
    expect(state(render({ ratingState: 'error' }), 'profile-elo')).toBe('error')
    expect(state(render(), 'profile-elo')).toBe('unranked')
    const rated = render({ rating: { rating: 1247, rank: 12 } }).get(testId('profile-elo'))
    expect(rated.attr('data-state')).toBe('rated')
    expect(rated.attr('aria-label')).toMatch(/\b1247\b.*\b12\b/)
    expect(rated.text).toContain('#12')
  })

  it('shows the signed-in identity and real zero balance, with a collection action', () => {
    const html = render({ account, emberBalance: 0 })
    expect(state(html, 'player-profile')).toBe('account')
    expect(html.get(testId('player-profile')).attr('aria-label')).toContain('Laub')
    const collection = html.get(testId('open-collection'))
    expect(collection.attr('data-state')).toBe('ready')
    expect(collection.get('.menu-player-action-value').text).toMatch(/^0\D/) // the balance itself, not a placeholder
    expect(html.find(testId('player-sign-in'))).toBeUndefined()
    expect(state(render({ account, emberProblem: 'Balance request failed.' }), 'open-collection')).toBe('error')
  })

  it('keeps setup and account retry in the same unit without inventing a registered profile', () => {
    const html = render({ account: newAccount, accountError: 'Account service unavailable.' })
    expect(state(html, 'player-profile')).toBe('setup')
    expect(html.get('[role="alert"]').find('button')).toBeDefined() // retry
    const offline = render({ accountsEnabled: false, ratingState: 'disabled' })
    expect(offline.find(testId('profile-elo'))).toBeUndefined()
    expect(offline.find(testId('player-sign-in'))).toBeUndefined()
    expect(offline.find(testId('player-profile'))).toBeDefined()
    expect(offline.find(testId('player-guest-note'))).toBeUndefined()
  })

  it('never shows the email, not even in a title or label: the menu is on screen between games on a stream', () => {
    for (const signedIn of [account, newAccount]) expect(renderToStaticMarkup(createElement(MenuPlayerCard, { ...props, account: signedIn }))).not.toContain(signedIn.email)
  })

  it('sends a guest of a build hosted elsewhere to the site and says what they miss', () => {
    // itch.io cannot sign in inside its iframe; without this the guest never learns accounts exist
    const html = render({ accountsEnabled: false, siteHost: 'brawlock.osc.link', ratingState: 'ready' })
    expect(html.findAll(testId('player-sign-in'))).toHaveLength(1)
    expect(html.get(testId('player-sign-in')).text).toContain('brawlock.osc.link')
    expect(html.get('[data-columns]').attr('data-columns')).toBe('2')
    expect(html.get(testId('player-guest-note')).text).toContain('brawlock.osc.link')
    // the first-party build keeps its own sign-in dialog and no guest note
    const firstParty = render({ siteHost: 'brawlock.osc.link' })
    expect(firstParty.get(testId('player-sign-in')).text).not.toContain('brawlock.osc.link')
    expect(firstParty.find(testId('player-guest-note'))).toBeUndefined()
  })
})
