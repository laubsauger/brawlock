import { useGame } from '../game/store'
import { analyticsAvailable } from '../lib/analytics'
import { Button } from './widgets'

export function AnalyticsConsent() {
  const screen = useGame((state) => state.screen)
  const choice = useGame((state) => state.settings.analyticsConsent)
  const settingsOpen = useGame((state) => state.settingsOpen)
  const setSettings = useGame((state) => state.setSettings)
  if (!analyticsAvailable || choice !== null || screen !== 'menu' || settingsOpen) return null
  return <section className="hud-plate pointer-events-auto fixed bottom-20 left-1/2 z-40 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 rounded-lg p-4" aria-label="Optional analytics">
    <p className="font-semibold text-bone">Help improve Brawlock?</p>
    <p className="mt-1 text-sm text-ash">Allow Google Analytics to measure visits, campaigns and tutorial progress. We don’t send your player name, email or chat. You can change this in Settings → Interface.</p>
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <Button size="sm" onClick={() => setSettings({ analyticsConsent: true })}>Allow analytics</Button>
      <Button size="sm" onClick={() => setSettings({ analyticsConsent: false })}>No thanks</Button>
      <a href={`${import.meta.env.BASE_URL}privacy.html`} target="_blank" rel="noopener noreferrer" className="text-xs text-ash underline">Privacy Policy</a>
    </div>
  </section>
}
