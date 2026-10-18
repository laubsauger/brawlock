import { getCareer } from '../../game/stats'
import { useGame } from '../../game/store'

/** Stable public snapshot; the pending session action stays private. */
export interface TutorialIntent {
  label: string | null
}

interface PlayIntent {
  label: string
  run: () => void
  cancel?: () => void
}

let snapshot: TutorialIntent | null = null
let pending: PlayIntent | null = null
const listeners = new Set<() => void>()

function publish(next: TutorialIntent | null): void {
  snapshot = next
  for (const cb of listeners) cb()
}

function clear(): PlayIntent | null {
  const intent = pending
  pending = null
  publish(null)
  return intent
}

function show(intent: PlayIntent | null): void {
  const previous = pending
  pending = intent
  publish({ label: intent?.label ?? null })
  previous?.cancel?.()
}

/** First-play guide runs before opening a session or requesting a matchmaking seat. */
export const tutorial = {
  get: (): TutorialIntent | null => snapshot,

  subscribe(cb: () => void): () => void {
    listeners.add(cb)
    return () => {
      listeners.delete(cb)
    }
  },

  request(intent: PlayIntent): void {
    if (useGame.getState().settings.tutorialSeen || getCareer() !== null) {
      if (snapshot) clear()?.cancel?.()
      intent.run()
      return
    }
    // Invite links arrive from the splash; cancellation needs a menu to return to.
    if (useGame.getState().screen === 'boot') useGame.getState().setScreen('menu')
    show(intent)
  },

  open(): void {
    show(null)
  },

  continue(): void {
    if (!snapshot) return
    const intent = clear()
    useGame.getState().setSettings({ tutorialSeen: true })
    intent?.run()
  },

  dismiss(): void {
    if (!snapshot) return
    const intent = clear()
    useGame.getState().setSettings({ tutorialSeen: true })
    intent?.cancel?.()
  },
}
