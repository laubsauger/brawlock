import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useGame } from '../../game/store'
import { Wordmark } from '../Brand'
import { Button, Kbd, Modal } from '../widgets'
import { MenuGlyph } from '../icons'
import { hostGame, hostOnServer, joinRoom, lastHostAction, quickPlay, useLastHostResult } from '../flow'
import { BrowseGames } from './BrowseGames'
import { PlaySetup } from './PlaySetup'
import { online, rejoin } from '../../game/session'
import { pickRegion, regionProblem, useRegionChoice, useRegions, type RegionStatus } from '../lib/servers'
import { RegionPing } from '../RegionPing'
import { sfx } from '../lib/sound'
import { chooseName, NAME_MAX } from '../lib/name'
import { staggerIn } from '../lib/motion'
import { toggleFullscreen, useFullscreen } from '../lib/fullscreen'
import { Profile } from './Profile'
import { tutorial } from '../lib/onboarding'

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
}: {
  title: string
  sub: ReactNode
  note?: string
  onClick: () => void
  primary?: boolean
  expanded?: boolean
  disabled?: boolean
  hint?: string
  testId?: string
}) {
  return (
    <Button
      variant={primary ? 'primary' : 'default'}
      className={`menu-item ${primary ? 'py-[1.05rem]' : 'py-[0.6rem]'}`}
      onClick={onClick}
      aria-expanded={expanded}
      disabled={disabled}
      title={hint}
      data-testid={testId}
    >
      <span className="flex flex-col items-start gap-0.5 leading-tight">
        <span className={`btn-label tracking-[0.06em] ${primary ? 'text-[1.4rem]' : 'text-[1.08rem]'}`}>{title}</span>
        <span className={`font-ui font-medium tracking-normal ${primary ? 'text-[0.95rem] text-[#f3c58c]' : 'text-[0.86rem] text-[#a8927c]'}`}>{sub}</span>
        {note && <span className="font-ui text-[0.76rem] font-medium tracking-normal text-[#8f7b67]">{note}</span>}
      </span>
    </Button>
  )
}

/** "US West · 168 ms": the label text a region gets in buttons and messages. */
function regionText(r: RegionStatus): string {
  return r.rttMs != null && r.state === 'up' ? `${r.label} · ${r.rttMs} ms` : r.label
}

/**
 * "Quick play" (server builds): jump into an open game on the game server, or
 * a new one filled with bots. Region, health and ping at a glance; greyed out
 * with the reason when the server cannot take players.
 */
function QuickPlayEntry() {
  const statuses = useRegions(5000)
  const choice = useRegionChoice()
  const region = pickRegion(statuses, choice)
  const problem = regionProblem(region)
  return (
    <MenuEntry
      title="Quick play"
      sub={
        <span className="flex items-center gap-2">
          <span>Jump into a game ·</span>
          {region ? <RegionPing s={region} withName /> : '…'}
        </span>
      }
      disabled={!!problem}
      hint={problem ?? `Join an open game on the game server in ${region?.label}, or start one with bots`}
      onClick={() => region && quickPlay(choice === 'auto' ? 'auto' : region.id)}
      testId="quick-play"
    />
  )
}

/**
 * After a failed host: the other mode in one click ("Host on the game server
 * (US West, 168 ms) instead"), only when that mode can work right now.
 */
function HostRetry({ onDone }: { onDone: () => void }) {
  const result = useLastHostResult()
  // keep the other region's ping fresh while the message is up
  const statuses = useRegions(5000)
  const choice = useRegionChoice()
  if (!result || result.ok || !online.configured || !result.other.available) return null
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
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  const submit = () => {
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
        <Button variant="primary" type="submit" disabled={!text.trim()}>
          Join
        </Button>
      </div>
      <p id="room-code-help" className={`text-[0.92rem] ${problem ? 'text-[#ff9b8a]' : 'text-ash'}`} aria-live="polite">
        {problem ?? 'Five letters. Pasting the invite link works too.'}
      </p>
    </form>
  )
}

function RejoinNotice() {
  const room = useSyncExternalStore(rejoin.subscribe, rejoin.get, () => null)
  if (!room) return null
  const busy = room.status === 'checking' || room.status === 'joining'
  const label = room.status === 'checking' ? 'Checking…' : room.status === 'joining' ? 'Joining…' : room.status === 'unavailable' ? 'Check again' : 'Join'
  return <section className="mt-4 rounded border border-gold/30 bg-[#1c140e]/95 px-3 py-2.5" aria-label="Rejoin your game" data-testid="rejoin-game">
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="font-semibold text-[#ffe0a9]">Rejoin your game</h2>
        <span className="text-xs text-ash">{room.code} · {room.kind === 'server' ? 'Game server' : 'Player hosted'}</span>
      </div>
      <div className="flex gap-1.5">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => { if (room.status === 'available') void rejoin.join(); else void rejoin.refresh() }}>{label}</Button>
        <Button size="sm" variant="ghost" disabled={room.status === 'joining'} onClick={rejoin.dismiss}>Dismiss</Button>
      </div>
    </div>
    <p className="mt-1.5 text-xs leading-snug text-ash">Return to the same room. If a round is underway, you may watch until the next round.</p>
    {room.error && <p className="mt-1 text-xs leading-snug text-[#ffb08a]" role="status">{room.error}</p>}
  </section>
}

export function MainMenu() {
  const name = useGame((s) => s.settings.playerName)
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
  const [nameOpen, setNameOpen] = useState(false)
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

  const commitName = () => { setDraft(chooseName(draft)); setNameOpen(false) }

  // the session lands here with lobby.error after a failed host / join / disconnect
  const error = lobbyStatus === 'error' ? lobbyError : null
  const hostResult = useLastHostResult()
  const hostAction = lastHostAction()
  const dismissError = () => setLobby({ status: 'idle', error: null })

  if (profileTab) return <Profile initialTab={profileTab} initialBoardScope={online.configured ? 'global' : 'device'} onBack={() => setProfileTab(null)} />
  if (browseOpen) return <>
    <BrowseGames onBack={() => setBrowseOpen(false)} onHost={() => setPlayMode('online')} />
    {playMode && <PlaySetup initialOnline={playMode === 'online'} onClose={() => setPlayMode(null)} />}
  </>

  return (
    // bottom padding keeps the centred column clear of the footer row
    <div className="screen-in relative flex h-full flex-col overflow-y-auto px-[max(24px,7vw)] pt-20 pb-24 sm:pt-8">
      <button type="button" data-testid="player-profile" className="menu-profile absolute top-5 right-[max(24px,4vw)] z-10 flex items-center gap-3 rounded border border-[#b58b55]/30 bg-[#140e0b]/80 px-3 py-2 text-bone hover:border-gold/60 focus-visible:outline-2 focus-visible:outline-gold" onClick={() => setNameOpen(true)} aria-label={`Edit player name: ${name}`}>
        <span className="text-[#e6b675]"><MenuGlyph kind="profile" size={21} /></span>
        <span className="max-w-40 truncate font-semibold">{name}</span>
        <span className="text-ash"><MenuGlyph kind="edit" size={13} /></span>
      </button>
      {/* soft dark backdrop behind the menu column; the scene stays visible on the right */}
      <div className="menu-scrim pointer-events-none absolute inset-y-0 left-0" aria-hidden />
      <div className="relative my-auto flex w-full max-w-[460px] flex-col">
        <Wordmark />
        {/* the tagline makes room on short screens (1280x720 with the game-server options) */}
        <p className="hud-text-shadow mt-[min(1rem,2vh)] mb-[min(1.75rem,3vh)] max-w-sm text-[1.18rem] leading-snug font-medium text-[#f7e9d4] [@media(max-height:780px)]:hidden">Knock rival warlocks into the lava. Last one standing takes the round.</p>

        <RejoinNotice />

        {error && (
          <div role="alert" className="pop-in mb-5 flex items-start gap-3 rounded-md border border-[rgba(255,90,70,0.4)] bg-[rgba(90,12,10,0.55)] px-4 py-3">
            <div className="flex flex-1 flex-col items-start gap-2">
              {online.configured && hostResult && !hostResult.ok ? (
                <>
                  <p className="text-[1rem] leading-snug font-semibold text-[#ffd3c9]">
                    {hostAction === 'quick' ? "Couldn't join quick play." : hostResult.mode === 'p2p' ? "Couldn't host from your PC." : "Couldn't host on the game server."}
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

        <nav ref={navRef} className="mt-6 flex flex-col gap-2.5" aria-label="Main menu">
          <MenuEntry primary title="Play" sub="Set up a game · solo or with friends" onClick={() => setPlayMode('offline')} testId="play" />
          {online.configured && <QuickPlayEntry />}
          {online.configured && <MenuEntry title="Browse games" sub="Find a game or host your own" onClick={() => setBrowseOpen(true)} testId="browse-games" />}
          <Button variant="ghost" className="justify-start text-ash" aria-expanded={joinOpen} onClick={() => setJoinOpen((o) => !o)}>Join by code</Button>
          {joinOpen && <JoinRow onClose={() => setJoinOpen(false)} />}
          <Button className="justify-start gap-2 text-[#ffe0a9]" variant="ghost" onClick={tutorial.open} data-testid="how-to-play">
            <MenuGlyph kind="guide" /> How to play <span className="ml-auto font-ui text-sm font-normal text-ash">Four quick lessons</span>
          </Button>
          <div className="mt-1 grid grid-cols-3 gap-2.5">
            <Button variant="ghost" size="sm" className="gap-1 px-1 text-[0.72rem] whitespace-nowrap sm:text-sm" onClick={() => setProfileTab('stats')} aria-label="Your statistics">
              <span className="hidden sm:inline-flex"><MenuGlyph kind="record" size={16} /></span> Stats
            </Button>
            <Button variant="ghost" size="sm" className="px-1 text-[0.72rem] whitespace-nowrap sm:text-sm" onClick={() => setProfileTab('board')} aria-label={online.configured ? 'Global leaderboards' : 'Leaderboard on this device'}>Leaderboards</Button>
            <Button variant="ghost" size="sm" className="px-1 text-[0.72rem] whitespace-nowrap sm:text-sm" onClick={() => setProfileTab('replays')} title="Watch saved games or import a shared .brawlock file">Watch replay</Button>
          </div>
          <div className="flex items-center justify-center gap-4">
            <Button variant="ghost" size="sm" className="gap-1.5 px-2 text-[0.78rem] whitespace-nowrap sm:text-sm" onClick={() => toggle('settingsOpen', true)}>
              <MenuGlyph kind="settings" size={16} /> Settings
            </Button>
            <Button variant="ghost" size="sm" className="gap-1.5 px-2 text-[0.78rem] whitespace-nowrap sm:text-sm" onClick={() => setScreen('credits')}>
              <MenuGlyph kind="credits" size={16} /> Credits
            </Button>
          </div>
        </nav>
      </div>

      <footer className="absolute right-[max(24px,4vw)] bottom-5 left-[max(24px,7vw)] flex flex-wrap items-center justify-between gap-3 text-sm text-[#cdb8a4]">
        <div className="flex items-center gap-3">
          {gpu === 'fallback' ? (
            <span className="chip text-[#ffcf9a]" title="No WebGPU in this browser. Brawlock runs on WebGL2 with lighter effects.">
              Limited graphics mode
            </span>
          ) : gpu === 'webgpu' ? (
            <span className="chip">WebGPU</span>
          ) : null}
          <span>Pre-alpha build</span>
        </div>
        <span className="flex items-center gap-1">
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
      </footer>
      {playMode && <PlaySetup initialOnline={playMode === 'online'} onClose={() => setPlayMode(null)} />}
      {nameOpen && <Modal title="Your name" onClose={() => { setDraft(name); setNameOpen(false) }} width="max-w-sm" footer={<Button variant="primary" onClick={commitName}>Save name</Button>}>
        <label className="flex flex-col gap-2 text-sm text-ash">Display name
          <input autoFocus aria-label="Display name" className="field" maxLength={NAME_MAX} spellCheck={false} value={draft} onFocus={(e) => e.target.select()} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commitName() }} />
        </label>
      </Modal>}
    </div>
  )
}
