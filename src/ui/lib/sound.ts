import { audio, type UiSound } from '../../audio'

/**
 * `?mute` in the URL (dev and prod): the whole session stays silent without
 * changing saved settings, so automated tools and demos always load quietly.
 */
/** `?audio=synth` forces synthesis-only sound for the session (the saved choice is untouched). */
export const forcedSynth = (() => {
  try {
    return new URLSearchParams(window.location.search).get('audio') === 'synth'
  } catch {
    return false
  }
})()

export const forcedMute = (() => {
  try {
    return new URLSearchParams(window.location.search).has('mute')
  } catch {
    return false
  }
})()

/**
 * UI sound helper. Audio is another workstream: never let a failing or
 * missing implementation break a click handler.
 */
export function sfx(sound: UiSound): void {
  try {
    audio.ui(sound)
  } catch {
    /* audio not ready */
  }
}

let lastHover = 0
/** Hover ticks are rate limited so sweeping across a list does not machine-gun. */
export function hoverSfx(): void {
  const now = performance.now()
  if (now - lastHover < 45) return
  lastHover = now
  sfx('hover')
}

export function music(track: 'menu' | 'shop' | 'fight' | 'none'): void {
  try {
    audio.music(track)
  } catch {
    /* audio not ready */
  }
}
