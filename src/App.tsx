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
    // any first gesture may unlock audio; the splash Enter button is the usual one
    const unlock = () => {
      try {
        audio.unlock()
      } catch {
        /* ignore */
      }
      apply()
    }
    window.addEventListener('pointerdown', unlock, { once: true })
    window.addEventListener('keydown', unlock, { once: true })
    return () => {
      unsub()
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
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
