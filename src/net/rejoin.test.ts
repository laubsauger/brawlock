import { describe, expect, it, vi } from 'vitest'
import { RejoinController, type RejoinIdentity, type RejoinTarget, type RoomRoute } from './rejoin'

function storage() {
  const values = new Map<string, string>()
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
}

function setup(route: RoomRoute = { kind: 'server', region: 'us-west' }, kv = storage()) {
  let identity: RejoinIdentity = { profileId: 'stable-profile', deviceId: 'stable-device' }
  const target: RejoinTarget = { ...identity, code: 'ABCDE', route }
  const exists = vi.fn(async (_target: RejoinTarget) => true)
  const join = vi.fn(async (_target: RejoinTarget) => ({ ok: true, error: undefined as string | undefined }))
  const deps = { identity: () => identity, exists, join, storage: kv }
  const rejoin = new RejoinController(deps)
  rejoin.connected(target)
  return { rejoin, target, exists, join, deps, kv, identity: (next: RejoinIdentity) => { identity = next } }
}

describe('explicit same-game rejoin', () => {
  it.each([{ kind: 'p2p' }, { kind: 'server', region: 'eu' }] as RoomRoute[])('restores a closed tab’s exact $kind room once, then waits for an explicit join', async (route) => {
    const t = setup(route)
    const restored = new RejoinController(t.deps)
    expect(restored.get()).toBeNull()
    expect(t.exists).not.toHaveBeenCalled()
    restored.restore()
    restored.restore()
    await vi.waitFor(() => expect(restored.get()?.status).toBe('available'))
    expect(t.exists).toHaveBeenCalledExactlyOnceWith(t.target)
    expect(t.join).not.toHaveBeenCalled()
    await restored.join()
    expect(t.join).toHaveBeenCalledExactlyOnceWith(t.target)
    expect(restored.get()).toBeNull()
    const saved = JSON.parse([...t.kv.values.values()][0])
    expect(saved).toEqual({ version: 1, target: t.target })
    expect(Object.keys(saved.target).sort()).toEqual(['code', 'deviceId', 'profileId', 'route'])
  })

  it('preserves failed reconnects across another reload and never substitutes another region or backend', async () => {
    const t = setup({ kind: 'server', region: 'eu' })
    const first = new RejoinController(t.deps)
    first.restore()
    await vi.waitFor(() => expect(first.get()?.status).toBe('available'))
    t.join.mockResolvedValueOnce({ ok: false, error: 'Still closing the old connection; retry.' })
    await first.join()
    expect(first.get()).toMatchObject({ status: 'available', error: 'Still closing the old connection; retry.' })
    const second = new RejoinController(t.deps)
    second.restore()
    await vi.waitFor(() => expect(second.get()?.status).toBe('available'))
    await second.join()
    expect(t.join.mock.calls.map(([target]) => target.route)).toEqual([{ kind: 'server', region: 'eu' }, { kind: 'server', region: 'eu' }])
    expect(second.get()).toBeNull()
  })

  it('keeps an ended room explicit, without joining or inventing another destination', async () => {
    const t = setup()
    t.exists.mockResolvedValue(false)
    const restored = new RejoinController(t.deps)
    restored.restore()
    await vi.waitFor(() => expect(restored.get()).toMatchObject({ status: 'unavailable', error: expect.stringContaining('ended') }))
    await restored.join()
    expect(t.join).not.toHaveBeenCalled()
    expect([...t.kv.values.values()][0]).toContain('ABCDE')
  })

  it.each(['profileId', 'deviceId'] as const)('discards remembered rooms belonging to another %s', async (field) => {
    const t = setup()
    t.identity({ ...t.target, [field]: 'different-identity' })
    const restored = new RejoinController(t.deps)
    restored.restore()
    await Promise.resolve()
    expect(restored.get()).toBeNull()
    expect(t.exists).not.toHaveBeenCalled()
    expect(t.join).not.toHaveBeenCalled()
    expect([...t.kv.values.values()][0]).toBe('')
  })

  it('dismisses persisted targets and does not restore them after a later menu mount', () => {
    const t = setup()
    t.rejoin.dismiss()
    const restored = new RejoinController(t.deps)
    restored.restore()
    expect(restored.get()).toBeNull()
    expect(t.exists).not.toHaveBeenCalled()
  })

  it.each(['not json', JSON.stringify({ version: 2, target: {} }), JSON.stringify({ version: 1, target: { code: 'ABCDE', profileId: 'stable-profile', deviceId: 'stable-device', route: { kind: 'server', region: '' } } })])('discards malformed or unsupported remembered data: %s', (raw) => {
    const t = setup()
    const key = [...t.kv.values.keys()][0]
    t.kv.setItem(key, raw)
    const restored = new RejoinController(t.deps)
    restored.restore()
    expect(restored.get()).toBeNull()
    expect(t.exists).not.toHaveBeenCalled()
    expect(t.kv.getItem(key)).toBe('')
  })

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
