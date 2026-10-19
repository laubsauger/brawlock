import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { resolveAssetBase } from './assetBase'

const cdn = 'https://laubsauger.github.io/brawlock/'
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules() })

describe('independent media origin', () => {
  it('preserves local and Pages installs when a separate asset origin is not configured', () => {
    expect(resolveAssetBase(undefined, '/')).toBe('/')
    expect(resolveAssetBase(undefined, '/brawlock/')).toBe('/brawlock/')
    expect(resolveAssetBase(cdn, '/')).toBe(cdn)
  })

  it('refuses malformed CDN configuration rather than switching download hosts', () => {
    for (const base of ['', '/brawlock/', 'http://cdn.example/game/', 'https://cdn.example/game', 'https://cdn.example/game/?key=secret', 'https://cdn.example/game/#x', 'https://user:password@cdn.example/', 'https://cdn.example/a/../game/']) {
      expect(() => resolveAssetBase(base, '/')).toThrow(/VITE_ASSET_BASE_URL/)
    }
  })

  it('routes previews, painted icons, wordmark and character model to the CDN', async () => {
    vi.stubEnv('VITE_ASSET_BASE_URL', cdn)
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ clips: { fireball: {} } }) }))
    vi.stubGlobal('fetch', fetchMock)
    const media = await import('../ui/lib/abilityMedia')
    await media.loadMediaIndex()
    expect(fetchMock).toHaveBeenCalledWith(`${cdn}media/abilities/index.json`)
    expect(media.posterUrl('fireball')).toBe(`${cdn}media/abilities/fireball.webp`)
    const { Sigil } = await import('../ui/icons')
    const icon = renderToStaticMarkup(createElement(Sigil, { id: 'fireball' }))
    expect(icon).toContain(`${cdn}icons/128/fireball.png`)
    expect(icon).toContain(`${cdn}icons/fireball.png`)
    const { Wordmark } = await import('../ui/Brand')
    expect(renderToStaticMarkup(createElement(Wordmark))).toContain(`${cdn}brand/wordmark.webp`)
    const { WARLOCK_URL } = await import('../render/character/asset')
    expect(WARLOCK_URL).toBe(`${cdn}models/warlock/warlock.glb`)
  })

  it('keeps authenticated account reads on the app origin with a separate asset origin', async () => {
    vi.stubEnv('VITE_ASSET_BASE_URL', cdn)
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 'signed-in-account', profile: null }) }))
    vi.stubGlobal('fetch', fetchMock)
    const { currentAccount } = await import('../game/account')
    await currentAccount()
    expect(fetchMock).toHaveBeenCalledWith('/api/account', { credentials: 'same-origin', cache: 'no-store' })
  })
})
