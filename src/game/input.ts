/**
 * Input contract: maps keyboard / mouse to InputCommands for the local player.
 * Owned by the UI workstream (keybinds live in settings). The session drains
 * it once per sim tick.
 */
import type { InputCommand } from '../sim/types'

export interface InputApi {
  /** Attach listeners to the game viewport element. Returns a detach function. */
  attach(el: HTMLElement): () => void
  /** Commands issued since the last drain, in order. */
  drain(): InputCommand[]
}

const queue: InputCommand[] = []

export const input: InputApi = {
  attach() {
    return () => {}
  },
  drain() {
    return queue.splice(0, queue.length)
  },
}
