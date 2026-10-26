import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MenuPlayerCard } from './MenuPlayerCard'

const props: ComponentProps<typeof MenuPlayerCard> = {
  name: 'Laub', account: null, accountsEnabled: true, siteHost: null, accountLoaded: true, accountError: null, accountBusy: false,
  rating: null, ratingState: 'ready', emberBalance: null, emberProblem: null,
  onProfile() {}, onSignIn() {}, onLeaderboard() {}, onCollection() {}, onRetryAccount() {},
}
const render = (patch: Partial<typeof props> = {}) => renderToStaticMarkup(createElement(MenuPlayerCard, { ...props, ...patch }))
const account = { email: 'laub@example.test', profile: { name: 'Laub', color: null } }

describe('menu player card states', () => {
  it('keeps guest profile editing and sign-in available without exposing signed-in controls', () => {
    const html = render()
    expect(html).toContain('Edit player name and color: Laub')
    expect(html).toContain('data-testid="player-sign-in"')
    expect(html).toContain('Guest warlock')
    expect(html).not.toContain('data-testid="open-collection"')
  })

  it('waits for the account check before offering an actionable sign-in', () => {
    const html = render({ accountLoaded: false })
    expect(html).toContain('Checking sign-in…')
    expect(html).toContain('disabled=""')
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('>Sign in<')
  })

  it('distinguishes pending and failed rating reads from a genuinely unranked player', () => {
    expect(render({ ratingState: 'loading' })).toContain('Checking…')
    expect(render({ ratingState: 'loading' })).not.toContain('Unranked')
    expect(render({ ratingState: 'error' })).toContain('Unavailable')
    expect(render({ ratingState: 'error' })).not.toContain('Unranked')
    expect(render()).toContain('Unranked')
    const rated = render({ rating: { rating: 1247, rank: 12 } })
    expect(rated).toContain('Global Elo 1247, rank 12. Open leaderboard')
    expect(rated).toContain('Rank #12')
  })

  it('shows the signed-in identity and real zero balance, with a collection action', () => {
    const html = render({ account, emberBalance: 0 })
    expect(html).toContain('Account settings: Laub, laub@example.test')
    expect(html).toContain('data-testid="open-collection"')
    expect(html).toContain('0 Embers · Open your collection')
    expect(html).not.toContain('Loading balance')
    expect(html).not.toContain('data-testid="player-sign-in"')
    expect(render({ account, emberProblem: 'Balance request failed.' })).toContain('Balance unavailable')
  })

  it('keeps setup and account retry in the same unit without inventing a registered profile', () => {
    const html = render({ account: { email: 'new@example.test', profile: null }, accountError: 'Account service unavailable.' })
    expect(html).toContain('Finish account setup: Laub, new@example.test')
    expect(html).toContain('role="alert"')
    expect(html).toContain('Retry account')
    const offline = render({ accountsEnabled: false, ratingState: 'disabled' })
    expect(offline).not.toContain('data-testid="profile-elo"')
    expect(offline).not.toContain('data-testid="player-sign-in"')
    expect(offline).toContain('data-testid="player-profile"')
    expect(offline).not.toContain('data-testid="player-guest-note"')
  })

  it('sends a guest of a build hosted elsewhere to the site and says what they miss', () => {
    // itch.io cannot sign in inside its iframe; without this the guest never learns accounts exist
    const html = render({ accountsEnabled: false, siteHost: 'brawlock.osc.link', ratingState: 'ready' })
    expect(html).toContain('data-testid="player-sign-in"')
    expect(html).toContain('on brawlock.osc.link')
    expect(html).toContain('data-columns="2"')
    expect(html).toContain('no ranked Elo, Embers or wardrobe')
    expect(html).not.toContain('Sign-in options')
    // the first-party build keeps its own sign-in dialog and no guest note
    expect(render({ siteHost: 'brawlock.osc.link' })).not.toContain('data-testid="player-guest-note"')
  })
})
