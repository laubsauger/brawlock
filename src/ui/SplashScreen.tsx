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
import { chooseName, hasChosenName, NAME_MAX } from './lib/name'
import { isTypingTarget } from './lib/keys'
import { forcedMute } from './lib/sound'

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
    if (!url.searchParams.has('room')) return null
    const code = codeFromSearch(url.search)
    // survives a stale-build reload (src/lib/staleBuild.ts)
    if (code) sessionStorage.setItem('brawlock.pendingRoom', code)
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

type Stage = 'gpu' | 'fonts' | 'arena'
const STAGES: { id: Stage; label: string }[] = [
  { id: 'gpu', label: 'Checking graphics' },
  { id: 'fonts', label: 'Loading type' },
  { id: 'arena', label: 'Raising the arena' },
]

export function SplashScreen() {
  const [root] = useState(() => document.getElementById('splash'))
  const [done, setDone] = useState<Record<Stage, boolean>>({ gpu: false, fonts: false, arena: false })
  const [entered, setEntered] = useState(!root)
  const gpu = useGame((s) => s.gpu)
  // first run: ask for a name right here, so the first lobby already shows it
  const [askName] = useState(() => !hasChosenName())
  const [name, setName] = useState(() => useGame.getState().settings.playerName)

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

  const enter = () => {
    if (entered) return
    if (askName) chooseName(name)
    try {
      audio.unlock()
      const s = useGame.getState().settings
      audio.setVolumes({ master: s.masterVolume, sfx: s.sfxVolume, music: s.musicVolume, muted: s.muted || forcedMute })
      audio.ui('ready')
    } catch {
      /* audio is optional */
    }
    setEntered(true)
    const store = useGame.getState()
    if (initialRoom) {
      if (joinRoom(initialRoom)) store.setScreen('menu')
    } else {
      store.setScreen('menu')
    }
  }

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
      if (e.key === ' ' && isTypingTarget(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      enter()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const action = root?.querySelector<HTMLElement>('#splash-action') ?? null
  if (!root || !action || mode !== 'ready') return null

  return createPortal(
    <div className="fade-in flex flex-col items-center gap-3">
      {askName && (
        <label className="flex flex-col items-center gap-1.5">
          <span className="text-[1.05rem] font-semibold text-[#f0d9b8]">What should your rivals call you?</span>
          <input
            className="field w-[260px] text-center text-[1.25rem] font-bold"
            autoFocus
            maxLength={NAME_MAX}
            spellCheck={false}
            autoComplete="nickname"
            value={name}
            onFocus={(e) => e.target.select()}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      )}
      <button type="button" className="btn btn-primary btn-lg min-w-[260px]" autoFocus={!askName} onClick={enter}>
        {initialRoom ? `Join room ${initialRoom}` : 'Enter the arena'}
      </button>
      <span className="text-sm text-ash">or press Enter</span>
      {gpu === 'fallback' && (
        <span className="max-w-md text-[0.95rem] leading-snug text-[#ffcf9a]">
          Limited graphics mode: this browser has no WebGPU, so Brawlock runs on WebGL2 with lighter effects.
        </span>
      )}
    </div>,
    action,
  )
}
