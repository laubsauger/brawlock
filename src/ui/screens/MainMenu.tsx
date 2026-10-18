import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useGame } from '../../game/store'
import { Wordmark } from '../Brand'
import { Button, Kbd } from '../widgets'
import { hostGame, hostOnServer, joinRoom, lastHostAction, playOffline, quickPlay, useLastHostResult } from '../flow'
import { BrowseGames } from './BrowseGames'
import { online } from '../../game/session'
import { pickRegion, regionProblem, useRegionChoice, useRegions, type RegionStatus } from '../lib/servers'
import { RegionPing } from '../RegionPing'
import { sfx } from '../lib/sound'
import { chooseName, NAME_MAX } from '../lib/name'
import { staggerIn } from '../lib/motion'
import { toggleFullscreen, useFullscreen } from '../lib/fullscreen'
import { Profile } from './Profile'

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

/** Tertiary links under the menu (server builds): host a room on the game server, browse open games. */
function ServerLinks({ onBrowse }: { onBrowse: () => void }) {
  const statuses = useRegions(5000)
  const choice = useRegionChoice()
  const setSettings = useGame((s) => s.setSettings)
  const region = pickRegion(statuses, choice)
  const problem = regionProblem(region)
  return (
    <div className="-mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <Button
        variant="ghost"
        size="sm"
        className="host-server px-2"
        disabled={!!problem}
        title={problem ?? `Run a room on the game server in ${region?.label}. Everyone connects to it, so each player's ping depends on how far they are from ${region?.label}.`}
        onClick={() => region && hostOnServer(choice === 'auto' ? 'auto' : region.id)}
        data-testid="host-server"
      >
        Host on game server
      </Button>
      <Button variant="ghost" size="sm" className="px-2" disabled={!!problem} title={problem ?? 'Open games you can join right now'} onClick={onBrowse} data-testid="browse-games">
        Browse games
      </Button>
      {statuses.length > 1 && (
        <select className="field ml-auto w-28 py-1 text-[0.85rem]" aria-label="Game server region" value={choice} onChange={(e) => setSettings({ serverRegion: e.target.value })}>
          <option value="auto">Auto</option>
          {statuses.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
              {r.state === 'up' && r.rttMs != null ? ` (${r.rttMs} ms)` : r.state === 'up' ? '' : ' (offline)'}
            </option>
          ))}
        </select>
      )}
    </div>
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
  useEffect(() => ref.current?.focus(), [])
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
  const [joinOpen, setJoinOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [browseOpen, setBrowseOpen] = useState(false)
  const fullscreen = useFullscreen()
  const navRef = useRef<HTMLElement>(null)
  // menu entries rise in one after another whenever the menu shows
  useEffect(() => staggerIn(navRef.current), [profileOpen, browseOpen])
  const [draft, setDraft] = useState(name)
  useEffect(() => setDraft(name), [name])

  const commitName = () => setDraft(chooseName(draft))

  // the session lands here with lobby.error after a failed host / join / disconnect
  const error = lobbyStatus === 'error' ? lobbyError : null
  const hostResult = useLastHostResult()
  const hostAction = lastHostAction()
  const dismissError = () => setLobby({ status: 'idle', error: null })

  if (profileOpen) return <Profile onBack={() => setProfileOpen(false)} />
  if (browseOpen) return <BrowseGames onBack={() => setBrowseOpen(false)} />

  return (
    // bottom padding keeps the centred column clear of the footer row
    <div className="screen-in relative flex h-full flex-col justify-center px-[max(24px,7vw)] pt-6 pb-14">
      {/* soft dark backdrop behind the menu column; the scene stays visible on the right */}
      <div className="menu-scrim pointer-events-none absolute inset-y-0 left-0" aria-hidden />
      <div className="relative flex w-full max-w-[460px] flex-col">
        <Wordmark />
        {/* the tagline makes room on short screens (1280x720 with the game-server options) */}
        <p className="hud-text-shadow mt-[min(1rem,2vh)] mb-[min(1.75rem,3vh)] max-w-sm text-[1.18rem] leading-snug font-medium text-[#f7e9d4] [@media(max-height:780px)]:hidden">Knock rival warlocks into the lava. Last one standing takes the round.</p>

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

        <label className="mb-[min(1.25rem,2.4vh)] flex flex-col gap-1.5">
          <span className="text-[0.95rem] font-semibold text-[#d9c4ae]">Your name</span>
          <input
            className="field max-w-[300px] text-[1.15rem] font-semibold"
            maxLength={NAME_MAX}
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        </label>

        <nav ref={navRef} className="flex flex-col gap-2.5" aria-label="Main menu">
          <MenuEntry primary title="Play vs bots" sub="Offline practice against the AI" onClick={playOffline} />
          {online.configured && <QuickPlayEntry />}
          <MenuEntry title="Host from your PC" sub="Friends connect straight to you" onClick={hostGame} />
          <MenuEntry title="Join game" sub="Type the host's room code" expanded={joinOpen} onClick={() => setJoinOpen((o) => !o)} />
          {joinOpen && <JoinRow onClose={() => setJoinOpen(false)} />}
          {online.configured && <ServerLinks onBrowse={() => setBrowseOpen(true)} />}
          <div className="mt-1 grid grid-cols-3 gap-2.5">
            <Button variant="ghost" size="sm" className="px-2 whitespace-nowrap" onClick={() => setProfileOpen(true)}>
              Your record
            </Button>
            <Button variant="ghost" size="sm" className="px-2 whitespace-nowrap" onClick={() => toggle('settingsOpen', true)}>
              Settings
            </Button>
            <Button variant="ghost" size="sm" className="px-2 whitespace-nowrap" onClick={() => setScreen('credits')}>
              Credits
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
    </div>
  )
}
