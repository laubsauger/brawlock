/**
 * Audio API contract. Owned by the audio workstream; signatures are the contract.
 *
 * Usage:
 * - unlock(): from the first user gesture (any click / keydown), safe to call on every one.
 *   Browsers refuse to start audio before a gesture; everything else is a no-op until then.
 * - setVolumes(): at startup with the persisted settings and whenever they change (ramps, no clicks).
 * - music(track): on screen / phase changes ('menu' in menus and lobby, 'shop' in the shop
 *   phase, 'fight' in a round, 'none' to stop). Shop and battle music are currently disabled;
 *   'shop' and 'fight' keep match ambience and release the previous music. May be called before unlock.
 *   The lava ambience follows it (a distant bed in menus, the full bed in shop and fight);
 *   with `localPlayer` and `state.arena` on the listener, an edge sizzle swells and pans
 *   toward the lava as the local pawn nears the edge.
 * - playEvents(events, listener): once per sim tick's events, deduped by tick (eventsSince).
 *   Pass `localPlayer` and `state` (the tick's SimState) so lava burn, id-only events and
 *   projectile travel loops can be placed; without them those degrade gracefully.
 * - ui(sound): from UI handlers. The FIGHT hit also plays from the 'phase: fight' event;
 *   calling ui('fight') at the same moment plays it once. Cues issued right after unlock(),
 *   while the context is still resuming, are queued, not dropped.
 * - test(): the Settings "Test sound" button.
 * - setMode('synth' | 'hybrid'): dev A/B of recordings vs pure synthesis (also ?audio=synth).
 *
 * Levels (default settings, offline-measured): menu / shop music about -19 LUFS, a busy
 * fight about -15 to -16 LUFS with peaks held near -3.5 dBFS by the master limiter.
 */
import type { PlayerId, SimEvent, SimState } from '../sim/types'
import { AudioEngine } from './engine'
import type { SfxId } from './synth'

export type UiSound = 'hover' | 'click' | 'back' | 'buy' | 'error' | 'ready' | 'countdown' | 'fight'

export interface Listener {
  /** camera focus in game units */
  x: number
  y: number
  /** visible half-width in game units, for stereo pan and falloff */
  halfWidth: number
  /** local player: only their pawn's lava burn is audible */
  localPlayer?: PlayerId
  /**
   * latest state (pass the whole SimState): places events that carry only entity ids
   * (cast, castStart, death), gives projectile travel loops their flight, and lets the
   * announcer call the round (phase, timer, scores, teams, HP)
   */
  state?: Pick<SimState, 'pawns'> &
    Partial<Pick<SimState, 'projectiles' | 'arena' | 'tick' | 'phase' | 'phaseTicksLeft' | 'round' | 'scores' | 'slots' | 'settings'>>
}

export interface AudioApi {
  /** Create / resume the AudioContext. Call from a user gesture. Safe to call repeatedly. */
  unlock(): void
  /** Prepare the first menu song and Enter accent during the splash. Does not start playback. */
  preloadMenuMusic(): Promise<void>
  setVolumes(v: { master: number; sfx: number; music: number; ambience?: number; announcer?: number; muted: boolean }): void
  /** Play SFX for sim events from one tick. */
  playEvents(events: SimEvent[], listener: Listener): void
  ui(sound: UiSound): void
  music(track: 'menu' | 'shop' | 'fight' | 'none'): void
  /**
   * Settings "Test sound" button: unlocks if needed, then plays a short reference (a chime,
   * a Fireball cast, an explosion) through the SFX path at the current volumes.
   */
  test(): void
  /**
   * Dev A/B toggle: 'synth' = procedural only, 'hybrid' = CC0 recordings layered in (the
   * default; they lazy-load after the first gesture, the synth plays until they arrive).
   * `?audio=synth` in the URL starts in synth mode.
   */
  setMode(mode: 'synth' | 'hybrid'): void
  getMode(): 'synth' | 'hybrid'
  /**
   * Announcer voice (Settings > Audio > Announcer voice): 'maverick' (default) or 'arena'.
   * Lines themselves come from sim events (src/game/announcer.ts, shared with the HUD banner).
   */
  setAnnouncerVoice(voice: 'maverick' | 'arena'): void
}

/** Credits for every shipped recording (all CC0; credited as a courtesy). */
export { AUDIO_CREDITS, type AudioCredit } from './assets'

const UI_SFX: Record<UiSound, SfxId> = {
  hover: 'uiHover',
  click: 'uiClick',
  back: 'uiBack',
  buy: 'uiBuy',
  error: 'uiError',
  ready: 'uiReady',
  countdown: 'uiCountdown',
  fight: 'roundStart',
}

const engine = new AudioEngine()
engine.setAnnouncerVoice('maverick')

export const audio: AudioApi = {
  preloadMenuMusic() {
    return engine.preloadMenuMusic()
  },
  unlock() {
    engine.unlock()
  },
  setVolumes(v) {
    engine.setVolumes(v)
  },
  playEvents(events, listener) {
    engine.playEvents(events, listener)
  },
  ui(sound) {
    engine.ui(UI_SFX[sound])
  },
  music(track) {
    engine.music(track)
  },
  test() {
    engine.test()
  },
  setMode(mode) {
    engine.setMode(mode)
  },
  setAnnouncerVoice(voice) {
    engine.setAnnouncerVoice(voice)
  },
  getMode() {
    return engine.mode
  },
}
