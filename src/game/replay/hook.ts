/**
 * Glue between the session's MatchRecorder hooks and the replay library: records the
 * match the local peer steps and saves it at game over under the stats record's id
 * (MatchRecord.id), so results and history rows find it.
 */
import type { MatchSettings, PlayerId, PlayerInput, PlayerSlot, SimEvent, SimState } from '../../sim/types'
import { ReplayRecorder } from './recorder'
import { replays, type ReplayLibrary } from './store'

export interface ReplayHook {
  start(info: { localPlayer: PlayerId; slots: PlayerSlot[]; settings: MatchSettings; seed?: number }): void
  step(before: SimState, inputs: readonly PlayerInput[], patches?: readonly (readonly [PlayerId, boolean])[], slots?: readonly PlayerSlot[]): void
  observe(state: SimState, events: readonly SimEvent[]): void
  /** saves the replay (async) and returns its id, or null when nothing was recorded here */
  finish(id: string | null, winners: readonly PlayerId[]): string | null
  abort(): void
  /** resolves once every save started so far has finished (or failed) */
  flush(): Promise<void>
}

function randomId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `r${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
}

export function createReplayHook(netId: string, lib: ReplayLibrary = replays): ReplayHook {
  const rec = new ReplayRecorder()
  let saving: Promise<void> = Promise.resolve()
  return {
    start: (info) => rec.begin(info),
    step: (before, inputs, patches, slots) => rec.step(before, inputs, patches, slots),
    observe: (state, events) => rec.observe(state, events),
    finish: (id, winners) => {
      const data = rec.finish(id ?? randomId(), netId, winners)
      if (!data) return null
      saving = saving.then(() => lib.save(data)).then(
        () => {},
        (e) => console.warn('[replay] could not save the replay', e),
      )
      return data.id
    },
    abort: () => rec.abort(),
    flush: () => saving,
  }
}
