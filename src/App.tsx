import { useEffect, useRef } from 'react'
import { useGame, type Screen } from './game/store'
import { audio } from './audio'
import { Backdrop } from './ui/Brand'
import { SplashScreen } from './ui/SplashScreen'
import { MainMenu } from './ui/screens/MainMenu'
import { AutoStart, Lobby } from './ui/screens/Lobby'
import { session } from './game/session'
import { Button } from './ui/widgets'
import { usePolled, useTick } from './ui/lib/ticker'
import { Match } from './ui/screens/Match'
import { Results } from './ui/screens/Results'
import { Credits } from './ui/screens/Credits'
import { Replay } from './ui/screens/Replay'
import { SettingsModal } from './ui/SettingsModal'
import { PerfHud } from './ui/PerfHud'
import { MatchLayer } from './ui/MatchLayer'
import { NetGraph } from './ui/NetGraph'
import { startNetMonitor } from './ui/lib/netmonitor'
import { InkFilters } from './ui/InkFilters'
import { Toasts } from './ui/Toasts'
import { undoRemap } from './ui/lib/remap'
import { toggleFullscreen } from './ui/lib/fullscreen'
import { actionForCode, currentBinds, isTypingTarget } from './ui/lib/keys'
import { forcedMute, forcedSynth, music, sfx } from './ui/lib/sound'
import { Tutorial } from './ui/Tutorial'
import { SpellLibrary } from './ui/SpellLibrary'
import { RoomChatLayout } from './ui/hud/Chat'
import { useOnlinePresence } from './ui/lib/presence'
import { RankedControlPrompt } from './ui/screens/RankedControlPrompt'
import { PlayControlPrompt } from './ui/screens/PlayControlPrompt'
import { AnalyticsConsent } from './ui/AnalyticsConsent'
import { ReleaseNotesDialog } from './ui/ReleaseNotes'
import { FeedbackDialog } from './ui/Feedback'

/** One persistent backdrop behind every non-match screen, so swaps never flash to black. */
const BACKDROP: ReadonlySet<Screen> = new Set(['boot', 'unsupported', 'menu', 'lobby', 'results', 'credits'])

/** Keep the audio mixer in step with settings (also covers the M hotkey). */
function useAudioSettings() {
  useEffect(() => {
    let mode = ''
    const apply = () => {
      const s = useGame.getState().settings
      try {
        audio.setVolumes({ master: s.masterVolume, sfx: s.sfxVolume, music: s.musicVolume, ambience: s.ambienceVolume, announcer: s.announcerVolume ?? 0.8, muted: s.muted || forcedMute })
        audio.setAnnouncerVoice(s.announcerVoice ?? 'maverick')
        // sound style: saved choice, unless ?audio=synth forces synthesis for this session
        const want = forcedSynth ? 'synth' : (s.soundStyle ?? 'hybrid')
        if (want !== mode && want !== audio.getMode()) audio.setMode(want)
        mode = want
      } catch {
        /* audio not ready */
      }
    }
    apply()
    const unsub = useGame.subscribe((s, prev) => {
      if (s.settings !== prev.settings) apply()
    })
    // every gesture may (re)unlock: the first one creates the context, later ones resume it
    // if the browser suspended it (tab switch, iOS). The splash Enter button is the usual first one.
    let unlocked = false
    const unlock = () => {
      try {
        audio.unlock()
      } catch {
        /* ignore */
      }
      if (!unlocked) {
        unlocked = true
        apply()
      }
    }
    window.addEventListener('pointerdown', unlock, true)
    window.addEventListener('keydown', unlock, true)
    return () => {
      unsub()
      window.removeEventListener('pointerdown', unlock, true)
      window.removeEventListener('keydown', unlock, true)
    }
  }, [])
}

/**
 * HUD scale = resolution scale (viewport height vs 1080p, clamped 0.85..1.35,
 * as Dota scales its HUD) × the UI scale setting. Published as --ui-scale;
 * HUD clusters and the docks apply it with CSS zoom. The right dock's width
 * (in unscaled px) is capped so it never reaches the screen center, where
 * the camera keeps your warlock.
 */
function useUiScale() {
  useEffect(() => {
    const apply = () => {
      const user = useGame.getState().settings.uiScale ?? 1
      const auto = Math.min(1.35, Math.max(0.85, window.innerHeight / 1080))
      const scale = auto * Math.min(1.2, Math.max(0.8, user))
      const root = document.documentElement.style
      root.setProperty('--ui-scale', scale.toFixed(3))
      // docks are in unscaled px (zoom scales them); neither may reach the screen center
      const half = window.innerWidth / 2
      const dockRight = Math.max(300, Math.min(700, (half - 64) / scale))
      root.setProperty('--dock-right-w', `${Math.round(dockRight)}px`)
      // score strip width (unscaled px) that stays centered and clear of the open right dock: it wraps instead
      const clear = window.innerWidth - 10 - dockRight * scale - half - 12
      root.setProperty('--strip-max-w', `${Math.round(Math.max(300, (2 * clear) / scale))}px`)
      // top HUD row (unscaled px): the full width minus room for the connection readout (left)
      // and the fullscreen icon / kill feed (right), kept symmetric so the clock stays centred
      root.setProperty('--top-row-w', `${Math.round(Math.min(Math.max(480, (window.innerWidth - 2 * 190) / scale), (window.innerWidth - 16) / scale))}px`)
      root.setProperty('--dock-left-w', `${Math.round(Math.max(240, Math.min(330, (half - 120) / scale)))}px`)
    }
    apply()
    window.addEventListener('resize', apply)
    const unsub = useGame.subscribe((s, prev) => {
      if (s.settings.uiScale !== prev.settings.uiScale) apply()
    })
    return () => {
      window.removeEventListener('resize', apply)
      unsub()
    }
  }, [])
}

/** The mute key (M by default) works anywhere, F2 toggles the perf overlay, F3 the net graph. Never while typing. */
function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      // Alt+Enter: fullscreen, the classic game toggle (F11 belongs to the browser)
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.code === 'Enter' || e.code === 'NumpadEnter') && !e.repeat) {
        e.preventDefault()
        void toggleFullscreen()
        return
      }
      // Ctrl/Cmd+Z: undo the last key swap (HUD drag, shop drag, Settings)
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'KeyZ' && !e.repeat) {
        if (undoRemap()) e.preventDefault()
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
      const s = useGame.getState()
      if (actionForCode(currentBinds(), e.code) === 'mute') s.setSettings({ muted: !s.settings.muted })
      else if (e.code === 'F2') {
        e.preventDefault()
        s.setSettings({ showPerf: !s.settings.showPerf })
      } else if (e.code === 'F3') {
        e.preventDefault()
        s.setSettings({ netGraph: !s.settings.netGraph })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/** Lives outside keyed screens so browsing stats never drops queue status or
 * repeats the player-found sound when the lobby mounts again. */
export function ActiveRoomStatus() {
  const screen = useGame((s) => s.screen)
  const lobby = useGame((s) => s.lobby)
  const room = usePolled(() => ({ active: session.isActive(), phase: session.roomPhase() }), (value) => `${value.active}:${value.phase}`, 4)
  const humans = lobby.slots.filter((slot) => slot.kind === 'human').length
  const previous = useRef({ code: '', humans: 0, countdown: false, alerted: false })
  const startingCue = useRef({ code: '', warned: false, second: 0 })
  // One listener outside keyed screens: the same warning reaches players browsing
  // menus, without replaying it when they return to the lobby or reopen a panel.
  useTick((now) => {
    const cue = startingCue.current
    const code = lobby.roomCode ?? ''
    const offlineLobby = lobby.role === 'offline' && (screen === 'lobby' || screen === 'results')
    if (cue.code !== code || (!room.active && !offlineLobby) || (!offlineLobby && room.phase !== 'lobby' && room.phase !== 'results') || lobby.status !== 'open' || lobby.maintenance || !lobby.autoStart) {
      if (cue.warned && !lobby.quick && screen === 'match') sfx('fight')
      Object.assign(cue, { code, warned: false, second: 0 })
      return
    }
    const second = Math.max(0, Math.ceil((lobby.autoStart.at - now) / 1000))
    if (second === 0 || second > 10) return
    if (!cue.warned) { sfx(lobby.quick ? 'ready' : 'countdown'); cue.warned = true }
    else if (second <= 3 && second !== cue.second) sfx('countdown')
    cue.second = second
  })
  useEffect(() => {
    const code = lobby.roomCode ?? ''
    const prior = previous.current
    if (prior.code !== code) Object.assign(prior, { code, humans: 0, countdown: false, alerted: false })
    if (!room.active || !lobby.ranked || room.phase !== 'lobby') {
      if (!room.active || room.phase !== 'lobby') Object.assign(prior, { humans: 0, countdown: false, alerted: false })
      return
    }
    // A transient reconnect can temporarily clear the roster. It must not
    // manufacture another "player found" notification when it returns.
    if (lobby.status !== 'open') return
    const countdown = !!lobby.autoStart
    if (humans < 2) prior.alerted = false
    if (humans >= 2 && !prior.alerted && (prior.humans < 2 || (!prior.countdown && countdown))) {
      sfx('ready')
      prior.alerted = true
    }
    prior.humans = humans
    prior.countdown = countdown
  }, [lobby, humans, room.active, room.phase])
  if (!room.active || (screen !== 'menu' && screen !== 'credits')) return null
  const queue = lobby.ranked ? 'Ranked' : lobby.quick ? 'Casual' : 'Custom'
  return <aside className="relative z-30 flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-gold/30 bg-[#1b120e]/95 px-4 py-2 text-sm shadow-lg sm:px-6" aria-label="Your active game" data-testid="active-room-status">
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1" role="status" aria-live="polite">
      <span className="font-semibold text-gold">{queue}{lobby.roomCode && <span className="ml-2 text-xs text-ash">{lobby.roomCode}</span>}</span>
      <span className="text-ash">{humans} {humans === 1 ? 'player' : 'players'} · {lobby.slots.length} seats</span>
      <span className="text-bone">{lobby.maintenance ? 'Region updating' : lobby.status !== 'open' ? 'Reconnecting…' : room.phase === 'match' ? 'Match in progress' : room.phase === 'results' ? 'Match finished' : lobby.autoStart ? <AutoStart at={lobby.autoStart.at} fill={lobby.autoStart.fill} /> : lobby.ranked && humans < 2 ? 'Waiting for another player' : 'Lobby open'}</span>
    </div>
    <Button size="sm" variant="primary" onClick={() => session.resume()} data-testid="return-active-room-status">{room.phase === 'lobby' ? 'Return to lobby' : room.phase === 'results' ? 'View results' : 'Return to match'}</Button>
  </aside>
}

export default function App() {
  const screen = useGame((s) => s.screen)
  const settingsOpen = useGame((s) => s.settingsOpen)
  useAudioSettings()
  useOnlinePresence()
  useGlobalKeys()
  useUiScale()
  // connection stats at 4 Hz for the HUD indicator, net graph and warnings
  useEffect(() => startNetMonitor(), [])

  // menu music everywhere outside a match; the HUD drives shop / fight music
  useEffect(() => {
    if (screen === 'menu' || screen === 'lobby' || screen === 'credits' || screen === 'results') music('menu')
    else if (screen === 'replay') music('none')
  }, [screen])

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <InkFilters />
      {BACKDROP.has(screen) && <Backdrop />}
      {/* lobby -> match -> results: one match scene instance, warmed hidden in the lobby */}
      <MatchLayer />
      <ActiveRoomStatus />
      <ReleaseNotesDialog />
      <FeedbackDialog />
      {/* sits over the match scene: pass pointer events through (screens and HUD parts opt back in) */}
      <div className="pointer-events-none relative min-h-0 flex-1">
      <RoomChatLayout screen={screen}>
        {/* in a match the screen passes pointer events through to the scene below (HUD parts opt back in) */}
        <main key={screen} className={`room-screen-content ${screen === 'match' ? 'pointer-events-none' : 'pointer-events-auto'}`}>
          {screen === 'menu' && <MainMenu />}
          {screen === 'lobby' && <Lobby />}
          {screen === 'match' && <Match />}
          {screen === 'results' && <Results />}
          {screen === 'credits' && <Credits />}
          {screen === 'replay' && <Replay />}
        </main>
        {settingsOpen && <SettingsModal />}
        <Tutorial />
        <SpellLibrary />
        <RankedControlPrompt />
        <PlayControlPrompt />
        <AnalyticsConsent />
        <SplashScreen />
        <Toasts />
        <PerfHud />
        <NetGraph />
      </RoomChatLayout>
      </div>
    </div>
  )
}
