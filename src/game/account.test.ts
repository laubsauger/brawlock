import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const player = { id: 'Account123', email: 'private@example.com', profile: { name: 'AshFox', color: 0x14e0c8 }, game: { region: 'eu', room: 'ABCDE' } }
let account: typeof import('./account')
let state: typeof import('./accountState')

beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('VITE_ACCOUNTS_ENABLED', 'true')
  account = await import('./account')
  state = await import('./accountState')
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.doUnmock('better-auth/client') })

describe('account identity and regional admission', () => {
  it('publishes a ranked conflict without silently taking control, and sends takeover only on explicit request', async () => {
    const conflict = { kind: 'controller', game: { region: 'eu', room: 'ABCDE' } }
    const control = await import('./rankedControl')
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ error: 'Your game is open elsewhere.', rankedConflict: conflict }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ token: 'A'.repeat(32) }))
    vi.stubGlobal('fetch', fetch)
    await expect(account.getAdmissionToken(true)).rejects.toThrow('Your game is open elsewhere.')
    expect(control.useRankedControl.getState().conflict).toEqual(conflict)
    expect(JSON.parse(fetch.mock.calls[0][1].body).takeover).toBe(false)
    expect(await account.getAdmissionToken(true, true)).toBe('A'.repeat(32))
    expect(JSON.parse(fetch.mock.calls[1][1].body).takeover).toBe(true)
  })
  it('shares concurrent identity reads and clears identity on an expired cookie', async () => {
    let resolve!: (response: Response) => void
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done }))
    vi.stubGlobal('fetch', fetch)
    const a = account.refreshAccount()
    const b = account.refreshAccount()
    expect(a).toBe(b)
    resolve(Response.json(player))
    expect(await a).toEqual(player)
    expect(state.useAccount.getState()).toMatchObject({ player, loaded: true, error: null })
    fetch.mockResolvedValueOnce(new Response(null, { status: 401 }))
    expect(await account.refreshAccount()).toBeNull()
    expect(state.useAccount.getState().player).toBeNull()
  })

  it('does not let an earlier identity read overwrite a newly saved canonical profile', async () => {
    let resolve!: (response: Response) => void
    const saved = { ...player, profile: { name: 'RenamedFox', color: 0x2e7bff } }
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done })).mockResolvedValueOnce(Response.json(saved))
    vi.stubGlobal('fetch', fetch)
    const earlier = account.refreshAccount()
    await account.saveAccountProfile(saved.profile, true)
    resolve(Response.json(player))
    expect(await earlier).toEqual(saved)
    expect(state.useAccount.getState().player).toEqual(saved)
  })

  it('renames through the canonical profile endpoint without changing identity or publishing a rejected name', async () => {
    state.useAccount.setState({ player, loaded: true, error: null })
    const saved = { ...player, profile: { name: 'NewAshFox', color: player.profile.color } }
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(saved)).mockResolvedValueOnce(Response.json({ error: 'That name is already taken.' }, { status: 409 }))
    vi.stubGlobal('fetch', fetch)
    expect(await account.saveAccountProfile(saved.profile, true)).toEqual(saved)
    expect(fetch.mock.calls[0]).toEqual(['/api/account', expect.objectContaining({ method: 'PATCH', credentials: 'same-origin', cache: 'no-store', body: JSON.stringify(saved.profile) })])
    expect(state.useAccount.getState().player).toEqual(saved)
    await expect(account.saveAccountProfile({ name: 'TakenName', color: null }, true)).rejects.toThrow('That name is already taken.')
    expect(state.useAccount.getState().player).toEqual(saved)
    expect(state.useAccount.getState().player?.id).toBe(player.id)
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ name: 'TakenName', color: null })
  })

  it('waits for a pending rename before refreshing and serializes later name changes', async () => {
    state.useAccount.setState({ player, loaded: true, error: null })
    let finish!: (response: Response) => void
    const first = { ...player, profile: { ...player.profile, name: 'FirstName' } }
    const final = { ...player, profile: { ...player.profile, name: 'FinalName' } }
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((done) => { finish = done }))
      .mockResolvedValueOnce(Response.json(final)).mockResolvedValueOnce(Response.json(final))
    vi.stubGlobal('fetch', fetch)
    const a = account.saveAccountProfile(first.profile, true)
    const b = account.saveAccountProfile(final.profile, true)
    const read = account.refreshAccount()
    expect(fetch).toHaveBeenCalledTimes(1)
    finish(Response.json(first))
    await Promise.all([a, b])
    expect(await read).toEqual(final)
    expect(fetch.mock.calls.map(([, init]) => init.method ?? 'GET')).toEqual(['PATCH', 'PATCH', 'GET'])
    expect(state.useAccount.getState().player).toEqual(final)
  })

  it('does not restore an identity when refreshing during pending sign-out', async () => {
    let finish!: (response: { data: { success: true }; error: null }) => void
    vi.doMock('better-auth/client', () => ({ createAuthClient: () => ({ signOut: () => new Promise((done) => { finish = done }) }) }))
    vi.resetModules()
    account = await import('./account')
    state = await import('./accountState')
    state.useAccount.setState({ player, loaded: true, error: null })
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }))
    vi.stubGlobal('fetch', fetch)
    const logout = account.signOutAccount()
    const read = account.refreshAccount()
    expect(fetch).not.toHaveBeenCalled()
    finish({ data: { success: true }, error: null })
    await logout
    expect(await read).toBeNull()
    expect(state.useAccount.getState().player).toBeNull()
  })

  it('saves a color without sending a cached name from another device', async () => {
    const updated = { ...player, profile: { name: 'RenamedElsewhere', color: 0x2e7bff } }
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(updated))
    vi.stubGlobal('fetch', fetch)
    await account.saveAccountColor(0x2e7bff)
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ color: 0x2e7bff })
    expect(state.useAccount.getState().player).toEqual(updated)
  })

  it('retains a successful rename if the next queued rename is rejected', async () => {
    state.useAccount.setState({ player, loaded: true, error: null })
    let finish!: (response: Response) => void
    const saved = { ...player, profile: { ...player.profile, name: 'SavedName' } }
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((done) => { finish = done }))
      .mockResolvedValueOnce(Response.json({ error: 'That name is already taken.' }, { status: 409 }))
    vi.stubGlobal('fetch', fetch)
    const first = account.saveAccountProfile(saved.profile, true)
    const rejected = account.saveAccountProfile({ ...saved.profile, name: 'TakenName' }, true)
    const failure = expect(rejected).rejects.toThrow('already taken')
    finish(Response.json(saved))
    await first
    await failure
    expect(state.useAccount.getState().player).toEqual(saved)
  })

  it('keeps casual available to guests and signed-in players who have not claimed a name', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ ...player, profile: null, game: null }))
    vi.stubGlobal('fetch', fetch)
    expect(await account.getAdmissionToken()).toBeNull()
    expect(await account.getAdmissionToken()).toBeNull()
    expect(fetch.mock.calls.every(([url]) => url === '/api/account')).toBe(true)
  })

  it('mints a separate opaque ticket per action and binds browser/tab identity without persisting tickets', async () => {
    const first = 'A'.repeat(32)
    const second = 'B'.repeat(32)
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ token: first })).mockResolvedValueOnce(Response.json({ token: second }))
    const storage = { setItem: vi.fn(), getItem: vi.fn() }
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('localStorage', storage)
    expect(await account.getAdmissionToken(true)).toBe(first)
    expect(await account.getAdmissionToken(true)).toBe(second)
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toBe('/api/account/admission')
      expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', body: expect.any(String) })
      expect(JSON.parse(init.body)).toEqual({ device: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/), controller: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/), takeover: false })
    }
    expect(JSON.stringify(storage.setItem.mock.calls)).not.toContain(first)
    expect(JSON.stringify(storage.setItem.mock.calls)).not.toContain(second)
    expect(JSON.stringify(state.useAccount.getState())).not.toContain(first)
  })

  it('rejects guests, unclaimed profiles and invalid tickets for required ranked admission', async () => {
    state.useAccount.setState({ player, loaded: true, error: null })
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ error: 'Choose your player name first.' }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ token: 'not-a-ticket' }))
    vi.stubGlobal('fetch', fetch)
    await expect(account.getAdmissionToken(true)).rejects.toThrow('Sign in before joining ranked.')
    expect(state.useAccount.getState().player).toBeNull()
    await expect(account.getAdmissionToken(true)).rejects.toThrow('Choose your player name first.')
    await expect(account.getAdmissionToken(true)).rejects.toThrow('invalid admission ticket')
  })

  it('reports account outages without silently changing an authenticated player into a guest', async () => {
    state.useAccount.setState({ player, loaded: true, error: null })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Account service unavailable.')))
    await expect(account.refreshAccount()).rejects.toThrow('Account service unavailable.')
    expect(state.useAccount.getState()).toMatchObject({ player, loaded: true, error: 'Account service unavailable.' })
  })

  it('preserves explicit ranked region intent in the same-origin OAuth callback', () => {
    const url = new URL(account.accountCallbackURL('https://brawlock.osc.link', '/', 'eu'))
    expect(url.origin).toBe('https://brawlock.osc.link')
    expect(url.searchParams.get('account')).toBe('ranked')
    expect(url.searchParams.get('region')).toBe('eu')
    expect(new URL(account.accountCallbackURL('https://brawlock.osc.link', '/')).searchParams.get('account')).toBe('open')
  })
})
