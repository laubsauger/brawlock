/**
 * Audio API contract. Owned by the audio workstream; signatures are the contract.
 */
import type { SimEvent } from '../sim/types'

export type UiSound = 'hover' | 'click' | 'back' | 'buy' | 'error' | 'ready' | 'countdown' | 'fight'

export interface Listener {
  /** camera focus in game units */
  x: number
  y: number
  /** visible half-width in game units, for stereo pan and falloff */
  halfWidth: number
}

export interface AudioApi {
  /** Create / resume the AudioContext. Call from a user gesture. Safe to call repeatedly. */
  unlock(): void
  setVolumes(v: { master: number; sfx: number; music: number; muted: boolean }): void
  /** Play SFX for sim events from one tick. */
  playEvents(events: SimEvent[], listener: Listener): void
  ui(sound: UiSound): void
  music(track: 'menu' | 'shop' | 'fight' | 'none'): void
}

export const audio: AudioApi = {
  unlock() {},
  setVolumes() {},
  playEvents() {},
  ui() {},
  music() {},
}
