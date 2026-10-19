/** One streaming player: preload the first song, load the next only when it is needed. */
export const MENU_SONGS = ['audio/music/circle-of-ash-1.mp3', 'audio/music/circle-of-ash-2.mp3'] as const
const FADE_IN = 1.2
const FADE_OUT = 0.8
/** Mastered songs need less gain than the procedural music on the same bus. */
const SONG_LEVEL = 0.5

export class MenuMusic {
  private media: HTMLAudioElement | null = null
  private source: MediaElementAudioSourceNode | null = null
  private out: GainNode | null = null
  private ctx: AudioContext | null = null
  private base = ''
  private index = 0
  private active = false
  private prepared: Promise<void> | null = null
  private pauseTimer: ReturnType<typeof setTimeout> | null = null

  private player(base: string): HTMLAudioElement {
    if (this.media) return this.media
    this.base = base
    const media = new Audio()
    // Set before src: cross-origin media otherwise becomes silent in Web Audio.
    media.crossOrigin = 'anonymous'
    media.preload = 'auto'
    media.setAttribute('playsinline', '')
    media.src = base + MENU_SONGS[this.index]
    media.addEventListener('ended', () => {
      // During a fade or a hidden tab, leave the completed song for resume().
      if (this.active && !this.hidden) this.next()
    })
    media.addEventListener('error', () => console.warn('Menu music failed to load', media.src, media.error))
    document.addEventListener('visibilitychange', () => {
      if (this.hidden) {
        this.cancelPause()
        this.fade(0, 0)
        media.pause()
      } else if (this.active) this.resume()
    })
    this.media = media
    return media
  }

  /** Called by the splash before any gesture. No AudioContext or playback is created here. */
  preload(base: string): Promise<void> {
    if (this.prepared) return this.prepared
    const media = this.player(base)
    this.prepared = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout)
        media.removeEventListener('canplay', ready)
        media.removeEventListener('error', failed)
      }
      const ready = () => { cleanup(); resolve() }
      const failed = () => { cleanup(); reject(new Error(`Unable to load menu music: ${media.error?.message ?? media.src}`)) }
      const timeout = setTimeout(() => { cleanup(); reject(new Error('Menu music loading timed out')) }, 12000)
      media.addEventListener('canplay', ready)
      media.addEventListener('error', failed)
      if (media.readyState >= 3) ready()
      else media.load()
    })
    return this.prepared
  }

  setActive(active: boolean, ctx: AudioContext, destination: AudioNode, base: string): void {
    if (!active && !this.media) return
    if (active && !this.source) {
      const media = this.player(base)
      this.ctx = ctx
      this.source = ctx.createMediaElementSource(media)
      this.out = ctx.createGain()
      this.out.gain.value = 0
      this.source.connect(this.out)
      this.out.connect(destination)
    }
    if (active === this.active) return
    this.active = active
    this.cancelPause()
    if (active) this.resume()
    else {
      this.fade(0, FADE_OUT)
      this.pauseTimer = setTimeout(() => {
        this.pauseTimer = null
        this.media?.pause()
      }, FADE_OUT * 1000)
    }
  }

  /** Called again on user gestures if the browser initially refused media playback. */
  resume(): void {
    if (!this.active || this.hidden || !this.media) return
    this.cancelPause()
    if (this.media.ended) {
      this.next()
      return
    }
    this.fade(SONG_LEVEL, FADE_IN)
    if (!this.media.paused) return
    void this.media.play().catch((error: unknown) => {
      // pause()/changing src may cancel an in-flight play request.
      if (error instanceof DOMException && error.name === 'AbortError') return
      console.warn('Menu music playback could not start', error)
    })
  }

  private next(): void {
    if (!this.media) return
    this.index = (this.index + 1) % MENU_SONGS.length
    this.media.src = this.base + MENU_SONGS[this.index]
    this.media.load()
    this.resume()
  }

  private get hidden(): boolean {
    return document.visibilityState === 'hidden'
  }

  private cancelPause(): void {
    if (this.pauseTimer !== null) clearTimeout(this.pauseTimer)
    this.pauseTimer = null
  }

  private fade(level: number, seconds: number): void {
    if (!this.out || !this.ctx) return
    const gain = this.out.gain
    const now = this.ctx.currentTime
    gain.cancelScheduledValues(now)
    gain.setValueAtTime(gain.value, now)
    if (seconds === 0) gain.setValueAtTime(level, now)
    else gain.setTargetAtTime(level, now, seconds / 3)
  }
}
