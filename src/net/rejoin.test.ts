import { describe, expect, it, vi } from 'vitest'
import { RejoinController, type RejoinIdentity, type RejoinTarget, type RoomRoute } from './rejoin'

function setup(route: RoomRoute = { kind: 'server', region: 'us-west' }) {
  let identity: RejoinIdentity = { profileId: 'stable-profile', deviceId: 'stable-device' }
  const target: RejoinTarget = { ...identity, code: 'ABCDE', route }
  const exists = vi.fn(async (_target: RejoinTarget) => true)
  const join = vi.fn(async (_target: RejoinTarget) => ({ ok: true, error: undefined as string | undefined }))
  const rejoin = new RejoinController({ identity: () => identity, exists, join })
  rejoin.connected(target)
  return { rejoin, target, exists, join, identity: (next: RejoinIdentity) => { identity = next } }
}

describe('explicit same-game rejoin', () => {
  it('only discovers after disconnect and waits for an explicit click, preserving backend and identity', async () => {
    for (const route of [{ kind: 'p2p' }, { kind: 'server', region: 'us-west' }] as RoomRoute[]) {
      const t = setup(route)
      expect(t.rejoin.get()).toBeNull()
      expect(t.exists).not.toHaveBeenCalled()
      t.rejoin.disconnected()
      expect(t.rejoin.get()?.status).toBe('checking')
      await vi.waitFor(() => expect(t.rejoin.get()?.status).toBe('available'))
      expect(t.join).not.toHaveBeenCalled()
      await t.rejoin.join()
      expect(t.exists).toHaveBeenCalledTimes(2)
      expect(t.join).toHaveBeenCalledExactlyOnceWith(t.target)
      expect(t.rejoin.get()).toBeNull()
    }
  })

  it('never dials when the original room disappeared or cannot be rediscovered', async () => {
    const t = setup()
    await t.rejoin.refresh()
    t.exists.mockResolvedValue(false)
    await t.rejoin.join()
    expect(t.join).not.toHaveBeenCalled()
    expect(t.rejoin.get()?.status).toBe('unavailable')
    t.exists.mockRejectedValue(new Error('Original server is unavailable'))
    await t.rejoin.refresh()
    expect(t.rejoin.get()).toMatchObject({ status: 'unavailable', error: 'Original server is unavailable' })
    expect(t.join).not.toHaveBeenCalled()
  })

  it('cancels stale discovery on dismiss/new game and never resurrects its banner', async () => {
    const t = setup()
    let finish!: (available: boolean) => void
    t.exists.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const checking = t.rejoin.refresh()
    t.rejoin.dismiss()
    finish(true)
    await checking
    expect(t.rejoin.get()).toBeNull()
    t.rejoin.disconnected()
    expect(t.rejoin.get()).toBeNull()
  })

  it('never rejoins under a changed profile/device or treats a display rename as a new identity', async () => {
    const t = setup()
    await t.rejoin.refresh()
    const snapshot = t.rejoin.get()
    expect(t.rejoin.get()).toBe(snapshot)
    // A new display name changes neither of these stored identity keys.
    t.identity({ profileId: t.target.profileId, deviceId: t.target.deviceId })
    await t.rejoin.join()
    expect(t.join).toHaveBeenCalledOnce()
    const changed = setup()
    await changed.rejoin.refresh()
    changed.identity({ profileId: 'another-profile', deviceId: changed.target.deviceId })
    await changed.rejoin.join()
    expect(changed.join).not.toHaveBeenCalled()
    await changed.rejoin.refresh()
    expect(changed.rejoin.get()).toBeNull()
  })

  it('blocks duplicate clicks and clears the banner as soon as the original room welcomes the client', async () => {
    const t = setup()
    await t.rejoin.refresh()
    let finish!: (result: { ok: boolean; error: undefined }) => void
    t.join.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const first = t.rejoin.join()
    await vi.waitFor(() => expect(t.join).toHaveBeenCalledOnce())
    await t.rejoin.join()
    expect(t.join).toHaveBeenCalledOnce()
    t.rejoin.connected(t.target)
    finish({ ok: true, error: undefined })
    await first
    expect(t.rejoin.get()).toBeNull()
  })

  it('surfaces the original room’s refusal and keeps retries explicit', async () => {
    const t = setup()
    await t.rejoin.refresh()
    t.join.mockResolvedValue({ ok: false, error: 'The original host refused this connection.' })
    await t.rejoin.join()
    expect(t.rejoin.get()).toMatchObject({ status: 'available', error: 'The original host refused this connection.' })
    expect(t.join).toHaveBeenCalledOnce()
  })
})
