import { audio } from '../audio'
import { localEquipment } from './wardrobe'
import { startClock } from '../net/clock'
import { TICK_HZ } from '../sim'
import { input } from './input'
import { pushEvents, pushState, resetFrame, frame } from './frame'
import { PracticeScenario } from './practiceScenario'
import { usePractice } from './practiceState'
import { useGame } from './store'

let stop: (() => void) | null = null

export function stopPractice(): void {
  stop?.()
  stop = null
  usePractice.setState({ view: null })
}

/** Reuse the actual match renderer/input/audio, without opening a game session or recording a match. */
export function startPractice(player: { name: string; color: number | null }, canPlay: () => boolean): void {
  stopPractice()
  const lesson = new PracticeScenario({ ...player, cosmetics: localEquipment() })
  const store = useGame.getState()
  for (const key of ['paused', 'shopOpen', 'characterOpen', 'scoreboardOpen'] as const) store.toggle(key, false)
  store.setLobby({ role: 'offline', status: 'open', slots: lesson.state.slots, settings: lesson.state.settings, localPlayer: 0, error: null, notice: null })
  store.setResult(null)
  input.drain()
  resetFrame()
  frame.localPlayer = 0
  pushState(lesson.state)
  usePractice.setState({ view: lesson.view })
  store.setScreen('match')
  let last = performance.now()
  let acc = 0
  const dt = 1000 / TICK_HZ
  const stopClock = startClock((now) => {
    if (!canPlay()) return
    const state = useGame.getState()
    if (state.paused || state.settingsOpen || document.visibilityState === 'hidden') { last = now; acc = 0; input.drain(); return }
    acc += Math.min(100, Math.max(0, now - last))
    last = now
    while (acc >= dt) {
      acc -= dt
      const previous = lesson.view
      lesson.tick(input.drain())
      pushState(lesson.state, now - acc)
      pushEvents(lesson.state.tick, lesson.state.events)
      const pawn = lesson.state.pawns.find((p) => p.owner === 0)!
      audio.playEvents(lesson.state.events, { x: pawn.x, y: pawn.y, halfWidth: 1800, localPlayer: 0, state: lesson.state })
      if (lesson.view !== previous) {
        usePractice.setState({ view: lesson.view })
        state.toggle('shopOpen', lesson.view.step === 'shop')
      }
    }
  })
  const unsubscribe = useGame.subscribe((next) => { if (next.screen !== 'match') stopPractice() })
  stop = () => { stopClock(); unsubscribe(); input.drain(); resetFrame() }
}
