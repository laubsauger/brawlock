import { useEffect, useRef, useState } from 'react'
import { useGame } from '../../game/store'
import { Wordmark } from '../Brand'
import { Button, Kbd } from '../widgets'
import { hostGame, joinRoom, playOffline } from '../flow'
import { sfx } from '../lib/sound'
import { chooseName, NAME_MAX } from '../lib/name'
import { Profile } from './Profile'

function MenuEntry({ title, sub, onClick, primary, expanded }: { title: string; sub: string; onClick: () => void; primary?: boolean; expanded?: boolean }) {
  return (
    <Button variant={primary ? 'primary' : 'default'} className="menu-item" onClick={onClick} aria-expanded={expanded}>
      <span className="flex flex-col items-start gap-0.5 leading-tight">
        <span className="btn-label text-[1.22rem] tracking-[0.06em]">{title}</span>
        <span className={`font-ui text-[0.9rem] font-medium tracking-normal ${primary ? 'text-[#f3c58c]' : 'text-[#b9a28b]'}`}>{sub}</span>
      </span>
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
  const [draft, setDraft] = useState(name)
  useEffect(() => setDraft(name), [name])

  const commitName = () => setDraft(chooseName(draft))

  // the session lands here with lobby.error after a failed host / join / disconnect
  const error = lobbyStatus === 'error' ? lobbyError : null
  const dismissError = () => setLobby({ status: 'idle', error: null })

  if (profileOpen) return <Profile onBack={() => setProfileOpen(false)} />

  return (
    <div className="screen-in relative flex h-full flex-col justify-center px-[max(24px,7vw)] py-8">
      {/* soft dark backdrop behind the menu column; the scene stays visible on the right */}
      <div className="menu-scrim pointer-events-none absolute inset-y-0 left-0" aria-hidden />
      <div className="relative flex w-full max-w-[460px] flex-col">
        <Wordmark />
        <p className="hud-text-shadow mt-4 mb-7 max-w-sm text-[1.18rem] leading-snug font-medium text-[#f7e9d4]">Knock rival warlocks into the lava. Last one standing takes the round.</p>

        {error && (
          <div role="alert" className="pop-in mb-5 flex items-start gap-3 rounded-md border border-[rgba(255,90,70,0.4)] bg-[rgba(90,12,10,0.55)] px-4 py-3">
            <p className="flex-1 text-[1rem] leading-snug text-[#ffd3c9]">{error}</p>
            <Button size="sm" variant="ghost" sound="back" onClick={dismissError} aria-label="Dismiss">
              Dismiss
            </Button>
          </div>
        )}

        <label className="mb-5 flex flex-col gap-1.5">
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

        <nav className="flex flex-col gap-2.5" aria-label="Main menu">
          <MenuEntry primary title="Play vs bots" sub="Offline practice against the AI" onClick={playOffline} />
          <MenuEntry title="Host online" sub="Get a room code to send a friend" onClick={hostGame} />
          <MenuEntry title="Join game" sub="Type the host's room code" expanded={joinOpen} onClick={() => setJoinOpen((o) => !o)} />
          {joinOpen && <JoinRow onClose={() => setJoinOpen(false)} />}
          <div className="mt-1 grid grid-cols-3 gap-2.5">
            <Button className="px-2 text-[0.86rem] whitespace-nowrap" onClick={() => setProfileOpen(true)}>
              Your record
            </Button>
            <Button className="px-2 text-[0.86rem] whitespace-nowrap" onClick={() => toggle('settingsOpen', true)}>
              Settings
            </Button>
            <Button className="px-2 text-[0.86rem] whitespace-nowrap" onClick={() => setScreen('credits')}>
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
        <button
          type="button"
          className="flex items-center gap-2 rounded px-2 py-1 text-ash hover:text-bone focus-visible:outline-2 focus-visible:outline-gold"
          onClick={() => {
            setSettings({ muted: !muted })
            if (muted) sfx('click')
          }}
        >
          {muted ? 'Sound off' : 'Sound on'} <Kbd>M</Kbd>
        </button>
      </footer>
    </div>
  )
}
