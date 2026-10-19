/**
 * Drives the static splash in index.html (it paints before any script): real
 * loading progress, then an Enter button. Enter (click, Enter or Space
 * anywhere) is the first user gesture, so audio unlocks there. A `?room=CODE`
 * link is read once at startup, scrubbed from the URL, and joined on Enter.
 */
import { useEffect, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { audio } from '../audio'
import { useGame } from '../game/store'
import { codeFromSearch } from '../net/code'
import { joinRoom } from './flow'
import { loadRender } from './renderBridge'
import { chooseName, hasChosenName, NAME_MAX, suggestedName } from './lib/name'
import { getProfile, setPreferredColor } from '../game/profile'
import { PLAYER_COLORS } from '../net/lobbyColors'
import { PreferredColorPicker } from './screens/PlayerColorPicker'
import { isTypingTarget } from './lib/keys'
import { forcedMute } from './lib/sound'
import { clearPendingRoom, rememberPendingRoom } from '../lib/pendingRoom'
import { isPlaySupported, PLAY_REQUIREMENT, usePlaySupported } from './lib/playAccess'
import { accountsEnabled } from '../game/account'
import { accountReturn } from '../game/accountReturn'

/** Matches the fade in index.html. */
const FADE_MS = 700

/**
 * Read at module load: runs once per page load no matter how often React
 * mounts (StrictMode double effects), and scrubs the param right away so a
 * later visit to the lobby never re-joins a stale room.
 */
const initialRoom: string | null = (() => {
  try {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('room')) {
      clearPendingRoom()
      return null
    }
    const code = codeFromSearch(url.search)
    // survives a stale-build reload (src/lib/staleBuild.ts)
    if (code && isPlaySupported()) rememberPendingRoom(code)
    else clearPendingRoom()
    url.searchParams.delete('room')
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
    return code
  } catch {
    return null
  }
})()

let started = false

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))])
}

async function detectWebGPU(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu
  if (!gpu) return false
  try {
    return (await withTimeout(gpu.requestAdapter(), 3000, null)) !== null
  } catch {
    return false
  }
}

type Stage = 'gpu' | 'fonts' | 'arena' | 'music'
const STAGES: { id: Stage; label: string }[] = [
  { id: 'gpu', label: 'Checking graphics' },
  { id: 'fonts', label: 'Loading type' },
  { id: 'arena', label: 'Raising the arena' },
  { id: 'music', label: 'Loading menu music' },
]

export function SplashScreen() {
  const playSupported = usePlaySupported()
  const [root] = useState(() => document.getElementById('splash'))
  const [done, setDone] = useState<Record<Stage, boolean>>({ gpu: false, fonts: false, arena: false, music: false })
  const [entered, setEntered] = useState(!root)
  const [returningAccount] = useState(() => accountsEnabled ? accountReturn() : null)
  // first run: ask for a name right here, so the first lobby already shows it
  const [askName] = useState(() => !returningAccount && !hasChosenName())
  const [name, setName] = useState(() => {
    const current = useGame.getState().settings.playerName
    return askName && current === 'Warlock' ? suggestedName() : current
  })
  const [color, setColor] = useState(() => getProfile().color ?? PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)])

  useEffect(() => {
    if (!playSupported) clearPendingRoom()
  }, [playSupported])

  useEffect(() => {
    if (started) return
    started = true
    const mark = (id: Stage) => setDone((d) => ({ ...d, [id]: true }))
    detectWebGPU().then((ok) => {
      useGame.getState().setGpu(ok ? 'webgpu' : 'fallback')
      mark('gpu')
    })
    withTimeout(document.fonts?.ready ?? Promise.resolve(), 4000, undefined).then(() => mark('fonts'))
    withTimeout(loadRender(), 12000, null).then(() => mark('arena'))
    audio.preloadMenuMusic().catch((error: unknown) => {
      console.warn('Continuing without preloaded menu music', error)
    }).then(() => mark('music'))
    // without the static splash (tests, odd embeds) go straight in
    if (!root) useGame.getState().setScreen('menu')
  }, [root])

  const progress = STAGES.filter((s) => done[s.id]).length / STAGES.length
  const ready = progress >= 1
  const mode = entered ? 'gone' : ready ? 'ready' : 'loading'
  const stage = STAGES.find((s) => !done[s.id])?.label ?? 'Ready'

  useLayoutEffect(() => {
    if (!root) return
    const fill = root.querySelector<HTMLElement>('#splash-fill')
    const st = root.querySelector<HTMLElement>('#splash-stage')
    if (fill) fill.style.transform = `scaleX(${Math.max(0.04, progress)})`
    if (st) st.textContent = stage
    root.dataset.mode = mode
    root.setAttribute('aria-label', mode === 'loading' ? 'Brawlock is loading' : 'Brawlock')
  }, [root, progress, stage, mode])

  const enter = (resumeAccount = false) => {
    if (entered) return
    if (!resumeAccount && askName && isPlaySupported()) {
      chooseName(name)
      setPreferredColor(color)
    }
    if (!resumeAccount) try {
      audio.unlock()
      const s = useGame.getState().settings
      audio.setVolumes({ master: s.masterVolume, sfx: s.sfxVolume, music: s.musicVolume, ambience: s.ambienceVolume, announcer: s.announcerVolume ?? 0.8, muted: s.muted || forcedMute })
      audio.setAnnouncerVoice(s.announcerVoice ?? 'maverick')
      // Start inside the Enter gesture so mobile autoplay rules allow it as the splash fades.
      audio.music('menu')
      audio.ui('ready')
    } catch {
      /* audio is optional */
    }
    setEntered(true)
    const store = useGame.getState()
    if (!resumeAccount && initialRoom && isPlaySupported()) {
      if (joinRoom(initialRoom)) store.setScreen('menu')
    } else {
      clearPendingRoom()
      store.setScreen('menu')
    }
  }

  // A correlated sign-in return resumes the menu after loading. The next real
  // click (setup/save/play) uses App's normal audio unlock; no fake gesture.
  useEffect(() => {
    if (ready && returningAccount && !entered) enter(true)
  }, [ready, returningAccount, entered])

  // fade out, then take the splash out of the way for good
  useEffect(() => {
    if (!root || !entered) return
    root.classList.add('splash-out')
    const t = window.setTimeout(() => (root.hidden = true), FADE_MS)
    return () => window.clearTimeout(t)
  }, [root, entered])

  // Enter / Space work anywhere, captured so nothing behind sees that key
  useEffect(() => {
    if (!root || mode !== 'ready') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      if (e.isComposing || (e.key === ' ' && isTypingTarget(e.target))) return
      if (e.target instanceof HTMLElement && e.target.closest('[aria-label="Preferred player color"]')) return
      e.preventDefault()
      e.stopPropagation()
      enter()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const action = root?.querySelector<HTMLElement>('#splash-action') ?? null
  if (!root || !action) return null
  if (returningAccount) return null
  const controlsNotice = <p data-testid="splash-play-requirement" className={`max-w-[min(340px,calc(100vw-40px))] text-center text-sm leading-snug ${playSupported ? 'text-ash' : 'rounded border border-gold/30 bg-[#17100c]/95 px-3 py-2 text-[#f3d3a1]'}`}>{playSupported ? 'Mouse and keyboard required' : PLAY_REQUIREMENT}</p>
  if (mode !== 'ready') return mode === 'loading' ? createPortal(controlsNotice, action) : null

  return createPortal(
    <div className="fade-in flex flex-col items-center gap-3">
      {controlsNotice}
      {askName && playSupported && <div className="flex w-[min(340px,calc(100vw-40px))] flex-col gap-4 rounded-lg border border-gold/25 bg-[#140e0b]/90 p-4">
        <label className="flex flex-col items-center gap-1.5">
          <span className="text-[1.05rem] font-semibold text-[#f0d9b8]">What should your rivals call you?</span>
          <input
            className="field w-[260px] text-center text-[1.25rem] font-bold"
            aria-label="Your player name"
            autoFocus
            maxLength={NAME_MAX}
            spellCheck={false}
            autoComplete="nickname"
            value={name}
            onFocus={(e) => e.target.select()}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <PreferredColorPicker color={color} onChange={setColor} />
      </div>}
      <button type="button" className="btn btn-primary btn-lg min-w-[260px]" autoFocus={!askName || !playSupported} aria-label={initialRoom && playSupported ? `Press Enter to join room ${initialRoom}` : undefined} onClick={() => enter()}>
        {playSupported ? 'Press Enter' : 'Enter menu'}
      </button>
    </div>,
    action,
  )
}
