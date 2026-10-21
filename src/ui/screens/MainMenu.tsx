import { FeedbackButton } from '../FeedbackButton'
import { useFeedback } from '../lib/feedbackState'
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { useGame } from '../../game/store'
import { Wordmark } from '../Brand'
import { ReleaseNotesButton } from '../ReleaseNotes'
import { Button, Kbd, Modal } from '../widgets'
import { MenuGlyph } from '../icons'
import { hostGame, hostOnServer, joinRoom, lastHostAction, quickPlay, rankedPlay, useLastHostResult } from '../flow'
import { BrowseGames } from './BrowseGames'
import { LiveGames } from './LiveGames'
import { PlaySetup } from './PlaySetup'
import { online, rejoin, session, type PublicRoom, type ServerProfile } from '../../game/session'
import { getProfile, setPreferredColor } from '../../game/profile'
import { PreferredColorPicker } from './PlayerColorPicker'
import { pickRegion, regionProblem, useRegionChoice, useRegions, type RegionStatus } from '../lib/servers'
import { RegionPicker } from '../RegionPicker'
import { sfx } from '../lib/sound'
import { chooseName, NAME_MAX } from '../lib/name'
import { staggerIn } from '../lib/motion'
import { toggleFullscreen, useFullscreen } from '../lib/fullscreen'
import { Profile } from './Profile'
import { tutorial } from '../lib/onboarding'
import { spellLibrary } from '../SpellLibrary'
import { browseAvailability, quickPlayAvailability } from '../lib/quickPlay'
import { isPlaySupported, PLAY_REQUIREMENT, usePlaySupported } from '../lib/playAccess'
import { usePolled } from '../lib/ticker'
import { RejoinPrompt } from './RejoinPrompt'
import { accountsEnabled, refreshAccount } from '../../game/account'
import { useAccount } from '../../game/accountState'
import { loadProgression } from '../../game/progression'
import { MenuPlayerCard, type MenuRatingState } from './MenuPlayerCard'
import { accountReturn } from '../../game/accountReturn'
import { ReleaseStamp } from '../ReleaseStamp'

const Account = lazy(() => import('./Account').then((module) => ({ default: module.Account })))
const Collection = lazy(() => import('./Collection').then((module) => ({ default: module.Collection })))

function MenuEntry({
  title,
  sub,
  note,
  onClick,
  primary,
  expanded,
  disabled,
  hint,
  testId,
  ranked,
  badge,
  ready,
}: {
  title: string
  sub: ReactNode
  note?: ReactNode
  onClick: () => void
  primary?: boolean
  expanded?: boolean
  disabled?: boolean
  hint?: string
  testId?: string
  ranked?: boolean
  badge?: string
  ready?: boolean
}) {
  return (
    <Button
      variant={primary ? 'primary' : 'default'}
      className={`menu-item ${primary ? 'menu-item-primary' : 'menu-item-secondary'}${ranked ? ' menu-item-ranked' : ''}`}
      onClick={onClick}
      aria-expanded={expanded}
      disabled={disabled}
      title={hint}
      data-testid={testId}
      data-ready={ready || undefined}
    >
      <span className="flex w-full min-w-0 flex-col items-start gap-0.5 leading-tight">
        <span className="flex w-full items-center justify-between gap-3"><span className={`btn-label max-w-full whitespace-nowrap tracking-[0.06em] ${primary ? 'text-[1.65rem]' : 'text-[1.12rem] max-[480px]:text-base'}`}>{title}</span>{badge && <span className={`menu-entry-badge font-ui flex shrink-0 items-center gap-1.5 rounded border px-2 py-1 text-xs font-medium tracking-normal ${ready ? 'border-[#ffbf94]/50 bg-[#8c3227]/35 text-[#ffe4c9]' : 'border-white/15 bg-black/20 text-[#d4cbdc]'}`}>{ready ? <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#ffcd9f]" /> : <MenuGlyph kind="profile" size={13} />}{badge}</span>}</span>
        <span className={`menu-entry-sub font-ui font-medium tracking-normal ${ranked ? 'text-[0.95rem] text-[#f1c1bc]' : primary ? 'text-[0.95rem] text-[#f3c58c]' : 'text-[0.86rem] text-[#a8927c]'}`}>{sub}</span>
        {note && <span className="menu-entry-note font-ui flex flex-col gap-0.5 text-[0.76rem] font-medium tracking-normal text-[#b7a28e]">{note}</span>}
      </span>
    </Button>
  )
}

/** "US West · 168 ms": the label text a region gets in buttons and messages. */
function regionText(r: RegionStatus): string {
  return r.rttMs != null && r.state === 'up' ? `${r.label} · ${r.rttMs} ms` : r.label
}

/**
 * Casual matchmaking (server builds): jump into an open game on the game server, or
 * a new one filled with bots. Region, health and ping at a glance; greyed out
 * with the reason when the server cannot take players.
 */
function QueueEntries({ onRanked }: { onRanked: (region: string) => void }) {
  const playSupported = usePlaySupported()
  const setSettings = useGame((s) => s.setSettings)
  const statuses = useRegions(5000)
  const choice = useRegionChoice()
  const region = pickRegion(statuses, choice)
  const problem = regionProblem(region)
  const maintenance = region?.maintenance?.draining === true
  const regionId = region?.state === 'up' ? region.id : null
  const [availability, setAvailability] = useState<{ region: string; casual: string } | null>(null)
  useEffect(() => {
    if (!regionId) return
    let live = true
    let busy = false
    const refresh = async () => {
      if (busy) return
      busy = true
      try {
        const rooms = await online.browseRegion(regionId)
        if (live) setAvailability({
          region: regionId,
          casual: quickPlayAvailability(rooms, regionId),
        })
      } catch {
        if (live) setAvailability({ region: regionId, casual: 'Open-game count unavailable' })
      } finally { busy = false }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => { live = false; window.clearInterval(timer) }
  }, [regionId])
  const known = regionId && availability?.region === regionId ? availability : null
  const account = useAccount((s) => s.player)
  const accountLoaded = useAccount((s) => s.loaded)
  const accountError = useAccount((s) => s.error)
  const rankedReady = playSupported && !problem && accountsEnabled && accountLoaded && !accountError && !!account?.profile
  return <div className="menu-queues">
    <RegionPicker statuses={statuses} choice={choice} onChange={(value) => setSettings({ serverRegion: value })} />
    <MenuEntry
      primary
      title="Casual"
      sub={<span className="font-semibold text-[#ffe1a6]">{maintenance ? 'New games paused for maintenance' : known?.casual ?? 'Checking open games…'}</span>}
      note="Matchmaking · no Elo · 10 players · first to 3 · Hard bots"
      disabled={!playSupported || !!problem}
      hint={!playSupported ? PLAY_REQUIREMENT : problem ?? `Join an open game in ${region?.label}, or create a public game with bots filling empty seats`}
      onClick={() => isPlaySupported() && region && quickPlay(choice === 'auto' ? 'auto' : region.id)}
      testId="quick-play"
    />
    <MenuEntry
      primary
      ranked
      title="Ranked"
      sub={maintenance ? 'New ranked games paused' : 'Global Elo · 8 players · 5 rounds'}
      badge={maintenance ? 'Maintenance' : !accountsEnabled ? 'Sign-in unavailable' : !accountLoaded ? 'Checking account' : accountError ? 'Account unavailable' : !account ? 'Sign in required' : !account.profile ? 'Finish setup' : rankedReady ? 'Ready' : undefined}
      ready={rankedReady}
      disabled={!playSupported || !!problem || !accountsEnabled}
      hint={!playSupported ? PLAY_REQUIREMENT : !accountsEnabled ? 'Ranked sign-in is unavailable in this build.' : problem ?? `Find a ranked opponent in ${region?.label}. Sign in to keep your Elo across computers.`}
      onClick={() => isPlaySupported() && region && onRanked(choice === 'auto' ? 'auto' : region.id)}
      testId="ranked-play"
    />
  </div>
}

/** Every region's public games, refreshed every few seconds while the menu is open (null: not loaded). */
function useOpenGames(enabled: boolean): PublicRoom[] | null {
  const [rooms, setRooms] = useState<PublicRoom[] | null>(null)
  useEffect(() => {
    if (!enabled) return
    let live = true
    let busy = false
    const refresh = async () => {
      if (busy) return
      busy = true
      try {
        const next = await online.browse()
        if (live) setRooms(next)
      } finally { busy = false }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => { live = false; window.clearInterval(timer) }
  }, [enabled])
  return rooms
}

/**
 * Browse games entry with a live count of open games across every region, so players can
 * see there are games to pick from.
 */
function BrowseEntry({ rooms, onClick }: { rooms: PublicRoom[] | null; onClick: () => void }) {
  const known = rooms ? browseAvailability(rooms) : null
  return <MenuEntry
    title="Browse games"
    sub={known?.open ? <span className="flex items-center gap-1.5 font-semibold text-[#ffe1a6]"><span aria-hidden className="browse-live-dot h-1.5 w-1.5 shrink-0 rounded-full bg-[#ffcd9f]" />{known.sub}</span> : known?.sub ?? 'Every public game, all regions'}
    hint="See every public game: casual, custom and player-hosted. Join or watch with one click."
    onClick={onClick}
    testId="browse-games"
  />
}

/**
 * After a failed host: the other mode in one click ("Host on the game server
 * (US West, 168 ms) instead"), only when that mode can work right now.
 */
function HostRetry({ onDone }: { onDone: () => void }) {
  const playSupported = usePlaySupported()
  const result = useLastHostResult()
  // keep the other region's ping fresh while the message is up
  const statuses = useRegions(5000)
  const choice = useRegionChoice()
  if (!playSupported || !result || result.ok || !online.configured || !result.other.available || lastHostAction() === 'ranked') return null
  if (result.other.mode === 'p2p') {
    return (
      <Button size="sm" onClick={() => (onDone(), hostGame())} data-testid="retry-other">
        Host from your PC instead
      </Button>
    )
  }
  const region = pickRegion(statuses, choice) ?? result.other.region
  if (!region || regionProblem(region)) return null
  return (
    <Button size="sm" onClick={() => (onDone(), hostOnServer(choice === 'auto' ? 'auto' : region.id))} data-testid="retry-other">
      Host on game server ({regionText(region)}) instead
    </Button>
  )
}

/** Inline room-code entry under "Join game". Accepts "krz-bw", "K R Z B W" or a whole invite link. */
function JoinRow({ onClose }: { onClose: () => void }) {
  const playSupported = usePlaySupported()
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  const submit = () => {
    if (!isPlaySupported()) return
    const p = joinRoom(text)
    if (p) {
      sfx('error')
      setProblem(p.problem)
    }
  }
  return (
    <form
      className="pop-in well flex flex-col gap-2 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <label className="label" htmlFor="room-code">
        Room code from the host
      </label>
      <div className="flex gap-2">
        <input
          id="room-code"
          ref={ref}
          className="field tabular min-w-0 flex-1 text-center text-[1.6rem] font-bold tracking-[0.35em] uppercase"
          placeholder="KRZBW"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={200}
          value={text}
          aria-invalid={!!problem}
          aria-describedby="room-code-help"
          onChange={(e) => {
            setText(e.target.value)
            setProblem(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              onClose()
            }
          }}
        />
        <Button variant="primary" type="submit" disabled={!playSupported || !text.trim()} title={!playSupported ? PLAY_REQUIREMENT : undefined}>
          Join
        </Button>
      </div>
      <p id="room-code-help" className={`text-[0.92rem] ${problem ? 'text-[#ff9b8a]' : 'text-ash'}`} aria-live="polite">
        {!playSupported ? PLAY_REQUIREMENT : problem ?? 'Five letters. Pasting the invite link works too.'}
      </p>
    </form>
  )
}

export function MainMenu() {
  useEffect(() => { rejoin.restore() }, [])
  useEffect(() => {
    const url = new URL(location.href)
    if (url.searchParams.get('feedback') !== '1') return
    url.searchParams.delete('feedback')
    history.replaceState(history.state, '', url)
    void useFeedback.getState().open()
  }, [])
  const playSupported = usePlaySupported()
  const activeRoom = usePolled(() => session.isActive(), String, 4)
  const guestName = useGame((s) => s.settings.playerName)
  const account = useAccount((s) => s.player)
  const accountError = useAccount((s) => s.error)
  const accountLoaded = useAccount((s) => s.loaded)
  const name = account?.profile?.name ?? guestName
  const gpu = useGame((s) => s.gpu)
  const muted = useGame((s) => s.settings.muted)
  const lobbyStatus = useGame((s) => s.lobby.status)
  const lobbyError = useGame((s) => s.lobby.error)
  const setSettings = useGame((s) => s.setSettings)
  const setLobby = useGame((s) => s.setLobby)
  const toggle = useGame((s) => s.toggle)
  const setScreen = useGame((s) => s.setScreen)
  const [playMode, setPlayMode] = useState<'offline' | 'online' | null>(null)
  const [joinOpen, setJoinOpen] = useState(false)
  const [profileTab, setProfileTab] = useState<'stats' | 'board' | 'replays' | null>(null)
  const [browseOpen, setBrowseOpen] = useState(false)
  const openGames = useOpenGames(online.configured && !browseOpen)
  const [nameOpen, setNameOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [accountMode, setAccountMode] = useState<'onboarding' | 'settings'>('onboarding')
  const [collectionOpen, setCollectionOpen] = useState(false)
  const [emberBalance, setEmberBalance] = useState<number | null>(null)
  const [emberProblem, setEmberProblem] = useState<string | null>(null)
  const [rankedRegion, setRankedRegion] = useState<string | undefined>()
  const [accountProblem, setAccountProblem] = useState<string | undefined>()
  const [accountBusy, setAccountBusy] = useState(false)
  const [draftColor, setDraftColor] = useState(() => getProfile().color)
  const [rating, setRating] = useState<ServerProfile | null>(null)
  const [ratingState, setRatingState] = useState<MenuRatingState>(online.configured ? 'loading' : 'disabled')
  useEffect(() => {
    setEmberBalance(null); setEmberProblem(null)
    if (!accountsEnabled || !account || collectionOpen) return
    let live = true
    void loadProgression().then((state) => { if (live) setEmberBalance(state.balance) }).catch((error: unknown) => {
      if (live) setEmberProblem(error instanceof Error ? error.message : 'Balance unavailable. Open your collection to retry.')
    })
    return () => { live = false }
  }, [account?.id, collectionOpen])
  useEffect(() => {
    if (!online.configured) return
    let alive = true
    setRating(null)
    setRatingState('loading')
    void session.serverProfile().then((profile) => {
      if (alive) { setRating(profile); setRatingState('ready') }
    }).catch(() => {
      if (alive) { setRating(null); setRatingState('error') }
    })
    return () => { alive = false }
  }, [name, account?.id])
  useEffect(() => {
    if (!accountsEnabled) return
    let live = true
    const returned = accountReturn()
    const url = new URL(window.location.href)
    if (url.searchParams.has('account') || url.searchParams.has('accountReturn')) {
      for (const key of ['account', 'accountReturn', 'region', 'error', 'error_description']) url.searchParams.delete(key)
      window.history.replaceState(window.history.state, '', url)
    }
    void refreshAccount().then((player) => {
      if (!live || !returned) return
      const region = returned.intent === 'ranked' && returned.region && (returned.region === 'auto' || online.regions.some((candidate) => candidate.id === returned.region)) ? returned.region : undefined
      if (player?.profile && !returned.problem && !returned.settings) {
        if (region && isPlaySupported()) rankedPlay(region)
        return
      }
      setAccountMode(returned.settings && player?.profile ? 'settings' : 'onboarding')
      setRankedRegion(region)
      setAccountProblem(returned.problem ?? undefined)
      setAccountOpen(true)
    }).catch((error: unknown) => {
      if (live && returned) {
        setAccountMode('onboarding')
        setAccountProblem(error instanceof Error ? error.message : 'Could not check your sign-in. Please try again.')
        setAccountOpen(true)
      }
    }) // Ordinary failures remain visible through the shared account status below.
    return () => { live = false }
  }, [])
  const fullscreen = useFullscreen()
  const navRef = useRef<HTMLElement>(null)
  // menu entries rise in one after another whenever the menu shows
  useEffect(() => {
    staggerIn(navRef.current)
  }, [profileTab, browseOpen])
  const [draft, setDraft] = useState(name)
  useEffect(() => {
    setDraft(name)
  }, [name])

  const commitName = () => { setDraft(chooseName(draft)); setPreferredColor(draftColor); setNameOpen(false) }
  const requestRanked = async (region: string) => {
    if (accountBusy) return
    setAccountBusy(true)
    try {
      const player = await refreshAccount()
      if (player?.profile) rankedPlay(region)
      else { setAccountMode('onboarding'); setAccountProblem(undefined); setRankedRegion(region); setAccountOpen(true) }
    } catch { /* Account status and retry remain visible in the menu. */ }
    finally { setAccountBusy(false) }
  }

  // the session lands here with lobby.error after a failed host / join / disconnect
  const error = lobbyStatus === 'error' ? lobbyError : null
  const hostResult = useLastHostResult()
  const hostAction = lastHostAction()
  const dismissError = () => setLobby({ status: 'idle', error: null })
  const openAccount = () => { setAccountMode(account?.profile ? 'settings' : 'onboarding'); setRankedRegion(undefined); setAccountProblem(undefined); setAccountOpen(true) }

  if (profileTab) return <Profile initialTab={profileTab} initialBoardScope={online.configured ? 'global' : 'device'} onBack={() => setProfileTab(null)} />
  if (browseOpen) return <>
    <BrowseGames onBack={() => setBrowseOpen(false)} onHost={() => setPlayMode('online')} />
    {playSupported && playMode && <PlaySetup onClose={() => setPlayMode(null)} />}
  </>

  return (
    <div className="menu-screen screen-in relative flex h-full flex-col overflow-y-auto">
      <div className="menu-identity z-10">
        <MenuPlayerCard name={name} account={account} accountsEnabled={accountsEnabled} accountLoaded={accountLoaded}
          accountError={accountError} accountBusy={accountBusy} rating={rating} ratingState={ratingState}
          emberBalance={emberBalance} emberProblem={emberProblem}
          onProfile={() => { if (account) openAccount(); else { setDraftColor(getProfile().color); setNameOpen(true) } }}
          onSignIn={openAccount} onLeaderboard={() => setProfileTab('board')} onCollection={() => setCollectionOpen(true)}
          onRetryAccount={() => { setAccountBusy(true); void refreshAccount().catch(() => {}).finally(() => setAccountBusy(false)) }} />
        {online.configured && <LiveGames rooms={openGames} onSeeAll={() => setBrowseOpen(true)} />}
      </div>
      {/* soft dark backdrop behind the menu column; the scene stays visible on the right */}
      <div className="menu-scrim pointer-events-none absolute inset-y-0 left-0" aria-hidden />
      <div className="menu-main relative my-auto flex w-full shrink-0 flex-col">
        <Wordmark />
        {!playSupported && <p data-testid="play-requirement" className="mt-2 rounded border border-gold/30 bg-[#17100c]/95 px-3 py-2 text-sm leading-snug text-[#f3d3a1]">{PLAY_REQUIREMENT}</p>}
        {/* the tagline makes room on short screens (1280x720 with the game-server options) */}
        <p className="menu-tagline hud-text-shadow mt-[min(1rem,2vh)] mb-[min(1.75rem,3vh)] max-w-sm text-[1.18rem] leading-snug font-medium text-[#f7e9d4] [@media(max-height:780px)]:hidden">Knock rival warlocks into the lava. Last one standing takes the round.</p>

        {activeRoom ? <Button variant="primary" className="mt-4 w-full" data-testid="return-active-room" disabled={!playSupported} title={!playSupported ? PLAY_REQUIREMENT : 'Resume your active lobby or match'} onClick={() => { if (isPlaySupported()) session.resume() }}>Return to your game</Button> : <RejoinPrompt />}
        {!activeRoom && account?.game && <Button variant="primary" className="mt-3 w-full" data-testid="rejoin-account-game" disabled={!playSupported} onClick={() => { if (isPlaySupported() && account.game) void session.join(account.game.room, { kind: 'server', region: account.game.region }) }}>Rejoin your ranked game</Button>}

        {error && (
          <div role="alert" className="pop-in mb-5 flex items-start gap-3 rounded-md border border-[rgba(255,90,70,0.4)] bg-[rgba(90,12,10,0.55)] px-4 py-3">
            <div className="flex flex-1 flex-col items-start gap-2">
              {online.configured && hostResult && !hostResult.ok && hostResult.reason !== 'cancelled' ? (
                <>
                  <p className="text-[1rem] leading-snug font-semibold text-[#ffd3c9]">
                    {hostAction === 'quick' ? "Couldn't join casual matchmaking." : hostAction === 'ranked' ? "Couldn't join ranked." : hostResult.mode === 'p2p' ? "Couldn't host from your PC." : "Couldn't host on the game server."}
                  </p>
                  <p className="text-[0.88rem] leading-snug text-[#e9b8ac]">{error}</p>
                </>
              ) : (
                <p className="text-[1rem] leading-snug text-[#ffd3c9]">{error}</p>
              )}
              <HostRetry onDone={dismissError} />
            </div>
            <Button size="sm" variant="ghost" sound="back" onClick={dismissError} aria-label="Dismiss">
              Dismiss
            </Button>
          </div>
        )}

        <nav ref={navRef} className="menu-navigation flex flex-col" aria-label="Main menu">
          {online.configured && <QueueEntries onRanked={(region) => void requestRanked(region)} />}
          <div className={online.configured ? 'menu-pair grid grid-cols-2' : ''}>
            <MenuEntry primary={!online.configured} title="Custom game" sub="Choose rules · solo or with friends" disabled={!playSupported} hint={!playSupported ? PLAY_REQUIREMENT : undefined} onClick={() => { if (isPlaySupported()) setPlayMode('offline') }} testId="play" />
            {online.configured && <BrowseEntry rooms={openGames} onClick={() => setBrowseOpen(true)} />}
          </div>
          <MenuEntry title="Wardrobe" sub="Horns, hats, wings and cape emblems · try anything on" onClick={() => setCollectionOpen(true)} testId="open-wardrobe" />
          <div className="menu-access flex flex-wrap items-center justify-between gap-3">
            <Button variant="ghost" size="sm" className="text-ash" disabled={!playSupported} title={!playSupported ? PLAY_REQUIREMENT : undefined} aria-expanded={joinOpen} onClick={() => { if (isPlaySupported()) setJoinOpen((o) => !o) }}>Join by code</Button>
            <Button className="gap-2 text-[#a5d6ce] hover:text-[#c3f3e5]" size="sm" variant="ghost" onClick={tutorial.open} data-testid="how-to-play"><MenuGlyph kind="guide" size={16} /> How to play</Button>
            <Button className="gap-2 text-[#e8c79a] hover:text-[#ffe3b8]" size="sm" variant="ghost" onClick={() => spellLibrary.open('menu')} data-testid="spell-library"><MenuGlyph kind="spells" size={16} /> Spell library</Button>
          </div>
          {joinOpen && <JoinRow onClose={() => setJoinOpen(false)} />}
        </nav>
      </div>

      {/* build and policies sit quietly in the top-left corner, so the menu column stays short */}
      <div className="menu-meta z-10 flex flex-wrap items-center gap-x-1 gap-y-1 text-xs text-[#b9a48f]">
        {gpu === 'fallback' ? (
          <span className="chip text-[#ffcf9a]" title="No WebGPU in this browser. Brawlock runs on WebGL2 with lighter effects.">
            Limited graphics mode
          </span>
        ) : gpu === 'webgpu' ? (
          <span className="chip">WebGPU</span>
        ) : null}
        <span className="px-1.5"><ReleaseStamp /></span>
        <ReleaseNotesButton quiet />
        <nav className="flex flex-wrap items-center" aria-label="Information and policies">
          <button type="button" className="rounded px-1.5 py-1 hover:text-bone focus-visible:outline-2 focus-visible:outline-gold" onClick={() => setScreen('credits')}>Credits</button>
          <a className="rounded px-1.5 py-1 hover:text-bone focus-visible:outline-2 focus-visible:outline-gold" href={`${import.meta.env.BASE_URL}privacy.html`} target="_blank" rel="noopener noreferrer" aria-label="Privacy Policy (opens in a new tab)">Privacy</a>
          <a className="rounded px-1.5 py-1 hover:text-bone focus-visible:outline-2 focus-visible:outline-gold" href={`${import.meta.env.BASE_URL}terms.html`} target="_blank" rel="noopener noreferrer" aria-label="Terms of Service (opens in a new tab)">Terms</a>
        </nav>
      </div>

      <footer className="menu-footer relative flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm text-[#cdb8a4]">
        <div className="menu-footer-meta flex flex-col gap-3">
          <nav className="menu-utilities flex flex-wrap items-center gap-3" aria-label="Game utilities">
            <FeedbackButton />
            <Button size="sm" className="menu-stats gap-1.5" onClick={() => setProfileTab('stats')} aria-label="Your statistics"><MenuGlyph kind="record" size={16} /><span className="btn-label">Stats</span></Button>
            <Button variant="ghost" size="sm" onClick={() => setProfileTab('replays')} title="Watch saved games or import a shared .brawlock file">Watch replay</Button>
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => toggle('settingsOpen', true)}><MenuGlyph kind="settings" size={16} /> Settings</Button>
          </nav>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            className="flex items-center gap-2 rounded px-2 py-1 text-[#cdb8a4] hover:text-bone focus-visible:outline-2 focus-visible:outline-gold"
            onClick={() => void toggleFullscreen()}
          >
            {fullscreen ? 'Exit fullscreen' : 'Fullscreen'} <Kbd>Alt+Enter</Kbd>
          </button>
          <button
            type="button"
            className="flex items-center gap-2 rounded px-2 py-1 text-[#cdb8a4] hover:text-bone focus-visible:outline-2 focus-visible:outline-gold"
            onClick={() => {
              setSettings({ muted: !muted })
              if (muted) sfx('click')
            }}
          >
            {muted ? 'Sound off' : 'Sound on'} <Kbd>M</Kbd>
          </button>
          </span>
        </div>
      </footer>
      {playSupported && playMode && <PlaySetup onClose={() => setPlayMode(null)} />}
      {accountOpen && <Suspense fallback={null}><Account mode={accountMode} initialProblem={accountProblem} rankedRegion={rankedRegion} onClose={() => { setAccountOpen(false); setRankedRegion(undefined); setAccountProblem(undefined) }} onWardrobe={() => { setAccountOpen(false); setCollectionOpen(true) }} onContinue={() => { if (!rankedRegion || !useAccount.getState().player?.profile || !isPlaySupported()) return; setAccountOpen(false); rankedPlay(rankedRegion); setRankedRegion(undefined); setAccountProblem(undefined) }} /></Suspense>}
      {collectionOpen && <Suspense fallback={null}><Collection onClose={() => setCollectionOpen(false)} onSignIn={accountsEnabled ? () => { setCollectionOpen(false); openAccount() } : undefined} /></Suspense>}
      {nameOpen && <Modal title="Your player" onClose={() => { setDraft(name); setNameOpen(false) }} width="max-w-sm" help={false} footer={<Button variant="primary" onClick={commitName}>Save player</Button>}>
        <label className="flex flex-col gap-2 text-sm text-ash">Display name
          <input autoFocus aria-label="Display name" className="field" maxLength={NAME_MAX} spellCheck={false} value={draft} onFocus={(e) => e.target.select()} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commitName() }} />
        </label>
        <div className="mt-5"><PreferredColorPicker color={draftColor} onChange={setDraftColor} /></div>
      </Modal>}
    </div>
  )
}
