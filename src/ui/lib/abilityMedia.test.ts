import { afterEach, describe, expect, it, vi } from 'vitest'

describe('ability clip index', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('is not fetched until first asked for, then only once, and answers per id', async () => {
    const fetchMock = vi.fn(async (_url: string) => ({ ok: true, json: async () => ({ clips: { fireball: {}, scourge: {} } }) }))
    vi.stubGlobal('fetch', fetchMock)
    const m = await import('./abilityMedia')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(m.hasClip('fireball')).toBeUndefined()
    await Promise.all([m.loadMediaIndex(), m.loadMediaIndex()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/media\/abilities\/index\.json$/)
    expect(m.hasClip('fireball')).toBe(true)
    expect(m.hasClip('duration')).toBe(false)
  })

  it('treats a missing index as "no clips" instead of failing the card', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })))
    const m = await import('./abilityMedia')
    expect((await m.loadMediaIndex()).size).toBe(0)
    expect(m.hasClip('fireball')).toBe(false)
  })

  it('builds asset paths under the app base (Pages serves under /brawlock/)', async () => {
    const m = await import('./abilityMedia')
    expect(m.posterUrl('meteor')).toBe(`${import.meta.env.BASE_URL}media/abilities/meteor.webp`)
  })
})
