import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MenuMusic, MENU_SONGS } from './menuMusic'
import { MockAudioContext, MockParam } from './mockContext'
import { MockMedia, mockVisibility } from './mockMedia'

let visibility: ReturnType<typeof mockVisibility>
beforeEach(() => {
  vi.useFakeTimers()
  MockMedia.instances.length = 0
  visibility = mockVisibility()
  vi.stubGlobal('Audio', MockMedia)
  vi.stubGlobal('document', visibility)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

async function prepared(base = '/brawlock/') {
  const queue = new MenuMusic()
  const loading = queue.preload(base)
  const media = MockMedia.instances[0]
  media.readyState = 3
  media.dispatchEvent(new Event('canplay'))
  await loading
  const ctx = new MockAudioContext()
  const activate = (active: boolean) => queue.setActive(active, ctx as unknown as AudioContext, ctx.destination as unknown as AudioNode, base)
  return { queue, media, ctx, activate }
}

describe('streaming menu queue', () => {
  it('requests CORS before streaming CDN music into Web Audio and retains the CDN for the next song', async () => {
    const base = 'https://laubsauger.github.io/brawlock/'
    const { media, activate } = await prepared(base)
    expect(media.corsWhenAssigned).toBe('anonymous')
    expect(media.loaded).toEqual([base + MENU_SONGS[0]])
    activate(true)
    media.dispatchEvent(new Event('ended'))
    expect(media.src).toBe(base + MENU_SONGS[1])
    expect(media.corsWhenAssigned).toBe('anonymous')
    expect(MockMedia.instances).toHaveLength(1)
  })
  it('ships exactly the two supplied MP3 tracks within a separate streaming budget', async () => {
    const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { readdirSync(p: URL): string[]; statSync(p: URL): { size: number } }
    const dir = new URL('../../public/audio/music/', import.meta.url)
    expect(fs.readdirSync(dir).sort()).toEqual(MENU_SONGS.map((path) => path.split('/').at(-1)).sort())
    const sizes = MENU_SONGS.map((path) => fs.statSync(new URL('../../public/' + path, import.meta.url)).size)
    expect(sizes.every((size) => size > 1e6 && size < 3e6)).toBe(true)
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThan(6e6)
  })
  it('preloads exactly one song without playback/context and loads the second only at the end', async () => {
    const { queue, media, ctx, activate } = await prepared()
    expect(media.loaded).toEqual(['/brawlock/' + MENU_SONGS[0]])
    expect(media.plays).toBe(0)
    expect(await queue.preload('/brawlock/')).toBeUndefined()
    activate(true)
    activate(true) // moving between menu screens is continuous
    expect(ctx.nodes.filter((n) => n.kind === 'media')).toHaveLength(1)
    expect(media.plays).toBe(1)
    expect(media.loaded).toHaveLength(1)
    for (const index of [1, 0, 1]) {
      media.ended = true
      media.paused = true
      media.dispatchEvent(new Event('ended'))
      expect(media.src).toBe('/brawlock/' + MENU_SONGS[index])
    }
    expect(MockMedia.instances).toHaveLength(1)
    expect(media.plays).toBe(4)
  })

  it('fades then pauses for a match, preserving the song position for a menu return', async () => {
    const { media, ctx, activate } = await prepared()
    activate(true)
    media.currentTime = 38
    activate(false)
    const gain = (ctx.nodes.find((n) => n.kind === 'gain') as unknown as { gain: MockParam }).gain
    expect(gain.calls.at(-1)).toMatchObject({ fn: 'setTarget', v: 0 })
    vi.advanceTimersByTime(799)
    expect(media.paused).toBe(false)
    vi.advanceTimersByTime(1)
    expect(media.paused).toBe(true)
    activate(true)
    expect(media.currentTime).toBe(38)
    expect(media.paused).toBe(false)
    expect(media.plays).toBe(2)
    expect(gain.calls.at(-1)).toMatchObject({ fn: 'setTarget', v: 0.5 })
    expect(media.loaded).toHaveLength(1)
  })

  it('cancels a pending pause and reverses the fade when quickly returning to a menu', async () => {
    const { media, ctx, activate } = await prepared()
    activate(true)
    activate(false)
    vi.advanceTimersByTime(300)
    activate(true)
    vi.advanceTimersByTime(1000)
    expect(media.paused).toBe(false)
    expect(media.plays).toBe(1)
    const gain = (ctx.nodes.find((n) => n.kind === 'gain') as unknown as { gain: MockParam }).gain
    expect(gain.calls.at(-1)).toMatchObject({ fn: 'setTarget', v: 0.5 })
  })

  it('pauses hidden tabs and resumes only if still in a menu', async () => {
    const { media, activate } = await prepared()
    activate(true)
    visibility.visibilityState = 'hidden'
    visibility.dispatchEvent(new Event('visibilitychange'))
    expect(media.paused).toBe(true)
    activate(false)
    visibility.visibilityState = 'visible'
    visibility.dispatchEvent(new Event('visibilitychange'))
    expect(media.paused).toBe(true)
    activate(true)
    expect(media.paused).toBe(false)
  })

  it('does not fetch the next song if the current one ends during its fade-out', async () => {
    const { media, activate } = await prepared()
    activate(true)
    activate(false)
    media.ended = true
    media.paused = true
    media.dispatchEvent(new Event('ended'))
    expect(media.loaded).toHaveLength(1)
    activate(true)
    expect(media.src).toBe('/brawlock/' + MENU_SONGS[1])
    expect(media.loaded).toHaveLength(2)
  })

  it('reports a failed preload instead of substituting another track', async () => {
    const queue = new MenuMusic()
    const load = queue.preload('/')
    const rejected = expect(load).rejects.toThrow('loading timed out')
    vi.advanceTimersByTime(12000)
    await rejected
    expect(MockMedia.instances[0].loaded).toEqual(['/' + MENU_SONGS[0]])
    expect(MockMedia.instances[0].plays).toBe(0)
  })
})
