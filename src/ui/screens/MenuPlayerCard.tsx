import type { AccountPlayer } from '../../game/account'
import { MenuGlyph } from '../icons'
import { hoverSfx, sfx } from '../lib/sound'
import { EmberMark } from './Collection'

export type MenuRatingState = 'loading' | 'ready' | 'error' | 'disabled'

interface Props {
  name: string
  account: Pick<AccountPlayer, 'email' | 'profile'> | null
  accountsEnabled: boolean
  accountLoaded: boolean
  accountError: string | null
  accountBusy: boolean
  rating: { rating: number; rank: number } | null
  ratingState: MenuRatingState
  emberBalance: number | null
  emberProblem: string | null
  onProfile(): void
  onSignIn(): void
  onLeaderboard(): void
  onCollection(): void
  onRetryAccount(): void
}

const balanceLabel = (value: number) => new Intl.NumberFormat('en', value >= 1_000_000 ? { notation: 'compact', maximumFractionDigits: 1 } : {}).format(value)

/** One player identity with a shared action row; dialogs and requests stay in MainMenu. */
export function MenuPlayerCard(props: Props) {
  const { name, account, accountsEnabled, accountLoaded, accountError, accountBusy, rating, ratingState, emberBalance, emberProblem } = props
  const ranked = ratingState !== 'disabled'
  const checking = accountsEnabled && !accountLoaded
  const status = checking ? 'Checking sign-in…' : account ? account.profile ? 'Your account' : 'Finish account setup' : 'Guest warlock'
  const profileLabel = account ? `${account.profile ? 'Account settings' : 'Finish account setup'}: ${name}, ${account.email}` : `Edit player name and color: ${name}`
  const invoke = (action: () => void) => () => { sfx('click'); action() }
  const actions = Number(ranked) + Number(accountsEnabled)
  return <section className="menu-player-card" aria-label="Player and account" data-testid="menu-player-card">
    <button type="button" className="menu-player-profile" data-testid="player-profile" onClick={invoke(props.onProfile)} onMouseEnter={hoverSfx} aria-label={profileLabel} title={account ? `Signed in as ${account.email}` : 'Edit your name and color'}>
      <span className="menu-player-avatar"><MenuGlyph kind="profile" size={23} /></span>
      <span className="menu-player-identity">
        <span className="menu-player-status">{status}</span>
        <span className="menu-player-name" title={name}>{name}</span>
        {account && <span className="menu-player-email" title={account.email}>{account.email}</span>}
      </span>
      <span className="menu-player-edit"><MenuGlyph kind="edit" size={15} /></span>
    </button>
    {actions > 0 && <div className="menu-player-actions" data-columns={actions}>
      {ranked && <button type="button" className="menu-player-action" data-testid="profile-elo" onClick={invoke(props.onLeaderboard)} onMouseEnter={hoverSfx} title="Open the global Elo leaderboard" aria-label={ratingState === 'ready' && rating ? `Global Elo ${Math.round(rating.rating)}, rank ${rating.rank}. Open leaderboard` : 'Open the global Elo leaderboard'}>
        <span className="menu-player-action-heading"><MenuGlyph kind="record" size={15} /> Global Elo</span>
        <span className="menu-player-action-value tabular">{ratingState === 'loading' ? 'Checking…' : ratingState === 'error' ? 'Unavailable' : rating ? Math.round(rating.rating).toLocaleString() : 'Unranked'}</span>
        <span className="menu-player-action-detail">{ratingState === 'ready' && rating ? `Rank #${rating.rank.toLocaleString()}` : 'Leaderboard'} <span aria-hidden>›</span></span>
      </button>}
      {accountsEnabled && (account ? <button type="button" className="menu-player-action" data-testid="open-collection" onClick={invoke(props.onCollection)} onMouseEnter={hoverSfx} title={emberProblem ?? (emberBalance === null ? 'Your permanent cosmetic collection' : `${emberBalance.toLocaleString()} Embers · Open your collection`)}>
        <span className="menu-player-action-heading"><EmberMark size={15} /> Collection</span>
        <span className="menu-player-action-value tabular">{emberBalance === null ? '—' : balanceLabel(emberBalance)}<span className="menu-player-unit">Embers</span></span>
        <span className="menu-player-action-detail">{emberProblem ? 'Balance unavailable' : emberBalance === null ? 'Loading balance…' : 'Cosmetics'} <span aria-hidden>›</span></span>
      </button> : <button type="button" className="menu-player-action menu-player-sign-in" data-testid="player-sign-in" onClick={invoke(props.onSignIn)} onMouseEnter={hoverSfx} disabled={checking || accountBusy} aria-busy={checking || accountBusy || undefined}>
        <span className="menu-player-action-heading"><MenuGlyph kind="profile" size={15} /> Account</span>
        <span className="menu-player-action-value">{checking || accountBusy ? 'Checking…' : 'Sign in'}</span>
        <span className="menu-player-action-detail">Sign-in options <span aria-hidden>›</span></span>
      </button>)}
    </div>}
    {accountsEnabled && accountError && <div className="menu-player-error" role="alert"><span>{accountError}</span><button type="button" onMouseEnter={hoverSfx} disabled={accountBusy} onClick={invoke(props.onRetryAccount)}>{accountBusy ? 'Retrying…' : 'Retry account'}</button></div>}
  </section>
}
