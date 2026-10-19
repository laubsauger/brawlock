/**
 * Recorded samples: Enter is decoded during the splash; other samples load lazily after
 * the first gesture. All are looked up by asset id. Until a sample has loaded (or when loading fails, or in 'synth'
 * mode) every sound is the procedural synth version, so nothing ever waits on the network.
 */
import { AUDIO_ASSETS, type AssetId } from './assets'

export type SampleFormat = 'ogg' | 'm4a'

/** Opus in Ogg where the browser decodes it, else AAC (Safari). */
export function pickFormat(): SampleFormat {
  try {
    const a = typeof Audio !== 'undefined' ? new Audio() : null
    if (a && a.canPlayType('audio/ogg; codecs="opus"') !== '') return 'ogg'
  } catch {
    /* no media element (tests, workers) */
  }
  return 'm4a'
}

export class SampleBank {
  private readonly buffers = new Map<AssetId, AudioBuffer>()
  private loading: Promise<void> | null = null
  /** called once after every load finished (to add beds to a running ambience) */
  onLoaded: (() => void) | null = null

  get size(): number {
    return this.buffers.size
  }

  get(id: AssetId): AudioBuffer | null {
    return this.buffers.get(id) ?? null
  }

  /** Any of `ids` that has loaded, chosen at random (per-trigger variation). */
  pick(ids: readonly AssetId[]): { id: AssetId; buffer: AudioBuffer } | null {
    const ready = ids.filter((id) => this.buffers.has(id))
    if (ready.length === 0) return null
    const id = ready[Math.floor(Math.random() * ready.length)]
    return { id, buffer: this.buffers.get(id)! }
  }

  private readonly inflight = new Map<AssetId, Promise<void>>()

  /**
   * Fetch and decode just these assets (the sound board loads on demand). Loaded and
   * in-flight ones are not fetched again; failures leave that sound synth-only.
   */
  loadIds(ctx: BaseAudioContext, baseUrl: string, ids: readonly AssetId[], format: SampleFormat = pickFormat()): Promise<void> {
    const one = (id: AssetId): Promise<void> => {
      if (this.buffers.has(id)) return Promise.resolve()
      let p = this.inflight.get(id)
      if (!p) {
        p = (async () => {
          try {
            const res = await fetch(`${baseUrl}audio/${id}.${format}`)
            if (res.ok) this.buffers.set(id, await ctx.decodeAudioData(await res.arrayBuffer()))
          } catch {
            // missing or undecodable: that sound stays synth-only
          }
        })()
        this.inflight.set(id, p)
      }
      return p
    }
    return Promise.all(ids.map(one)).then(() => this.onLoaded?.())
  }

  /** Fetch and decode every asset, a few at a time. Safe to call repeatedly. */
  load(ctx: BaseAudioContext, baseUrl: string, format: SampleFormat = pickFormat()): Promise<void> {
    if (this.loading) return this.loading
    const ids = Object.keys(AUDIO_ASSETS) as AssetId[]
    const one = async (id: AssetId) => {
      try {
        const res = await fetch(`${baseUrl}audio/${id}.${format}`)
        if (!res.ok) return
        const buf = await ctx.decodeAudioData(await res.arrayBuffer())
        this.buffers.set(id, buf)
      } catch {
        // missing or undecodable: that sound stays synth-only
      }
    }
    this.loading = (async () => {
      for (let i = 0; i < ids.length; i += 6) await Promise.all(ids.slice(i, i + 6).map(one))
      this.onLoaded?.()
    })()
    return this.loading
  }
}
