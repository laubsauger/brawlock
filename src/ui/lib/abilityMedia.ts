/**
 * Ability preview clips for the hover card (public/media/abilities/<id>.webm,
 * .mp4 and a .webp poster, all 300x169; index.json lists the ids that have
 * one). Nothing is fetched before the first hover: the index loads on the
 * first card hover, a poster when its card shows, a clip only while its card
 * is open. ONE shared <video> plays at a time, moved from card to card; on
 * hide it is paused and emptied so the decoder is freed. Save-Data: posters only.
 */

import { ASSET_BASE } from '../../lib/assets'

const BASE = `${ASSET_BASE}media/abilities/`

let index: Promise<ReadonlySet<string>> | null = null
let known: ReadonlySet<string> | null = null

/** Ids with a clip, loaded once on first use; an empty set if the index fails. */
export function loadMediaIndex(): Promise<ReadonlySet<string>> {
  index ??= fetch(`${BASE}index.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { clips?: Record<string, unknown> } | null) => (known = new Set(Object.keys(j?.clips ?? {}))))
    .catch(() => (known = new Set<string>()))
  return index
}

/** The index if it has loaded: true / false per id, or undefined while unknown. */
export function hasClip(id: string): boolean | undefined {
  return known ? known.has(id) : undefined
}

export function posterUrl(id: string): string {
  return `${BASE}${id}.webp`
}

/** The browser or the user asked to save data: show posters, never fetch clips. */
export function saveData(): boolean {
  const c = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
  return c?.saveData === true
}

let video: HTMLVideoElement | null = null
let playing: string | null = null

function shared(): HTMLVideoElement {
  if (video) return video
  const v = document.createElement('video')
  v.muted = true
  v.loop = true
  v.playsInline = true
  v.preload = 'none'
  v.setAttribute('muted', '')
  v.setAttribute('playsinline', '')
  v.setAttribute('aria-hidden', 'true')
  v.className = 'ability-clip'
  // shown only once frames are coming, so the poster under it never flashes black
  v.addEventListener('playing', () => (v.dataset.ready = 'true'))
  video = v
  return v
}

/**
 * Play `id`'s clip inside `box` (the card's media slot), moving the one shared
 * <video> there: VP9 WebM first, H.264 MP4 for Safari. `onFail` runs if neither loads.
 */
export function showClip(box: HTMLElement, id: string, onFail: () => void): void {
  if (saveData()) return
  const v = shared()
  if (playing !== id) {
    stopClip()
    const webm = document.createElement('source')
    webm.src = `${BASE}${id}.webm`
    webm.type = 'video/webm'
    const mp4 = document.createElement('source')
    mp4.src = `${BASE}${id}.mp4`
    mp4.type = 'video/mp4'
    // the last source failing means no format worked
    mp4.addEventListener('error', () => {
      if (playing === id) {
        stopClip()
        onFail()
      }
    })
    v.append(webm, mp4)
    playing = id
    v.load()
  }
  if (v.parentElement !== box) box.appendChild(v)
  void v.play().catch(() => {
    /* autoplay refused or interrupted by a hide: the poster stays */
  })
}

/** Card hidden or changed: stop decoding and drop the clip (frees the decoder and the buffer). */
export function stopClip(): void {
  const v = video
  if (!v) return
  v.pause()
  v.replaceChildren()
  v.removeAttribute('src')
  delete v.dataset.ready
  v.load()
  v.remove()
  playing = null
}
