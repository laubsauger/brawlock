import { afterEach, describe, expect, it, vi } from 'vitest'

describe('ability clip index', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
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

  it.each([
    { app: '/brawlock/', media: undefined, expected: '/brawlock/media/abilities/meteor.webp' },
    { app: '/', media: 'https://laubsauger.github.io/brawlock/', expected: 'https://laubsauger.github.io/brawlock/media/abilities/meteor.webp' },
  ])('uses the configured media origin with app base $app', async ({ app, media, expected }) => {
    vi.stubEnv('BASE_URL', app)
    vi.stubEnv('VITE_ASSET_BASE_URL', media)
    const m = await import('./abilityMedia')
    expect(m.posterUrl('meteor')).toBe(expected)
  })
})
