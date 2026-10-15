import { useEffect } from 'react'
import { useGame, type Screen } from './game/store'
import { audio } from './audio'
import { Backdrop } from './ui/Brand'
import { SplashScreen } from './ui/SplashScreen'
import { MainMenu } from './ui/screens/MainMenu'
import { Lobby } from './ui/screens/Lobby'
import { Match } from './ui/screens/Match'
import { Results } from './ui/screens/Results'
import { Credits } from './ui/screens/Credits'
import { SettingsModal } from './ui/SettingsModal'
import { PerfHud } from './ui/PerfHud'
import { actionForCode, currentBinds, isTypingTarget } from './ui/lib/keys'
import { music } from './ui/lib/sound'

/** One persistent backdrop behind every non-match screen, so swaps never flash to black. */
const BACKDROP: ReadonlySet<Screen> = new Set(['boot', 'unsupported', 'menu', 'lobby', 'results', 'credits'])

/** Keep the audio mixer in step with settings (also covers the M hotkey). */
function useAudioSettings() {
  useEffect(() => {
    const apply = () => {
      const s = useGame.getState().settings
      try {
        audio.setVolumes({ master: s.masterVolume, sfx: s.sfxVolume, music: s.musicVolume, muted: s.muted })
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
      root.setProperty('--dock-right-w', `${Math.round(Math.max(300, Math.min(700, (half - 64) / scale)))}px`)
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

/** The mute key (M by default) works anywhere, F2 toggles the perf overlay. Never while typing. */
function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
      if (isTypingTarget(e.target)) return
      const s = useGame.getState()
      if (actionForCode(currentBinds(), e.code) === 'mute') s.setSettings({ muted: !s.settings.muted })
      else if (e.code === 'F2') {
        e.preventDefault()
        s.setSettings({ showPerf: !s.settings.showPerf })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

export default function App() {
  const screen = useGame((s) => s.screen)
  const settingsOpen = useGame((s) => s.settingsOpen)
  useAudioSettings()
  useGlobalKeys()
  useUiScale()

  // menu music everywhere outside a match; the HUD drives shop / fight music
  useEffect(() => {
    if (screen === 'menu' || screen === 'lobby' || screen === 'credits' || screen === 'results') music('menu')
  }, [screen])

  return (
    <div className="relative h-full overflow-hidden">
      {BACKDROP.has(screen) && <Backdrop />}
      <main key={screen} className="absolute inset-0">
        {screen === 'menu' && <MainMenu />}
        {screen === 'lobby' && <Lobby />}
        {screen === 'match' && <Match />}
        {screen === 'results' && <Results />}
        {screen === 'credits' && <Credits />}
      </main>
      {settingsOpen && <SettingsModal />}
      <SplashScreen />
      <PerfHud />
    </div>
  )
}
