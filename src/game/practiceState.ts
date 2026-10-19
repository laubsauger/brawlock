import { create } from 'zustand'
import type { PracticeView } from './practiceScenario'

/** Ephemeral lesson UI; never account progress, replay state or matchmaking identity. */
export const usePractice = create<{ view: PracticeView | null }>(() => ({ view: null }))
