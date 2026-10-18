/** Gameplay needs a precise pointing device; touch-only devices may use the menu. */
export const PLAY_REQUIREMENT = 'Desktop required · Use a mouse and keyboard to play'

export const PLAY_MEDIA = ['(any-pointer: fine)', '(any-hover: hover)'] as const

export function isPlaySupported(): boolean {
  return typeof globalThis.matchMedia === 'function' && PLAY_MEDIA.every((query) => globalThis.matchMedia(query).matches)
}
