/**
 * Dev-only soundtrack page (driven by scripts/showcase/audio.mjs):
 *   window.__audio.render(['open', 'tip_move', ...]) -> { chunks, dur, cues }
 *   window.__audio.chunk(i) -> base64 slice of the rendered WAV
 */
import { renderSoundtrack } from './audio'

const CHUNK = 4 << 20
let wav: Uint8Array | null = null

function b64(u: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}

;(window as unknown as Record<string, unknown>).__audio = {
  async render(edit: string[], mode: 'synth' | 'hybrid' = 'hybrid', muteSfx = false) {
    const r = await renderSoundtrack({ edit, mode, muteSfx })
    wav = r.wav
    return { chunks: Math.ceil(r.wav.length / CHUNK), dur: r.dur, cues: r.cues, bytes: r.wav.length, musicStarted: r.musicStarted }
  },
  chunk(i: number): string {
    if (!wav) return ''
    return b64(wav.subarray(i * CHUNK, Math.min(wav.length, (i + 1) * CHUNK)))
  },
}
